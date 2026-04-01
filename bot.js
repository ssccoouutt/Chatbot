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

// Create temp directory
if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });

// ===== MESSAGE PROCESSING =====
const processedMessages = new Set(); // Prevent duplicate processing

// Clean processed messages every 5 minutes
setInterval(() => {
    processedMessages.clear();
}, 5 * 60 * 1000);

// ===== WHATSAPP BOT =====
async function startBot() {
    console.log(`\n🚀 Starting WhatsApp Bot...`);
    
    const { state, saveCreds } = await useMultiFileAuthState("session");
    const { version } = await fetchLatestBaileysVersion();
    
    const sock = makeWASocket({
        version,
        logger: pino({ level: "silent" }), // Silent to avoid noise
        auth: state,
        printQRInTerminal: false,
        browser: ['WhatsApp Bot', 'Chrome', '1.0.0']
    });

    // ===== CONNECTION HANDLER =====
    sock.ev.on("connection.update", (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        if (qr) {
            console.log(`\n📱 SCAN THIS QR CODE WITH WHATSAPP:\n`);
            qrcode.generate(qr, { small: true });
            console.log(`\n`);
        }
        
        if (connection === "close") {
            const shouldReconnect = (lastDisconnect.error instanceof Boom)?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log(`❌ Connection closed. Reconnecting: ${shouldReconnect}`);
            if (shouldReconnect) setTimeout(startBot, 3000);
        } else if (connection === "open") {
            console.log(`\n✅✅✅ WHATSAPP BOT CONNECTED! ✅✅✅`);
            console.log(`📱 Bot Number: ${sock.user?.id?.split(':')[0] || 'Unknown'}`);
            console.log(`⏰ Random delay: ${forwarder.MIN_DELAY_HOURS}-${forwarder.MAX_DELAY_HOURS} hours`);
            console.log(`🌙 Night pause: 22:00 - 4:00 PKT`);
            console.log(`🕐 Current PKT: ${forwarder.formatPakistanTime()}\n`);
            console.log(`🤖 Bot is ready! Listening for messages...\n`);
            console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);
            
            // Start Telegram bot and scheduler
            forwarder.init(sock, null);
            forwarder.start();
        }
    });

    // ===== CREDENTIALS HANDLER =====
    sock.ev.on("creds.update", saveCreds);

    // ===== MESSAGE HANDLER - GET ALL MESSAGES =====
    sock.ev.on("messages.upsert", async ({ messages, type }) => {
        // Only process new messages (not history)
        if (type !== 'notify') return;
        
        for (const msg of messages) {
            // Skip if no message content
            if (!msg.message || !msg.key?.id) continue;
            
            const msgId = msg.key.id;
            
            // Skip already processed messages
            if (processedMessages.has(msgId)) continue;
            
            // Mark as processed
            processedMessages.add(msgId);
            
            const from = msg.key.remoteJid;
            const isFromMe = msg.key.fromMe;
            const isGroup = from?.includes('@g.us');
            const isChannel = from?.includes('@newsletter');
            const isPrivate = !isGroup && !isChannel && from?.includes('@s.whatsapp.net');
            
            // Determine chat type
            let chatType = 'PRIVATE';
            if (isGroup) chatType = 'GROUP';
            if (isChannel) chatType = 'CHANNEL';
            
            // Skip messages from self
            if (isFromMe) continue;
            
            // Extract message text
            let text = '';
            let messageType = 'unknown';
            
            if (msg.message?.conversation) {
                text = msg.message.conversation;
                messageType = 'text';
            } else if (msg.message?.extendedTextMessage?.text) {
                text = msg.message.extendedTextMessage.text;
                messageType = 'text';
            } else if (msg.message?.imageMessage?.caption) {
                text = msg.message.imageMessage.caption || '';
                messageType = 'image';
            } else if (msg.message?.videoMessage?.caption) {
                text = msg.message.videoMessage.caption || '';
                messageType = 'video';
            } else if (msg.message?.audioMessage) {
                messageType = 'audio';
            } else if (msg.message?.documentMessage) {
                messageType = 'document';
            } else if (msg.message?.stickerMessage) {
                messageType = 'sticker';
            } else if (msg.message?.pollCreationMessage) {
                messageType = 'poll';
            }
            
            // Get sender info
            let sender = from?.split('@')[0] || 'Unknown';
            
            // For groups, get participant info if available
            if (isGroup && msg.key.participant) {
                sender = msg.key.participant.split('@')[0];
            }
            
            // CLEAN OUTPUT - ONLY SHOW MESSAGES
            console.log(`\n📨 [${chatType}] ${sender}: ${text || `[${messageType}]`}`);
            
            // ===== AUTO-REPLY FOR PRIVATE CHATS =====
            if (isPrivate && text && autoreply.shouldReply(text)) {
                console.log(`🤖 Auto-replying to ${sender}`);
                try {
                    await sock.sendMessage(from, { text: autoreply.getReply() });
                    console.log(`✅ Reply sent\n`);
                } catch (err) {
                    console.log(`❌ Failed to send reply: ${err.message}\n`);
                }
            }
            
            // ===== FORWARDING FOR GROUPS/CHANNELS (if configured) =====
            // This will be handled by forwarder.js when needed
            
        }
    });
    
    // ===== GROUP PARTICIPANT UPDATES =====
    sock.ev.on("group-participants.update", (update) => {
        const { id, participants, action } = update;
        console.log(`\n👥 GROUP UPDATE: ${action} in ${id}`);
        console.log(`   Participants: ${participants.join(', ')}\n`);
    });
    
    // ===== ERROR HANDLER =====
    sock.ev.on("error", (error) => {
        // Suppress common connection errors
        const statusCode = error?.output?.statusCode;
        if (statusCode === 515 || statusCode === 503 || statusCode === 408) return;
        console.error(`⚠️ Error:`, error.message);
    });
    
    return sock;
}

// ===== GRACEFUL SHUTDOWN =====
process.on('SIGINT', async () => {
    console.log('\n\n🛑 Shutting down...');
    process.exit(0);
});

process.on('SIGTERM', async () => {
    console.log('\n\n🛑 Shutting down...');
    process.exit(0);
});

// ===== START THE BOT =====
startBot().catch(err => {
    console.error('❌ Fatal error:', err.message);
    process.exit(1);
});
