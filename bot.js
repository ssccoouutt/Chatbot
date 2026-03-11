const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    downloadContentFromMessage,
    jidDecode,
    proto,
    generateWAMessageContent,
    generateWAMessage,
    prepareWAMessageMedia
} = require("@whiskeysockets/baileys");
const pino = require("pino");
const { Boom } = require("@hapi/boom");
const qrcode = require("qrcode-terminal");
const axios = require("axios");
const path = require("path");
const fs = require('fs');
const sharp = require('sharp'); // You'll need to install this

// Create temp directory
const TEMP_DIR = path.join(__dirname, 'temp');
if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR);

// Channel ID to test
const TEST_CHANNEL = "120363405181626845@newsletter";

function log(level, msg, data) {
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] [${level}] ${msg}`);
    if (data) console.log(JSON.stringify(data, null, 2));
}

// Generate thumbnail from image buffer
async function generateThumbnail(buffer) {
    try {
        const thumbnail = await sharp(buffer)
            .resize(100, 100, { fit: 'inside' })
            .jpeg({ quality: 50 })
            .toBuffer();
        return thumbnail.toString('base64');
    } catch (err) {
        log('WARN', 'Thumbnail generation failed', err);
        return null;
    }
}

async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState("session");
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version,
        logger: pino({ level: "silent" }),
        printQRInTerminal: true,
        auth: state,
    });

    sock.ev.on("connection.update", (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (qr) qrcode.generate(qr, { small: true });
        if (connection === "close") {
            const shouldReconnect = (lastDisconnect.error instanceof Boom)?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log("Connection closed, reconnecting:", shouldReconnect);
            if (shouldReconnect) startBot();
        } else if (connection === "open") {
            console.log("\n✅✅✅ BOT CONNECTED SUCCESSFULLY! ✅✅✅");
            console.log(`📢 Channel ID: ${TEST_CHANNEL}`);
            console.log("📱 Send .ping to test the bot\n");
        }
    });

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("messages.upsert", async (m) => {
        console.log("\n📥📥📥 MESSAGE EVENT TRIGGERED! 📥📥📥");
        console.log("Event type:", m.type);
        console.log("Message count:", m.messages?.length);
        
        const msg = m.messages[0];
        if (!msg.message || msg.key.fromMe) {
            console.log("⏭️ Skipping: no message or from self");
            return;
        }

        const from = msg.key.remoteJid;
        
        // Get message text - try all possible sources
        let text = '';
        let rawText = '';
        
        if (msg.message?.conversation) {
            text = msg.message.conversation;
            rawText = text;
            console.log("📝 Conversation text:", text);
        }
        else if (msg.message?.extendedTextMessage?.text) {
            text = msg.message.extendedTextMessage.text;
            rawText = text;
            console.log("📝 Extended text:", text);
        }
        else if (msg.message?.imageMessage?.caption) {
            text = msg.message.imageMessage.caption;
            rawText = text;
            console.log("🖼️ Image caption:", text);
        }
        else if (msg.message?.videoMessage?.caption) {
            text = msg.message.videoMessage.caption;
            rawText = text;
            console.log("🎥 Video caption:", text);
        }
        else {
            console.log("❌ No text found in message");
            console.log("Message keys:", Object.keys(msg.message));
            return;
        }

        const userMessage = text.toLowerCase().trim();
        
        console.log(`\n📨 From: ${from}`);
        console.log(`💬 Message: "${text}"`);
        console.log(`🔍 Command: ${userMessage}`);

        // ===== PING COMMAND - SIMPLE TEST =====
        if (userMessage === '.ping') {
            console.log("🎯 PING COMMAND DETECTED!");
            try {
                await sock.sendMessage(from, { text: 'pong 🏓' });
                console.log("✅ Response sent: pong");
            } catch (err) {
                console.log("❌ Failed to send response:", err.message);
            }
        }
        
        // ===== TEST COMMAND =====
        else if (userMessage === '.test') {
            console.log("🎯 TEST COMMAND DETECTED!");
            try {
                await sock.sendMessage(from, { text: '✅ Bot is working correctly!' });
                console.log("✅ Response sent");
            } catch (err) {
                console.log("❌ Failed:", err.message);
            }
        }
        
        // ===== HELP COMMAND =====
        else if (userMessage === '.help' || userMessage === '.menu') {
            const helpText = `*Available Commands:*\n\n• .ping - Test bot response\n• .test - Check if bot works\n• .help - Show this menu\n• .channel <text> - Send text to channel`;
            await sock.sendMessage(from, { text: helpText });
            console.log("✅ Help sent");
        }
        
        // ===== CHANNEL COMMAND =====
        else if (userMessage.startsWith('.channel')) {
            const messageText = rawText.slice(9).trim();
            const quotedMessage = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
            
            try {
                if (quotedMessage?.imageMessage) {
                    console.log("📸 Processing quoted image");
                    const stream = await downloadContentFromMessage(quotedMessage.imageMessage, 'image');
                    const buffer = [];
                    for await (const chunk of stream) buffer.push(chunk);
                    const imageBuffer = Buffer.concat(buffer);
                    
                    await sock.sendMessage(TEST_CHANNEL, {
                        image: imageBuffer,
                        caption: messageText || 'Sent via bot'
                    });
                    await sock.sendMessage(from, { text: '✅ Image sent to channel!' });
                }
                else if (messageText) {
                    await sock.sendMessage(TEST_CHANNEL, { text: messageText });
                    await sock.sendMessage(from, { text: '✅ Text sent to channel!' });
                }
                else {
                    await sock.sendMessage(from, { text: '❌ Usage: .channel your message' });
                }
            } catch (err) {
                console.log("❌ Channel error:", err.message);
                await sock.sendMessage(from, { text: '❌ Failed: ' + err.message });
            }
        }
        
        // Echo any other command for debugging
        else if (userMessage.startsWith('.')) {
            await sock.sendMessage(from, { text: `📢 Received command: "${text}"` });
            console.log("✅ Echo sent for unknown command");
        }
    });

    // Log all events for debugging
    sock.ev.on("presence.update", (p) => console.log("👤 Presence update"));
    sock.ev.on("messages.reaction", (r) => console.log("🔔 Reaction"));
}

startBot();
