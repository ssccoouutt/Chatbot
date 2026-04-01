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
const processedMessages = new Set();

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
        logger: pino({ level: "silent" }),
        auth: state,
        printQRInTerminal: false,
        browser: ['WhatsApp Bot', 'Chrome', '1.0.0'],
        // Important: Ensure we receive all messages
        syncFullHistory: false,
        markOnlineOnConnect: true
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
            
            // Send a test message to yourself to verify connection
            setTimeout(async () => {
                try {
                    const testJid = `${sock.user?.id?.split(':')[0]}@s.whatsapp.net`;
                    await sock.sendMessage(testJid, { text: '✅ Bot is online and working! Send a message to test.' });
                    console.log(`📤 Test message sent to your WhatsApp number\n`);
                } catch (err) {
                    console.log(`⚠️ Could not send test message: ${err.message}\n`);
                }
            }, 2000);
            
            // Start Telegram bot and scheduler
            forwarder.init(sock, null);
            forwarder.start();
        }
    });

    // ===== CREDENTIALS HANDLER =====
    sock.ev.on("creds.update", saveCreds);

    // ===== DIAGNOSTIC: Log ALL events to see if anything is happening =====
    sock.ev.on("messages.upsert", async ({ messages, type }) => {
        console.log(`\n🔔 MESSAGES EVENT TRIGGERED!`);
        console.log(`   Type: ${type}`);
        console.log(`   Messages count: ${messages?.length}`);
        
        for (const msg of messages) {
            console.log(`   Message ID: ${msg.key?.id}`);
            console.log(`   From: ${msg.key?.remoteJid}`);
            console.log(`   From me: ${msg.key?.fromMe}`);
            if (msg.message) {
                console.log(`   Message keys: ${Object.keys(msg.message).join(', ')}`);
            }
        }
        console.log(`\n`);
        
        // Only process new messages (not history)
        if (type !== 'notify') {
            console.log(`⏭️ Skipping - not a new message (type: ${type})\n`);
            return;
        }
        
        for (const msg of messages) {
            // Skip if no message content
            if (!msg.message || !msg.key?.id) continue;
            
            const msgId = msg.key.id;
            
            // Skip already processed messages
            if (processedMessages.has(msgId)) {
                console.log(`⏭️ Skipping duplicate: ${msgId}\n`);
                continue;
            }
            
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
            if (isFromMe) {
                console.log(`⏭️ Skipping - message from self\n`);
                continue;
            }
            
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
            
            // CLEAN OUTPUT - SHOW MESSAGE
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
        }
    });
    
    // ===== ADD A RAW EVENT LISTENER TO SEE IF ANY DATA ARRIVES =====
    sock.ev.on("messaging-history.set", (data) => {
        console.log(`\n📚 MESSAGING HISTORY SET`);
        console.log(`   Messages: ${data.messages?.length}`);
        console.log(`   Contacts: ${data.contacts?.length}`);
        console.log(`   Chats: ${data.chats?.length}\n`);
    });
    
    // ===== GROUP PARTICIPANT UPDATES =====
    sock.ev.on("group-participants.update", (update) => {
        console.log(`\n👥 GROUP UPDATE: ${update.action} in ${update.id}`);
        console.log(`   Participants: ${update.participants?.join(', ') || 'none'}\n`);
    });
    
    // ===== PRESENCE UPDATES =====
    sock.ev.on("presence.update", (update) => {
        // Don't log presence to avoid spam
        // console.log(`👤 Presence: ${update.id} is ${update.presences}`);
    });
    
    // ===== ERROR HANDLER =====
    sock.ev.on("error", (error) => {
        const statusCode = error?.output?.statusCode;
        if (statusCode === 515 || statusCode === 503 || statusCode === 408) return;
        console.error(`⚠️ Error:`, error.message);
    });
    
    // Log that we're ready
    console.log(`✅ Event handlers registered. Waiting for messages...\n`);
    
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
