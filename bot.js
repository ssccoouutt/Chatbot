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
        }
    });

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("messages.upsert", async (m) => {
        const msg = m.messages[0];
        if (!msg.message || msg.key.fromMe) return;

        const from = msg.key.remoteJid;
        
        // Get message text - just like in your big bot
        const userMessage = (
            msg.message?.conversation?.trim() ||
            msg.message?.extendedTextMessage?.text?.trim() ||
            msg.message?.imageMessage?.caption?.trim() ||
            msg.message?.videoMessage?.caption?.trim() ||
            ''
        ).toLowerCase();

        // Preserve raw text for captions
        const rawText = msg.message?.conversation?.trim() ||
            msg.message?.extendedTextMessage?.text?.trim() ||
            msg.message?.imageMessage?.caption?.trim() ||
            msg.message?.videoMessage?.caption?.trim() ||
            '';

        if (!userMessage) return;

        log('INFO', `📨 Command from ${from}: ${userMessage}`);

        // ===== CHANNEL COMMAND - EXACTLY LIKE YOUR KNIGHTBOT =====
        if (userMessage.startsWith('.channel')) {
            try {
                // Get the message text after .channel
                const messageText = rawText.slice(9).trim();
                const channelJid = TEST_CHANNEL;

                // Check if this is a reply to media (like in your channel.js)
                const quotedMessage = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
                
                // Send typing indicator
                await sock.sendPresenceUpdate('composing', channelJid);

                let finalMessage = {};

                // If replying to media, handle it
                if (quotedMessage) {
                    log('INFO', '📎 Processing quoted media', { type: Object.keys(quotedMessage)[0] });
                    
                    if (quotedMessage.imageMessage) {
                        // Download image
                        const stream = await downloadContentFromMessage(quotedMessage.imageMessage, 'image');
                        const buffer = [];
                        for await (const chunk of stream) buffer.push(chunk);
                        
                        finalMessage = {
                            image: Buffer.concat(buffer),
                            caption: messageText,
                            mimetype: quotedMessage.imageMessage.mimetype
                        };
                        log('INFO', '📸 Sending quoted image to channel');
                    }
                    else if (quotedMessage.videoMessage) {
                        const stream = await downloadContentFromMessage(quotedMessage.videoMessage, 'video');
                        const buffer = [];
                        for await (const chunk of stream) buffer.push(chunk);
                        
                        finalMessage = {
                            video: Buffer.concat(buffer),
                            caption: messageText,
                            mimetype: quotedMessage.videoMessage.mimetype
                        };
                        log('INFO', '🎥 Sending quoted video to channel');
                    }
                    else if (quotedMessage.audioMessage) {
                        const stream = await downloadContentFromMessage(quotedMessage.audioMessage, 'audio');
                        const buffer = [];
                        for await (const chunk of stream) buffer.push(chunk);
                        
                        finalMessage = {
                            audio: Buffer.concat(buffer),
                            mimetype: quotedMessage.audioMessage.mimetype,
                            ptt: quotedMessage.audioMessage.ptt || false
                        };
                        log('INFO', '🎵 Sending quoted audio to channel');
                    }
                    else if (quotedMessage.documentMessage) {
                        const stream = await downloadContentFromMessage(quotedMessage.documentMessage, 'document');
                        const buffer = [];
                        for await (const chunk of stream) buffer.push(chunk);
                        
                        finalMessage = {
                            document: Buffer.concat(buffer),
                            mimetype: quotedMessage.documentMessage.mimetype,
                            fileName: quotedMessage.documentMessage.fileName || 'document',
                            caption: messageText
                        };
                        log('INFO', '📄 Sending quoted document to channel');
                    }
                    else if (quotedMessage.stickerMessage) {
                        const stream = await downloadContentFromMessage(quotedMessage.stickerMessage, 'sticker');
                        const buffer = [];
                        for await (const chunk of stream) buffer.push(chunk);
                        
                        finalMessage = {
                            sticker: Buffer.concat(buffer),
                            mimetype: quotedMessage.stickerMessage.mimetype
                        };
                        log('INFO', '😊 Sending quoted sticker to channel');
                    }
                }
                // If no quoted media, check if current message has media (like sending image with caption)
                else if (msg.message?.imageMessage || msg.message?.videoMessage || 
                         msg.message?.audioMessage || msg.message?.documentMessage || 
                         msg.message?.stickerMessage) {
                    
                    log('INFO', '📎 Processing direct media message');
                    
                    if (msg.message?.imageMessage) {
                        const stream = await downloadContentFromMessage(msg.message.imageMessage, 'image');
                        const buffer = [];
                        for await (const chunk of stream) buffer.push(chunk);
                        
                        finalMessage = {
                            image: Buffer.concat(buffer),
                            caption: messageText,
                            mimetype: msg.message.imageMessage.mimetype
                        };
                    }
                    else if (msg.message?.videoMessage) {
                        const stream = await downloadContentFromMessage(msg.message.videoMessage, 'video');
                        const buffer = [];
                        for await (const chunk of stream) buffer.push(chunk);
                        
                        finalMessage = {
                            video: Buffer.concat(buffer),
                            caption: messageText,
                            mimetype: msg.message.videoMessage.mimetype
                        };
                    }
                    else if (msg.message?.audioMessage) {
                        const stream = await downloadContentFromMessage(msg.message.audioMessage, 'audio');
                        const buffer = [];
                        for await (const chunk of stream) buffer.push(chunk);
                        
                        finalMessage = {
                            audio: Buffer.concat(buffer),
                            mimetype: msg.message.audioMessage.mimetype,
                            ptt: msg.message.audioMessage.ptt || false
                        };
                    }
                    else if (msg.message?.documentMessage) {
                        const stream = await downloadContentFromMessage(msg.message.documentMessage, 'document');
                        const buffer = [];
                        for await (const chunk of stream) buffer.push(chunk);
                        
                        finalMessage = {
                            document: Buffer.concat(buffer),
                            mimetype: msg.message.documentMessage.mimetype,
                            fileName: msg.message.documentMessage.fileName || 'document',
                            caption: messageText
                        };
                    }
                    else if (msg.message?.stickerMessage) {
                        const stream = await downloadContentFromMessage(msg.message.stickerMessage, 'sticker');
                        const buffer = [];
                        for await (const chunk of stream) buffer.push(chunk);
                        
                        finalMessage = {
                            sticker: Buffer.concat(buffer),
                            mimetype: msg.message.stickerMessage.mimetype
                        };
                    }
                }
                // Text only
                else {
                    finalMessage = { text: messageText };
                    log('INFO', '📝 Sending text to channel');
                }

                // Send to channel
                if (Object.keys(finalMessage).length > 0 && messageText) {
                    await sock.sendMessage(channelJid, finalMessage);
                    
                    // Confirm to user
                    let sentType = 'message';
                    if (quotedMessage) sentType = 'media';
                    else if (msg.message?.imageMessage) sentType = 'image';
                    else if (msg.message?.videoMessage) sentType = 'video';
                    else if (msg.message?.audioMessage) sentType = 'audio';
                    else if (msg.message?.documentMessage) sentType = 'document';
                    else if (msg.message?.stickerMessage) sentType = 'sticker';
                    
                    await sock.sendMessage(from, { 
                        text: `✅ ${sentType} sent to channel successfully!` 
                    });
                } else {
                    await sock.sendMessage(from, { 
                        text: '❌ Please provide a message to send!' 
                    });
                }

            } catch (error) {
                log('ERROR', 'Channel command error', error);
                await sock.sendMessage(from, { 
                    text: '❌ Failed to send to channel: ' + error.message 
                });
            }
        }
    });
}

startBot();
