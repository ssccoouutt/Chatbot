const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    Browsers,
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

// Create temp directory
if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });

// ===== MESSAGE DEDUPLICATION (like reference script) =====
const processedMessages = new Set();

setInterval(() => {
    processedMessages.clear();
}, 5 * 60 * 1000);

// ===== CUSTOM LOGGER TO SUPPRESS NOISE (like reference script) =====
const forbiddenPatterns = [
    'closing session', 'prekey bundle', 'pendingprekey', '_chains',
    'registrationid', 'currentratchet', 'chainkey', 'ratchet',
    'signal protocol', 'ephemeralkeypair', 'indexinfo', 'basekey',
    'sessionentry'
];

const originalConsoleLog = console.log;
const originalConsoleError = console.error;
const originalConsoleWarn = console.warn;

console.log = (...args) => {
    const msg = args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ').toLowerCase();
    if (!forbiddenPatterns.some(p => msg.includes(p))) {
        originalConsoleLog.apply(console, args);
    }
};

console.error = (...args) => {
    const msg = args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ').toLowerCase();
    if (!forbiddenPatterns.some(p => msg.includes(p))) {
        originalConsoleError.apply(console, args);
    }
};

console.warn = (...args) => {
    const msg = args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ').toLowerCase();
    if (!forbiddenPatterns.some(p => msg.includes(p))) {
        originalConsoleWarn.apply(console, args);
    }
};

// ===== MAIN BOT =====
async function startBot() {
    console.log('\n🚀 Starting WhatsApp Bot...\n');
    
    const sessionFolder = './session';
    const { state, saveCreds } = await useMultiFileAuthState(sessionFolder);
    const { version } = await fetchLatestBaileysVersion();
    
    const sock = makeWASocket({
        version,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false,
        browser: Browsers.macOS('Desktop'),
        auth: state,
        syncFullHistory: false,
        markOnlineOnConnect: true
    });
    
    // Connection handler
    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        if (qr) {
            console.log('\n📱 SCAN THIS QR CODE WITH WHATSAPP:\n');
            qrcode.generate(qr, { small: true });
            console.log('\n');
        }
        
        if (connection === 'close') {
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log(`❌ Connection closed. Reconnecting: ${shouldReconnect}`);
            if (shouldReconnect) {
                setTimeout(() => startBot(), 3000);
            }
        } else if (connection === 'open') {
            console.log('\n✅✅✅ WHATSAPP BOT CONNECTED! ✅✅✅');
            console.log(`📱 Bot Number: ${sock.user.id.split(':')[0]}`);
            console.log(`⏰ Random delay: ${forwarder.MIN_DELAY_HOURS}-${forwarder.MAX_DELAY_HOURS} hours`);
            console.log(`🌙 Night pause: 22:00 - 4:00 PKT`);
            console.log(`🕐 Current PKT: ${forwarder.formatPakistanTime()}\n`);
            console.log('🤖 Bot is ready! Listening for messages...\n');
            console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
            
            // Start Telegram bridge
            forwarder.init(sock, null);
            forwarder.start();
        }
    });
    
    // Credentials update
    sock.ev.on('creds.update', saveCreds);
    
    // MESSAGE HANDLER - EXACTLY LIKE REFERENCE SCRIPT
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        // Only process new messages (not history)
        if (type !== 'notify') return;
        
        for (const msg of messages) {
            // Skip invalid messages
            if (!msg.message || !msg.key?.id) continue;
            
            const msgId = msg.key.id;
            
            // Skip duplicate
            if (processedMessages.has(msgId)) continue;
            processedMessages.add(msgId);
            
            const from = msg.key.remoteJid;
            if (!from) continue;
            
            // Skip broadcast/status messages
            if (from.includes('@broadcast') || from.includes('status.broadcast')) continue;
            
            const isFromMe = msg.key.fromMe;
            const isGroup = from.includes('@g.us');
            const isChannel = from.includes('@newsletter');
            
            // Skip messages from self
            if (isFromMe) continue;
            
            // Extract text
            let text = '';
            let messageType = 'unknown';
            
            if (msg.message?.conversation) {
                text = msg.message.conversation;
                messageType = 'text';
            } else if (msg.message?.extendedTextMessage?.text) {
                text = msg.message.extendedTextMessage.text;
                messageType = 'text';
            } else if (msg.message?.imageMessage) {
                text = msg.message.imageMessage.caption || '';
                messageType = 'image';
            } else if (msg.message?.videoMessage) {
                text = msg.message.videoMessage.caption || '';
                messageType = 'video';
            } else if (msg.message?.audioMessage) {
                messageType = 'audio';
            } else if (msg.message?.documentMessage) {
                messageType = 'document';
            } else if (msg.message?.stickerMessage) {
                messageType = 'sticker';
            }
            
            // Get sender
            let sender = from.split('@')[0];
            if (isGroup && msg.key.participant) {
                sender = msg.key.participant.split('@')[0];
            }
            
            let chatType = 'PRIVATE';
            if (isGroup) chatType = 'GROUP';
            if (isChannel) chatType = 'CHANNEL';
            
            // SHOW MESSAGE
            if (text) {
                console.log(`\n📨 [${chatType}] ${sender}: ${text}`);
            } else if (messageType !== 'text') {
                console.log(`\n📎 [${chatType}] ${sender}: [${messageType.toUpperCase()}]`);
            }
            
            // Auto-reply for private chats
            if (!isGroup && !isChannel && text && autoreply.shouldReply(text)) {
                console.log(`🤖 Auto-replying to ${sender}`);
                try {
                    await sock.sendMessage(from, { text: autoreply.getReply() });
                    console.log(`✅ Reply sent\n`);
                } catch (err) {
                    console.log(`❌ Reply failed: ${err.message}\n`);
                }
            }
        }
    });
    
    // Group participant updates
    sock.ev.on('group-participants.update', (update) => {
        const { id, participants, action } = update;
        if (participants && participants.length > 0) {
            const groupId = id.split('@')[0];
            const users = participants.map(p => p.split('@')[0]).join(', ');
            console.log(`\n👥 GROUP: ${action} in ${groupId}`);
            console.log(`   ${users}\n`);
        }
    });
}

// Start
startBot().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
});
