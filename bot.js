const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    downloadContentFromMessage
} = require("@whiskeysockets/baileys");
const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { NewMessage } = require('telegram/events');
const qrcode = require("qrcode-terminal");
const fs = require('fs');
const path = require('path');
const pino = require("pino");
const { Boom } = require("@hapi/boom");

// ===== CONFIGURATION =====
const API_ID = 32086282;
const API_HASH = "064a66fe7097452e6ac8f4e8df28aa97";
const TELEGRAM_BOT_TOKEN = "8717510346:AAFi_8U7L0KCh13UzEu69EGc7j8qDteyu70";

// WhatsApp channel to forward to
const WHATSAPP_CHANNEL = "120363405181626845@newsletter";

// Optional: Only forward from specific Telegram users (leave empty to forward from all)
const ALLOWED_USERS = []; // e.g., [123456789, 987654321]

// Create temp directory for media
const TEMP_DIR = path.join(__dirname, 'temp');
if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });

// State
let whatsappSock = null;
let telegramClient = null;
let isRunning = false;

// Helper: Download media from Telegram
async function downloadTelegramMedia(message) {
    try {
        if (!message.media || message.media.className === 'MessageMediaWebPage') {
            return null;
        }
        
        const tempFile = path.join(TEMP_DIR, `media_${Date.now()}_${message.id}`);
        await telegramClient.downloadMedia(message, { outputFile: tempFile });
        
        if (!fs.existsSync(tempFile)) return null;
        
        const buffer = fs.readFileSync(tempFile);
        fs.unlinkSync(tempFile);
        
        let mediaType = 'document';
        let fileName = 'file';
        
        if (message.photo) {
            mediaType = 'photo';
            fileName = `image_${message.id}.jpg`;
        } else if (message.video) {
            mediaType = 'video';
            fileName = `video_${message.id}.mp4`;
        } else if (message.document) {
            mediaType = 'document';
            const attr = message.document.attributes.find(a => a.className === 'DocumentAttributeFilename');
            fileName = attr?.fileName || `file_${message.id}.bin`;
        }
        
        return { buffer, mediaType, fileName };
    } catch (error) {
        console.error('Download failed:', error.message);
        return null;
    }
}

// Forward message to WhatsApp channel
async function forwardToChannel(text, media = null) {
    if (!whatsappSock) {
        console.log('❌ WhatsApp not connected');
        return false;
    }
    
    try {
        if (media) {
            // Send with media
            const messageOptions = media.mediaType === 'photo' 
                ? { image: media.buffer, caption: text || '' }
                : { document: media.buffer, fileName: media.fileName, caption: text || '' };
            
            await whatsappSock.sendMessage(WHATSAPP_CHANNEL, messageOptions);
            console.log(`📸 Sent media + caption to channel`);
        } else if (text) {
            // Send text only
            await whatsappSock.sendMessage(WHATSAPP_CHANNEL, { text: text });
            console.log(`📝 Sent text to channel: ${text.substring(0, 50)}...`);
        }
        return true;
    } catch (error) {
        console.error('❌ Failed to send to channel:', error.message);
        return false;
    }
}

// Start WhatsApp connection
async function startWhatsApp() {
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
        if (qr) {
            console.log('\n📱 SCAN THIS QR CODE WITH WHATSAPP:\n');
            qrcode.generate(qr, { small: true });
        }
        if (connection === "close") {
            const shouldReconnect = (lastDisconnect.error instanceof Boom)?.output?.statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect) {
                console.log('🔄 Reconnecting...');
                startWhatsApp();
            }
        } else if (connection === "open") {
            console.log('\n✅ WhatsApp connected successfully!');
            console.log(`📢 Forwarding to channel: ${WHATSAPP_CHANNEL}\n`);
        }
    });
    
    sock.ev.on("creds.update", saveCreds);
    whatsappSock = sock;
    return sock;
}

// Start Telegram bot and listen for messages
async function startTelegram() {
    telegramClient = new TelegramClient(new StringSession(""), API_ID, API_HASH, {
        connectionRetries: 3,
    });
    
    await telegramClient.start({ botAuthToken: TELEGRAM_BOT_TOKEN });
    console.log('✅ Telegram bot connected!');
    
    // Handle incoming messages
    telegramClient.addEventHandler(async (event) => {
        const message = event.message;
        if (!message) return;
        
        // Skip messages from the bot itself
        let senderId = message.fromId?.userId?.toString() || message.fromId?.value?.toString();
        if (senderId === "8717510346") return;
        
        // Filter by allowed users if specified
        if (ALLOWED_USERS.length > 0 && !ALLOWED_USERS.includes(parseInt(senderId))) {
            console.log(`⏭️ Skipping message from unauthorized user: ${senderId}`);
            return;
        }
        
        // Skip commands
        if (message.text && message.text.startsWith('/')) return;
        
        console.log(`\n📨 Received from Telegram: ${message.text?.substring(0, 50) || 'Media'}`);
        
        // Get text content
        const text = message.text || message.caption || '';
        
        // Download media if present
        const media = await downloadTelegramMedia(message);
        
        // Forward to WhatsApp channel
        await forwardToChannel(text, media);
        
    }, new NewMessage({}));
    
    console.log('👂 Listening for Telegram messages...');
}

// Main function
async function main() {
    console.log('🚀 Starting Telegram → WhatsApp Channel Forwarder\n');
    
    // Start both connections
    await startWhatsApp();
    
    // Wait a bit for WhatsApp to initialize
    setTimeout(async () => {
        await startTelegram();
        isRunning = true;
        console.log('\n✨ Bot is running! Send any message to your Telegram bot to forward to WhatsApp channel.\n');
    }, 5000);
}

// Graceful shutdown
process.on('SIGINT', async () => {
    console.log('\n\n🛑 Shutting down...');
    if (telegramClient) await telegramClient.disconnect();
    process.exit(0);
});

// Run
main().catch(console.error);
