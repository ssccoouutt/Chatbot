const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    downloadContentFromMessage,
    jidDecode,
    proto
} = require("@whiskeysockets/baileys");
const pino = require("pino");
const { Boom } = require("@hapi/boom");
const qrcode = require("qrcode-terminal");
const axios = require("axios");
const path = require("path");
const fs = require('fs');

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
            if (shouldReconnect) startBot();
        } else if (connection === "open") {
            console.log("✅ Bot connected!");
            console.log(`📢 Channel ID: ${TEST_CHANNEL}`);
            console.log("\n📋 Commands (use in ANY chat EXCEPT the channel):");
            console.log("  • .test1 - Send test image directly to channel");
            console.log("  • Reply to an image with .test2");
            console.log("  • .channel text - Send text to channel");
        }
    });

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("messages.upsert", async (m) => {
        const msg = m.messages[0];
        if (!msg.message || msg.key.fromMe) return;

        const from = msg.key.remoteJid;
        
        // ===== IMPORTANT: IGNORE messages FROM the channel itself =====
        if (from === TEST_CHANNEL) {
            // Don't process commands sent IN the channel
            return;
        }
        
        // Get message text
        let text = '';
        if (msg.message.conversation) {
            text = msg.message.conversation;
        } else if (msg.message.extendedTextMessage) {
            text = msg.message.extendedTextMessage.text;
        } else {
            // Not a text message, but could be media with caption
            // Check for image/video with caption
            if (msg.message.imageMessage) {
                text = msg.message.imageMessage.caption || '';
            } else if (msg.message.videoMessage) {
                text = msg.message.videoMessage.caption || '';
            } else if (msg.message.documentMessage) {
                text = msg.message.documentMessage.caption || '';
            }
        }

        if (!text) return;

        log('INFO', `📨 Message from ${from}: ${text}`);

        // ===== TEST 1: Direct image send (no reply) =====
        if (text === '.test1') {
            log('INFO', '📸 TEST 1: Sending direct test image');
            
            // Create a test image (colorful 100x100 PNG)
            const testImage = Buffer.from(
                'iVBORw0KGgoAAAANSUhEUgAAAGQAAABkCAYAAABw4pVUAAAAAXNSR0IArs4c6QAAAARzQklUCAgICHwIZIgAAAAtSURBVHic7cEBDQAAAMKg909tDwcUAAAAAAAAAAAAAAAAAAAAAAAAAAAAAHwavAABU8Iq7QAAAABJRU5ErkJggg==',
                'base64'
            );
            
            try {
                const result = await sock.sendMessage(TEST_CHANNEL, {
                    image: testImage,
                    caption: 'TEST 1: Direct image send'
                });
                
                log('INFO', '✅ TEST 1 result', result);
                await sock.sendMessage(from, { text: '✅ TEST 1: Image sent to channel' });
            } catch (err) {
                log('ERROR', '❌ TEST 1 failed', err);
                await sock.sendMessage(from, { text: '❌ TEST 1 failed: ' + err.message });
            }
        }
        
        // ===== TEST 2: Reply to image =====
        else if (text === '.test2') {
            const quotedMsg = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
            
            if (!quotedMsg?.imageMessage) {
                await sock.sendMessage(from, { text: '❌ Please reply to an image with .test2' });
                return;
            }
            
            log('INFO', '📸 TEST 2: Processing replied image');
            
            try {
                // Download the image
                const stream = await downloadContentFromMessage(quotedMsg.imageMessage, 'image');
                const buffer = [];
                for await (const chunk of stream) buffer.push(chunk);
                const imageBuffer = Buffer.concat(buffer);
                
                log('INFO', 'Image downloaded', { size: imageBuffer.length });
                
                // Send to channel
                const result = await sock.sendMessage(TEST_CHANNEL, {
                    image: imageBuffer,
                    caption: 'TEST 2: Replied image'
                });
                
                log('INFO', '✅ TEST 2 result', result);
                await sock.sendMessage(from, { text: '✅ TEST 2: Replied image sent to channel' });
                
            } catch (err) {
                log('ERROR', '❌ TEST 2 failed', err);
                await sock.sendMessage(from, { text: '❌ TEST 2 failed: ' + err.message });
            }
        }
        
        // ===== Channel text command =====
        else if (text.startsWith('.channel ')) {
            const args = text.slice(9).trim(); // Remove '.channel '
            
            if (!args) {
                await sock.sendMessage(from, { text: '❌ Usage: .channel your message' });
                return;
            }
            
            log('INFO', '📝 Sending text to channel', { text: args });
            
            try {
                const result = await sock.sendMessage(TEST_CHANNEL, { text: args });
                log('INFO', '✅ Text sent', result);
                await sock.sendMessage(from, { text: '✅ Text sent to channel' });
            } catch (err) {
                log('ERROR', '❌ Text send failed', err);
                await sock.sendMessage(from, { text: '❌ Failed: ' + err.message });
            }
        }
    });
}

startBot();
