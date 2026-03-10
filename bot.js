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
            
            // Send test messages when bot connects
            setTimeout(() => testChannel(sock), 5000);
        }
    });

    sock.ev.on("creds.update", saveCreds);

    // Handle commands
    sock.ev.on("messages.upsert", async (m) => {
        const msg = m.messages[0];
        if (!msg.message || msg.key.fromMe) return;

        const from = msg.key.remoteJid;
        const messageType = Object.keys(msg.message)[0];
        const text = messageType === "conversation" ? msg.message.conversation :
                     messageType === "extendedTextMessage" ? msg.message.extendedTextMessage.text : "";

        if (!text) return;

        // Test command: .channel
        if (text.startsWith('.channel')) {
            const args = text.slice(8).trim();
            
            // Check if replying to media
            const quotedMsg = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
            
            if (quotedMsg?.imageMessage) {
                log('INFO', '📸 Testing quoted image to channel');
                
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
                        caption: args || 'Test image from bot'
                    });
                    
                    log('INFO', 'Send result', result);
                    await sock.sendMessage(from, { text: '✅ Test image sent to channel' });
                    
                } catch (err) {
                    log('ERROR', 'Failed', err);
                }
            } else if (text) {
                // Send text only
                const result = await sock.sendMessage(TEST_CHANNEL, { text: args });
                log('INFO', 'Text sent', result);
                await sock.sendMessage(from, { text: '✅ Test text sent to channel' });
            }
        }
        
        // Test command: .test (sends a 1x1 pixel test image)
        else if (text === '.test') {
            // Create a tiny test image (1x1 pixel transparent PNG)
            const tinyImage = Buffer.from(
                'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
                'base64'
            );
            
            try {
                const result = await sock.sendMessage(TEST_CHANNEL, {
                    image: tinyImage,
                    caption: 'Tiny test image'
                });
                log('INFO', 'Test image sent', result);
                await sock.sendMessage(from, { text: '✅ Tiny test image sent to channel' });
            } catch (err) {
                log('ERROR', 'Test failed', err);
            }
        }
    });
}

async function testChannel(sock) {
    log('INFO', 'Running automated channel tests...');
    
    // Test 1: Send simple text
    try {
        const textResult = await sock.sendMessage(TEST_CHANNEL, { text: 'Test 1: Text works ✅' });
        log('INFO', 'Test 1 complete', { success: !!textResult });
    } catch (err) {
        log('ERROR', 'Test 1 failed', err);
    }
    
    // Test 2: Send tiny image
    try {
        const tinyImage = Buffer.from(
            'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
            'base64'
        );
        const imageResult = await sock.sendMessage(TEST_CHANNEL, {
            image: tinyImage,
            caption: 'Test 2: Tiny image'
        });
        log('INFO', 'Test 2 complete', { success: !!imageResult });
    } catch (err) {
        log('ERROR', 'Test 2 failed', err);
    }
    
    log('INFO', 'Tests completed. Check your channel!');
}

startBot();
