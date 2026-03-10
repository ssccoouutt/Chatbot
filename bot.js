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
        
        // Get message text
        const userMessage = (
            msg.message?.conversation?.trim() ||
            msg.message?.extendedTextMessage?.text?.trim() ||
            msg.message?.imageMessage?.caption?.trim() ||
            msg.message?.videoMessage?.caption?.trim() ||
            ''
        ).toLowerCase();

        const rawText = msg.message?.conversation?.trim() ||
            msg.message?.extendedTextMessage?.text?.trim() ||
            msg.message?.imageMessage?.caption?.trim() ||
            msg.message?.videoMessage?.caption?.trim() ||
            '';

        if (!userMessage) return;

        log('INFO', `📨 Command from ${from}: ${userMessage}`);

        // ===== CHANNEL COMMAND =====
        if (userMessage.startsWith('.channel')) {
            try {
                const messageText = rawText.slice(9).trim();
                const channelJid = TEST_CHANNEL;
                const quotedMessage = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
                
                await sock.sendPresenceUpdate('composing', channelJid);

                let finalMessage = {};

                // Channel context info
                const channelContext = {
                    contextInfo: {
                        forwardingScore: 1,
                        isForwarded: false,
                        forwardedNewsletterMessageInfo: {
                            newsletterJid: channelJid,
                            newsletterName: 'Tech Zone',
                            serverMessageId: -1
                        }
                    }
                };

                // Handle quoted media
                if (quotedMessage) {
                    log('INFO', '📎 Processing quoted media', { type: Object.keys(quotedMessage)[0] });
                    
                    if (quotedMessage.imageMessage) {
                        const stream = await downloadContentFromMessage(quotedMessage.imageMessage, 'image');
                        const buffer = [];
                        for await (const chunk of stream) buffer.push(chunk);
                        const imageBuffer = Buffer.concat(buffer);
                        
                        // Generate thumbnail
                        const thumbnail = await generateThumbnail(imageBuffer);
                        
                        finalMessage = {
                            image: imageBuffer,
                            caption: messageText,
                            mimetype: quotedMessage.imageMessage.mimetype,
                            jpegThumbnail: thumbnail, // CRITICAL for channel preview
                            ...channelContext
                        };
                        log('INFO', '📸 Sending quoted image with thumbnail');
                    }
                    // ... other media types (video, audio, document, sticker) ...
                }
                // Handle direct media
                else if (msg.message?.imageMessage) {
                    const stream = await downloadContentFromMessage(msg.message.imageMessage, 'image');
                    const buffer = [];
                    for await (const chunk of stream) buffer.push(chunk);
                    const imageBuffer = Buffer.concat(buffer);
                    
                    // Generate thumbnail
                    const thumbnail = await generateThumbnail(imageBuffer);
                    
                    finalMessage = {
                        image: imageBuffer,
                        caption: messageText,
                        mimetype: msg.message.imageMessage.mimetype,
                        jpegThumbnail: thumbnail, // CRITICAL for channel preview
                        ...channelContext
                    };
                    log('INFO', '📸 Sending direct image with thumbnail');
                }
                // Handle text only
                else if (messageText) {
                    finalMessage = { text: messageText };
                    log('INFO', '📝 Sending text to channel');
                }

                // Send to channel
                if (Object.keys(finalMessage).length > 0) {
                    await sock.sendMessage(channelJid, finalMessage);
                    
                    let sentType = 'message';
                    if (quotedMessage) sentType = 'media';
                    else if (msg.message?.imageMessage) sentType = 'image';
                    
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
