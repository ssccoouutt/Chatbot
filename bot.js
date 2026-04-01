const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion
} = require("@whiskeysockets/baileys");
const pino = require("pino");
const { Boom } = require("@hapi/boom");
const qrcode = require("qrcode-terminal");
const path = require("path");
const fs = require('fs');

// Import utilities
const forwarder = require('./Utility/forwarder');
const autoreply = require('./Utility/autoreply');

// ===== CONSTANTS =====
const TEMP_DIR = path.join(process.cwd(), 'temp');

// ===== STATE =====
let whatsappSock = null;

// Create temp directory
if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });

// ===== WHATSAPP BOT =====
async function startBot() {
    console.log(`[DEBUG] Starting WhatsApp bot...`);
    
    const { state, saveCreds } = await useMultiFileAuthState("session");
    const { version } = await fetchLatestBaileysVersion();
    
    const sock = makeWASocket({
        version,
        logger: pino({ level: "silent" }),
        auth: state,
    });

    whatsappSock = sock;
    forwarder.init(whatsappSock, null);

    sock.ev.on("connection.update", (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (qr) {
            console.log(`[DEBUG] QR Code received`);
            qrcode.generate(qr, { small: true });
        }
        if (connection === "close") {
            const shouldReconnect = (lastDisconnect.error instanceof Boom)?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log(`Connection closed, reconnecting: ${shouldReconnect}`);
            if (shouldReconnect) startBot();
        } else if (connection === "open") {
            console.log("\n✅✅✅ WHATSAPP BOT CONNECTED! ✅✅✅");
            console.log(`📱 WhatsApp Number: ${whatsappSock.user?.id?.split(':')[0] || 'Unknown'}`);
            console.log(`⏰ Random delay: ${forwarder.MIN_DELAY_HOURS}-${forwarder.MAX_DELAY_HOURS} hours`);
            console.log(`🌙 Night pause: 22:00 - 4:00 PKT`);
            console.log(`🕐 Current PKT: ${forwarder.formatPakistanTime()}\n`);
            console.log(`🤖 Waiting for messages... Send "Are-You-There" to test auto-reply\n`);
            
            // Start Telegram bot and scheduler
            forwarder.start();
        }
    });

    sock.ev.on("creds.update", saveCreds);

    // Debug: Log all incoming messages
    sock.ev.on("messages.upsert", async (m) => {
        console.log(`\n[DEBUG] ========== MESSAGE RECEIVED ==========`);
        console.log(`[DEBUG] Messages count: ${m.messages?.length}`);
        console.log(`[DEBUG] Type: ${m.type}`);
        
        const msg = m.messages[0];
        if (!msg) {
            console.log(`[DEBUG] No message object`);
            return;
        }
        
        console.log(`[DEBUG] From: ${msg.key?.remoteJid}`);
        console.log(`[DEBUG] Is from me: ${msg.key?.fromMe}`);
        
        if (msg.message) {
            console.log(`[DEBUG] Message keys: ${Object.keys(msg.message).join(', ')}`);
            
            // Try to extract text
            let text = '';
            if (msg.message?.conversation) {
                text = msg.message.conversation;
                console.log(`[DEBUG] Conversation text: ${text}`);
            } else if (msg.message?.extendedTextMessage?.text) {
                text = msg.message.extendedTextMessage.text;
                console.log(`[DEBUG] Extended text: ${text}`);
            } else if (msg.message?.imageMessage?.caption) {
                text = msg.message.imageMessage.caption;
                console.log(`[DEBUG] Image caption: ${text}`);
            } else if (msg.message?.videoMessage?.caption) {
                text = msg.message.videoMessage.caption;
                console.log(`[DEBUG] Video caption: ${text}`);
            } else {
                console.log(`[DEBUG] No text found in message`);
                console.log(`[DEBUG] Message type: ${JSON.stringify(msg.message, null, 2).substring(0, 200)}`);
            }
            
            if (text) {
                console.log(`[DEBUG] Processing message: "${text}"`);
                
                // Check for auto-reply
                const shouldReply = autoreply.shouldReply(text);
                console.log(`[DEBUG] Should auto-reply: ${shouldReply}`);
                
                if (shouldReply) {
                    console.log(`[AUTOREPLY] Sending response to ${msg.key.remoteJid}`);
                    await whatsappSock.sendMessage(msg.key.remoteJid, { text: autoreply.getReply() });
                    console.log(`[AUTOREPLY] Response sent`);
                } else {
                    console.log(`[AUTOREPLY] No match, ignoring`);
                }
            }
        } else {
            console.log(`[DEBUG] No message content`);
        }
        
        console.log(`[DEBUG] ========================================\n`);
    });
    
    // Also log presence updates to see if bot is receiving anything
    sock.ev.on("presence.update", (update) => {
        console.log(`[DEBUG] Presence update: ${JSON.stringify(update).substring(0, 100)}`);
    });
}

process.on('SIGINT', async () => {
    console.log('\n🛑 Shutting down...');
    process.exit(0);
});

process.on('SIGTERM', async () => {
    console.log('\n🛑 Shutting down...');
    process.exit(0);
});

startBot().catch(err => console.error('Fatal error:', err));
