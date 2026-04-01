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
    console.log(`[DEBUG] Baileys version: ${version}`);
    console.log(`[DEBUG] Session state loaded: ${!!state}`);
    
    const sock = makeWASocket({
        version,
        logger: pino({ level: "debug" }),  // CHANGE: Set to debug to see more
        auth: state,
        printQRInTerminal: true,
        browser: ['Ubuntu', 'Chrome', '20.0.04']
    });

    whatsappSock = sock;
    forwarder.init(whatsappSock, null);

    // LOG ALL EVENTS
    sock.ev.on("connection.update", (update) => {
        console.log(`\n[EVENT] connection.update:`, JSON.stringify(update, null, 2));
        const { connection, lastDisconnect, qr } = update;
        if (qr) {
            console.log(`[QR] QR Code received`);
            qrcode.generate(qr, { small: true });
        }
        if (connection === "close") {
            const shouldReconnect = (lastDisconnect.error instanceof Boom)?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log(`[EVENT] Connection closed, reconnecting: ${shouldReconnect}`);
            if (shouldReconnect) startBot();
        } else if (connection === "open") {
            console.log("\n✅✅✅ WHATSAPP BOT CONNECTED! ✅✅✅");
            console.log(`📱 WhatsApp Number: ${sock.user?.id?.split(':')[0] || 'Unknown'}`);
            console.log(`⏰ Random delay: ${forwarder.MIN_DELAY_HOURS}-${forwarder.MAX_DELAY_HOURS} hours`);
            console.log(`🌙 Night pause: 22:00 - 4:00 PKT`);
            console.log(`🕐 Current PKT: ${forwarder.formatPakistanTime()}\n`);
            console.log(`🤖 Waiting for messages... Send "Are-You-There" to test auto-reply\n`);
            
            // Start Telegram bot and scheduler
            forwarder.start();
        }
    });

    sock.ev.on("creds.update", (creds) => {
        console.log(`[EVENT] creds.update - saving session`);
        saveCreds();
    });

    // LOG ALL MESSAGES
    sock.ev.on("messages.upsert", async (m) => {
        console.log(`\n[EVENT] ========== messages.upsert ==========`);
        console.log(`[EVENT] Type: ${m.type}`);
        console.log(`[EVENT] Messages count: ${m.messages?.length}`);
        
        if (m.messages && m.messages.length > 0) {
            const msg = m.messages[0];
            console.log(`[EVENT] Message key:`, JSON.stringify(msg.key, null, 2));
            console.log(`[EVENT] Message fromMe: ${msg.key?.fromMe}`);
            console.log(`[EVENT] Message pushName: ${msg.pushName}`);
            console.log(`[EVENT] Message timestamp: ${msg.messageTimestamp}`);
            
            // Extract and log text
            let text = '';
            if (msg.message?.conversation) {
                text = msg.message.conversation;
                console.log(`[EVENT] Conversation text: ${text}`);
            } else if (msg.message?.extendedTextMessage?.text) {
                text = msg.message.extendedTextMessage.text;
                console.log(`[EVENT] Extended text: ${text}`);
            } else if (msg.message?.imageMessage?.caption) {
                text = msg.message.imageMessage.caption;
                console.log(`[EVENT] Image caption: ${text}`);
            } else if (msg.message?.videoMessage?.caption) {
                text = msg.message.videoMessage.caption;
                console.log(`[EVENT] Video caption: ${text}`);
            } else {
                console.log(`[EVENT] Message type: ${Object.keys(msg.message || {})}`);
            }
            
            // Skip if from self
            if (msg.key?.fromMe) {
                console.log(`[EVENT] Skipping - message from self`);
                return;
            }
            
            const from = msg.key?.remoteJid;
            if (from?.includes('@g.us')) {
                console.log(`[EVENT] Skipping - group message`);
                return;
            }
            
            if (text) {
                console.log(`[EVENT] Processing message: "${text}" from ${from}`);
                
                if (autoreply.shouldReply(text)) {
                    console.log(`[AUTOREPLY] Trigger matched! Sending reply to ${from}`);
                    try {
                        await sock.sendMessage(from, { text: autoreply.getReply() });
                        console.log(`[AUTOREPLY] ✅ Reply sent`);
                    } catch (err) {
                        console.error(`[AUTOREPLY] ❌ Failed to send:`, err.message);
                    }
                } else {
                    console.log(`[AUTOREPLY] No trigger match`);
                }
            }
        }
        console.log(`[EVENT] ========================================\n`);
    });
    
    // LOG OTHER EVENTS
    sock.ev.on("presence.update", (update) => {
        console.log(`[EVENT] presence.update:`, JSON.stringify(update).substring(0, 200));
    });
    
    sock.ev.on("group-participants.update", (update) => {
        console.log(`[EVENT] group-participants.update:`, JSON.stringify(update).substring(0, 200));
    });
    
    sock.ev.on("messaging-history.set", (data) => {
        console.log(`[EVENT] messaging-history.set: messages: ${data.messages?.length}, contacts: ${data.contacts?.length}`);
    });
    
    // Also log any errors
    sock.ev.on("error", (error) => {
        console.error(`[EVENT] ERROR:`, error);
    });
    
    console.log(`[DEBUG] WhatsApp socket created, waiting for connection...`);
}

process.on('SIGINT', async () => {
    console.log('\n🛑 Shutting down...');
    if (whatsappSock) {
        await whatsappSock.end();
    }
    process.exit(0);
});

process.on('SIGTERM', async () => {
    console.log('\n🛑 Shutting down...');
    if (whatsappSock) {
        await whatsappSock.end();
    }
    process.exit(0);
});

startBot().catch(err => console.error('Fatal error:', err));
