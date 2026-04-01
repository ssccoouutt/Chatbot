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
const fs = require('fs');  // ADD THIS LINE

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
    forwarder.init(whatsappSock, null); // Telegram bot will be set later

    sock.ev.on("connection.update", (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (qr) qrcode.generate(qr, { small: true });
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
            
            // Start Telegram bot and scheduler
            forwarder.start();
        }
    });

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("messages.upsert", async (m) => {
        const msg = m.messages[0];
        if (!msg.message || msg.key.fromMe) return;
        
        const from = msg.key.remoteJid;
        
        // IGNORE GROUP MESSAGES
        if (from.includes('@g.us')) return;
        
        let text = '';
        if (msg.message?.conversation) text = msg.message.conversation;
        else if (msg.message?.extendedTextMessage?.text) text = msg.message.extendedTextMessage.text;
        else if (msg.message?.imageMessage?.caption) text = msg.message.imageMessage.caption;
        else if (msg.message?.videoMessage?.caption) text = msg.message.videoMessage.caption;
        else return;
        
        console.log(`[WHATSAPP] 📱 ${from}: ${text}`);
        
        // Auto-reply
        if (autoreply.shouldReply(text)) {
            console.log(`[AUTOREPLY] Sending response to ${from}`);
            await whatsappSock.sendMessage(from, { text: autoreply.getReply() });
        }
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
