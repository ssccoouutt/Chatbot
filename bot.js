const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    downloadContentFromMessage,
    generateWAMessageContent,
    generateWAMessage,
    prepareWAMessageMedia
} = require("@whiskeysockets/baileys");
const pino = require("pino");
const { Boom } = require("@hapi/boom");
const qrcode = require("qrcode-terminal");
const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { NewMessage } = require('telegram/events');
const { Telegraf } = require('telegraf');
const axios = require("axios");
const path = require("path");
const fs = require('fs');
const sharp = require('sharp');

// ===== CONFIGURATION =====
const API_ID = 32086282;  // Your Telegram API ID
const API_HASH = "064a66fe7097452e6ac8f4e8df28aa97";  // Your Telegram API Hash
const TELEGRAM_BOT_TOKEN = "8717510346:AAFi_8U7L0KCh13UzEu69EGc7j8qDteyu70";  // Your Telegram Bot Token
const BOT_ID = "8717510346";  // Your Telegram Bot ID (without 'bot' prefix)

// WhatsApp targets
const WHATSAPP_NUMBER = "923247220362";  // Your WhatsApp number
const WHATSAPP_GROUPS = [
    "120363140590753276@g.us",
    "120363162260844407@g.us",
    "120363042237526273@g.us",
    "120363023394033137@g.us",
    "120363161222427319@g.us"
];

// Create temp directory
const TEMP_DIR = path.join(__dirname, 'temp');
if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });

// ===== STATE =====
let telegramClient = null;
let isTelegramBridgeActive = false;
let telegramBot = null;
let keepAliveInterval = null;
let whatsappSock = null;

// Store pending messages for confirmation
const pendingMessages = new Map();
const RATE_LIMIT_DELAY = 3000;

// ===== HELPER FUNCTIONS =====
function log(level, msg, data) {
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] [${level}] ${msg}`);
    if (data) console.log(JSON.stringify(data, null, 2));
}

function cleanWhitespace(text) {
    if (!text) return text;
    text = text.replace(/[ \t]+/g, ' ');
    text = text.replace(/\n{3,}/g, '\n\n');
    return text.trim();
}

function convertTelegramToWhatsApp(text, entities) {
    if (!text) return text;
    
    let cleanText = text;
    cleanText = cleanText.replace(/\*\*/g, '');
    cleanText = cleanText.replace(/__/g, '');
    cleanText = cleanText.replace(/~~/g, '');
    cleanText = cleanText.replace(/`/g, '');
    
    if (entities && entities.length > 0) {
        const reversedEntities = [...entities].sort((a, b) => b.offset - a.offset);
        let textArray = cleanText.split('');
        
        for (const entity of reversedEntities) {
            const start = entity.offset;
            const end = start + entity.length;
            const type = entity.className;
            
            if (type === 'MessageEntityBlockquote') continue;
            
            const content = cleanText.substring(start, end);
            
            let prefix = '', suffix = '';
            switch (type) {
                case 'MessageEntityBold': prefix = '*'; suffix = '*'; break;
                case 'MessageEntityItalic': prefix = '_'; suffix = '_'; break;
                case 'MessageEntityStrike': prefix = '~'; suffix = '~'; break;
                case 'MessageEntityCode':
                case 'MessageEntityPre': prefix = '```'; suffix = '```'; break;
                default: continue;
            }
            
            let replacement;
            if (type === 'MessageEntityPre') {
                replacement = prefix + content + suffix;
            } else {
                const lines = content.split('\n');
                const wrappedLines = [];
                for (const line of lines) {
                    if (line.trim()) {
                        wrappedLines.push(prefix + line.trim() + suffix);
                    } else {
                        wrappedLines.push('');
                    }
                }
                replacement = wrappedLines.join('\n');
            }
            
            textArray.splice(start, end - start, replacement);
        }
        
        let result = textArray.join('');
        return cleanWhitespace(result);
    }
    
    let formatted = text;
    formatted = formatted.replace(/\*\*(.*?)\*\*/g, '*$1*');
    formatted = formatted.replace(/__(.*?)__/g, '_$1_');
    formatted = formatted.replace(/~~(.*?)~~/g, '~$1~');
    formatted = formatted.replace(/`(.*?)`/g, '```$1```');
    
    return cleanWhitespace(formatted);
}

async function downloadMedia(client, message) {
    try {
        if (message.media?.className === 'MessageMediaWebPage') {
            return null;
        }
        
        let lastError = null;
        for (let attempt = 1; attempt <= 3; attempt++) {
            try {
                const tempFile = path.join(TEMP_DIR, `tg_${message.id}_attempt_${attempt}`);
                
                if (!fs.existsSync(TEMP_DIR)) {
                    fs.mkdirSync(TEMP_DIR, { recursive: true });
                }
                
                await client.downloadMedia(message, { 
                    outputFile: tempFile
                });
                
                if (!fs.existsSync(tempFile)) {
                    throw new Error('File not created');
                }
                
                const stats = fs.statSync(tempFile);
                if (stats.size === 0) {
                    throw new Error('File is empty');
                }
                
                const buffer = fs.readFileSync(tempFile);
                fs.unlinkSync(tempFile);
                
                return {
                    buffer,
                    size: stats.size,
                    mimeType: message.photo ? 'image/jpeg' : 
                             message.video ? 'video/mp4' : 
                             message.document?.mimeType || 'application/octet-stream'
                };
                
            } catch (err) {
                lastError = err;
                try {
                    const tempFile = path.join(TEMP_DIR, `tg_${message.id}_attempt_${attempt}`);
                    if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
                } catch (cleanupError) {}
                
                if (attempt < 3) {
                    await new Promise(resolve => setTimeout(resolve, attempt * 2000));
                }
            }
        }
        
        return null;
        
    } catch (error) {
        return null;
    }
}

async function generateThumbnail(buffer) {
    try {
        const thumbnail = await sharp(buffer)
            .resize(100, 100, { fit: 'inside' })
            .jpeg({ quality: 50 })
            .toBuffer();
        return thumbnail.toString('base64');
    } catch (err) {
        log('WARN', 'Thumbnail generation failed', err.message);
        return null;
    }
}

async function sendToAllGroups(messageData) {
    try {
        if (!whatsappSock) return false;
        
        let successCount = 0;
        let failedGroups = [];
        
        // Generate thumbnail for photos
        let thumbnail = null;
        if (messageData.type === 'media' && messageData.mediaType === 'photo') {
            thumbnail = await generateThumbnail(messageData.buffer);
        }
        
        // Send to each group
        for (let i = 0; i < WHATSAPP_GROUPS.length; i++) {
            const target = WHATSAPP_GROUPS[i];
            
            try {
                if (messageData.type === 'text') {
                    await whatsappSock.sendMessage(target, { text: messageData.content });
                    successCount++;
                    
                } else if (messageData.type === 'media') {
                    const mediaBuffer = messageData.buffer;
                    const mediaCaption = messageData.caption || '';
                    const mediaFileName = messageData.fileName;
                    const mediaMimeType = messageData.mimeType;
                    const mediaType = messageData.mediaType;
                    const mediaSize = messageData.size;
                    
                    const fileSizeMB = mediaSize / (1024 * 1024);
                    
                    let messageOptions = {};
                    
                    if (fileSizeMB > 100) {
                        messageOptions = {
                            document: mediaBuffer,
                            fileName: mediaFileName || 'file.bin',
                            caption: mediaCaption,
                            mimetype: mediaMimeType
                        };
                    } else {
                        if (mediaType === 'photo') {
                            messageOptions = {
                                image: mediaBuffer,
                                caption: mediaCaption
                            };
                            if (thumbnail) {
                                messageOptions.jpegThumbnail = thumbnail;
                            }
                        } else if (mediaType === 'video') {
                            messageOptions = {
                                video: mediaBuffer,
                                caption: mediaCaption
                            };
                        } else {
                            messageOptions = {
                                document: mediaBuffer,
                                fileName: mediaFileName || 'file',
                                caption: mediaCaption,
                                mimetype: mediaMimeType
                            };
                        }
                    }
                    
                    await whatsappSock.sendMessage(target, messageOptions);
                    successCount++;
                }
                
                // Delay between sends
                if (i < WHATSAPP_GROUPS.length - 1) {
                    await new Promise(resolve => setTimeout(resolve, RATE_LIMIT_DELAY));
                }
                
            } catch (err) {
                log('ERROR', `Failed to send to group ${target}`, err.message);
                failedGroups.push(target);
            }
        }
        
        log('INFO', `Sent to ${successCount}/${WHATSAPP_GROUPS.length} groups`);
        return successCount > 0;
        
    } catch (error) {
        log('ERROR', 'sendToAllGroups failed', error.message);
        return false;
    }
}

async function sendToOwnChat(messageData) {
    try {
        if (!whatsappSock) return false;
        
        const jid = WHATSAPP_NUMBER.includes('@') ? 
            WHATSAPP_NUMBER : `${WHATSAPP_NUMBER}@s.whatsapp.net`;
        
        if (messageData.type === 'text') {
            await whatsappSock.sendMessage(jid, { text: messageData.content });
        } else if (messageData.type === 'media') {
            const mediaBuffer = messageData.buffer;
            const mediaCaption = messageData.caption || '';
            const mediaFileName = messageData.fileName;
            const mediaMimeType = messageData.mimeType;
            const mediaType = messageData.mediaType;
            
            if (mediaType === 'photo') {
                await whatsappSock.sendMessage(jid, {
                    image: mediaBuffer,
                    caption: mediaCaption
                });
            } else if (mediaType === 'video') {
                await whatsappSock.sendMessage(jid, {
                    video: mediaBuffer,
                    caption: mediaCaption
                });
            } else {
                await whatsappSock.sendMessage(jid, {
                    document: mediaBuffer,
                    fileName: mediaFileName || 'file',
                    caption: mediaCaption,
                    mimetype: mediaMimeType
                });
            }
        }
        
        log('INFO', `Sent to own chat: ${WHATSAPP_NUMBER}`);
        return true;
        
    } catch (error) {
        log('ERROR', 'sendToOwnChat failed', error.message);
        return false;
    }
}

function startKeepAlive() {
    if (keepAliveInterval) clearInterval(keepAliveInterval);
    
    keepAliveInterval = setInterval(async () => {
        if (!telegramClient || !telegramClient.connected) {
            clearInterval(keepAliveInterval);
            keepAliveInterval = null;
            return;
        }
        
        try {
            await telegramClient.getMe();
        } catch (err) {
            // Silently ignore keep-alive errors
        }
    }, 15000);
}

function initTelegramBot() {
    if (telegramBot) return;
    
    telegramBot = new Telegraf(TELEGRAM_BOT_TOKEN);
    
    telegramBot.command('start', (ctx) => {
        const helpMessage = 
            `🤖 *WhatsApp Forwarder Bot*\n\n` +
            `Send any message here and choose where to forward it.\n\n` +
            `*Options:*\n` +
            `• 👥 *ALL GROUPS* - Send to ${WHATSAPP_GROUPS.length} groups\n` +
            `• 📱 *Own Chat* - Send only to your WhatsApp\n` +
            `• ❌ *Cancel* - Don't forward`;
        
        ctx.reply(helpMessage, { parse_mode: 'Markdown' });
    });
    
    telegramBot.on('callback_query', async (ctx) => {
        try {
            const callbackData = ctx.callbackQuery.data;
            const parts = callbackData.split('_');
            if (parts.length !== 3 || parts[0] !== 'confirm') {
                await ctx.answerCbQuery('Invalid option');
                return;
            }
            
            const originalMessageId = parts[1];
            const target = parts[2];
            const pendingKey = `${ctx.chat.id}_${originalMessageId}`;
            const messageData = pendingMessages.get(pendingKey);
            
            if (!messageData) {
                await ctx.answerCbQuery('❌ Expired');
                await ctx.editMessageText('❌ This message has expired.');
                return;
            }
            
            await ctx.answerCbQuery('⏳ Processing...');
            pendingMessages.delete(pendingKey);
            
            if (target === 'cancel') {
                await ctx.editMessageText('❌ Cancelled.');
                return;
            }
            
            let success = false;
            let targetText = '';
            
            if (target === 'all') {
                success = await sendToAllGroups(messageData);
                targetText = `${WHATSAPP_GROUPS.length} groups`;
            } else if (target === 'own') {
                success = await sendToOwnChat(messageData);
                targetText = 'your chat';
            }
            
            if (success) {
                await ctx.editMessageText(`✅ Successfully forwarded to ${targetText}`);
            } else {
                await ctx.editMessageText('❌ Failed to forward');
            }
            
        } catch (error) {
            log('ERROR', 'Callback query error', error.message);
            try {
                await ctx.answerCbQuery('Error processing');
            } catch (e) {}
        }
    });
    
    telegramBot.launch().catch((err) => log('ERROR', 'Telegram bot launch failed', err.message));
}

async function startTelegramBridge() {
    if (isTelegramBridgeActive) {
        log('INFO', 'Telegram bridge already active');
        return true;
    }
    
    log('INFO', 'Starting Telegram bridge...');
    
    try {
        if (telegramClient) {
            await telegramClient.disconnect();
        }
        
        telegramClient = new TelegramClient(new StringSession(""), API_ID, API_HASH, {
            connectionRetries: 5,
            downloadRetries: 3
        });
        
        await telegramClient.start({ botAuthToken: TELEGRAM_BOT_TOKEN });
        log('INFO', 'Telegram client connected');
        
        initTelegramBot();
        startKeepAlive();
        
        // Message handler
        async function messageHandler(event) {
            try {
                const msg = event.message;
                if (!msg) return;
                
                let senderId = null;
                if (msg.fromId) {
                    if (msg.fromId.userId) senderId = msg.fromId.userId.toString();
                    else if (msg.fromId.value) senderId = msg.fromId.value.toString();
                }
                
                // Skip messages from the bot itself
                if (senderId === BOT_ID) return;
                
                // Skip commands
                if (msg.text && msg.text.startsWith('/')) return;
                
                const chatId = msg.chatId?.value?.toString() || msg.peerId?.userId?.toString();
                if (!chatId) return;
                
                const text = msg.text || msg.caption || '';
                const entities = msg.entities || [];
                
                const formattedText = convertTelegramToWhatsApp(text, entities);
                
                let messageData = {
                    type: 'text',
                    content: formattedText,
                    timestamp: Date.now()
                };
                
                if (msg.media && msg.media.className !== 'MessageMediaWebPage') {
                    const mediaResult = await downloadMedia(telegramClient, msg);
                    
                    if (mediaResult) {
                        let fileName = 'file';
                        let mediaType = 'document';
                        
                        if (msg.photo) {
                            mediaType = 'photo';
                            fileName = `image_${msg.id}.jpg`;
                        } else if (msg.video) {
                            mediaType = 'video';
                            fileName = `video_${msg.id}.mp4`;
                        } else if (msg.document) {
                            mediaType = 'document';
                            const attr = msg.document.attributes.find(a => a.className === 'DocumentAttributeFilename');
                            fileName = attr?.fileName || `file_${msg.id}.bin`;
                        } else if (msg.audio) {
                            mediaType = 'audio';
                            fileName = `audio_${msg.id}.mp3`;
                        } else if (msg.voice) {
                            mediaType = 'voice';
                            fileName = `voice_${msg.id}.ogg`;
                        } else if (msg.sticker) {
                            mediaType = 'sticker';
                            fileName = `sticker_${msg.id}.webp`;
                        }
                        
                        messageData = {
                            type: 'media',
                            mediaType,
                            buffer: mediaResult.buffer,
                            size: mediaResult.size,
                            mimeType: mediaResult.mimeType,
                            fileName,
                            caption: formattedText,
                            timestamp: Date.now()
                        };
                    } else {
                        return;
                    }
                }
                
                // Store for user confirmation
                const pendingKey = `${chatId}_${msg.id}`;
                pendingMessages.set(pendingKey, messageData);
                
                // Cleanup old messages (5 minutes)
                const now = Date.now();
                for (const [key, data] of pendingMessages.entries()) {
                    if (now - data.timestamp > 300000) {
                        pendingMessages.delete(key);
                    }
                }
                
                const previewText = formattedText.length > 100 ? 
                    formattedText.substring(0, 100) + '...' : 
                    formattedText || '[No text]';
                
                const fileSizeInfo = messageData.type === 'media' ? 
                    ` (${(messageData.size / 1024 / 1024).toFixed(2)}MB)` : '';
                
                const confirmationMessage = 
                    `📨 New Message\n\n` +
                    `Preview: ${previewText}${fileSizeInfo}\n\n` +
                    `Forward to?`;
                
                await telegramBot.telegram.sendMessage(
                    parseInt(chatId),
                    confirmationMessage,
                    {
                        reply_markup: {
                            inline_keyboard: [
                                [
                                    { text: `👥 ALL GROUPS (${WHATSAPP_GROUPS.length})`, callback_data: `confirm_${msg.id}_all` },
                                    { text: '📱 Own Chat', callback_data: `confirm_${msg.id}_own` }
                                ],
                                [
                                    { text: '❌ Cancel', callback_data: `confirm_${msg.id}_cancel` }
                                ]
                            ]
                        }
                    }
                );
                
                log('INFO', `Forward request sent for message ${msg.id} from chat ${chatId}`);
                
            } catch (err) {
                log('ERROR', 'Message handler error', err.message);
            }
        }
        
        telegramClient.addEventHandler(messageHandler, new NewMessage({}));
        
        isTelegramBridgeActive = true;
        log('INFO', '✅ Telegram bridge started successfully');
        return true;
        
    } catch (error) {
        log('ERROR', 'Failed to start Telegram bridge', error.message);
        return false;
    }
}

async function stopTelegramBridge() {
    if (!isTelegramBridgeActive) {
        return;
    }
    
    log('INFO', 'Stopping Telegram bridge...');
    
    try {
        if (telegramClient) {
            await telegramClient.disconnect();
            telegramClient = null;
        }
        
        if (telegramBot) {
            telegramBot.stop();
            telegramBot = null;
        }
        
        if (keepAliveInterval) {
            clearInterval(keepAliveInterval);
            keepAliveInterval = null;
        }
        
        isTelegramBridgeActive = false;
        pendingMessages.clear();
        
        log('INFO', '✅ Telegram bridge stopped');
        
    } catch (error) {
        log('ERROR', 'Error stopping Telegram bridge', error.message);
    }
}

// ===== MAIN BOT FUNCTION =====
async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState("session");
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version,
        logger: pino({ level: "silent" }),
        printQRInTerminal: true,
        auth: state,
    });

    // Store socket globally for bridge functions
    whatsappSock = sock;

    sock.ev.on("connection.update", (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (qr) qrcode.generate(qr, { small: true });
        if (connection === "close") {
            const shouldReconnect = (lastDisconnect.error instanceof Boom)?.output?.statusCode !== DisconnectReason.loggedOut;
            log('INFO', "Connection closed, reconnecting:", shouldReconnect);
            if (shouldReconnect) startBot();
        } else if (connection === "open") {
            log('INFO', "\n✅✅✅ BOT CONNECTED SUCCESSFULLY! ✅✅✅");
            log('INFO', `📢 WhatsApp Number: ${WHATSAPP_NUMBER}`);
            log('INFO', `👥 Groups: ${WHATSAPP_GROUPS.length} groups configured`);
            log('INFO', "📱 Commands: .tg [on|off|status] - Manage Telegram bridge");
            log('INFO', "           .ping - Test bot response\n");
            
            // Auto-start Telegram bridge
            setTimeout(() => {
                startTelegramBridge();
            }, 3000);
        }
    });

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("messages.upsert", async (m) => {
        const msg = m.messages[0];
        if (!msg.message || msg.key.fromMe) {
            return;
        }

        const from = msg.key.remoteJid;
        
        // Get message text
        let text = '';
        let rawText = '';
        
        if (msg.message?.conversation) {
            text = msg.message.conversation;
            rawText = text;
        }
        else if (msg.message?.extendedTextMessage?.text) {
            text = msg.message.extendedTextMessage.text;
            rawText = text;
        }
        else if (msg.message?.imageMessage?.caption) {
            text = msg.message.imageMessage.caption;
            rawText = text;
        }
        else if (msg.message?.videoMessage?.caption) {
            text = msg.message.videoMessage.caption;
            rawText = text;
        }
        else {
            return;
        }

        const userMessage = text.toLowerCase().trim();
        
        log('INFO', `Message from ${from}: ${text}`);

        // ===== PING COMMAND =====
        if (userMessage === '.ping') {
            try {
                await sock.sendMessage(from, { text: 'pong 🏓' });
                log('INFO', 'Sent pong response');
            } catch (err) {
                log('ERROR', 'Failed to send pong', err.message);
            }
        }
        
        // ===== TELEGRAM BRIDGE MANAGEMENT COMMANDS =====
        else if (userMessage === '.tg' || userMessage === '.tg status') {
            const statusText = `🤖 *Telegram Bridge Status*\n\n` +
                `Active: ${isTelegramBridgeActive ? '✅' : '❌'}\n` +
                `WhatsApp: ${WHATSAPP_NUMBER}\n` +
                `Groups: ${WHATSAPP_GROUPS.length}\n\n` +
                `*Commands:*\n` +
                `• \`.tg on\` - Start bridge\n` +
                `• \`.tg off\` - Stop bridge\n` +
                `• \`.tg status\` - Show status`;
            
            await sock.sendMessage(from, { text: statusText });
        }
        else if (userMessage === '.tg on') {
            if (isTelegramBridgeActive) {
                await sock.sendMessage(from, { text: '⚠️ Bridge is already active!' });
                return;
            }
            
            await sock.sendMessage(from, { text: '🔄 Starting Telegram bridge...' });
            const success = await startTelegramBridge();
            
            if (success) {
                await sock.sendMessage(from, { 
                    text: `✅ *Telegram Bridge Active*\n\n` +
                        `👥 ALL = ${WHATSAPP_GROUPS.length} groups\n` +
                        `📱 Forward to: ${WHATSAPP_NUMBER}\n\n` +
                        `Send any message to your Telegram bot to forward!`
                });
            } else {
                await sock.sendMessage(from, { text: '❌ Failed to start Telegram bridge' });
            }
        }
        else if (userMessage === '.tg off') {
            if (!isTelegramBridgeActive) {
                await sock.sendMessage(from, { text: '⚠️ Bridge is not active!' });
                return;
            }
            
            await sock.sendMessage(from, { text: '🔴 Stopping Telegram bridge...' });
            await stopTelegramBridge();
            await sock.sendMessage(from, { text: '🔴 *Telegram Bridge Stopped*' });
        }
        
        // ===== HELP COMMAND =====
        else if (userMessage === '.help' || userMessage === '.menu') {
            const helpText = `*Available Commands:*\n\n` +
                `• .ping - Test bot response\n` +
                `• .tg - Show bridge status\n` +
                `• .tg on - Start Telegram bridge\n` +
                `• .tg off - Stop Telegram bridge\n` +
                `• .help - Show this menu\n\n` +
                `*Telegram Bridge:*\n` +
                `Send messages to your Telegram bot, then choose where to forward them!\n` +
                `• 👥 ALL GROUPS - Forward to all configured WhatsApp groups\n` +
                `• 📱 Own Chat - Forward only to your personal WhatsApp`;
            
            await sock.sendMessage(from, { text: helpText });
        }
    });
}

// ===== START THE BOT =====
startBot().catch(err => {
    log('ERROR', 'Fatal error starting bot', err.message);
});

// Handle graceful shutdown
process.on('SIGINT', async () => {
    log('INFO', 'Shutting down...');
    await stopTelegramBridge();
    process.exit(0);
});

process.on('SIGTERM', async () => {
    log('INFO', 'Shutting down...');
    await stopTelegramBridge();
    process.exit(0);
});
