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
const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { NewMessage } = require('telegram/events');
const { Telegraf } = require('telegraf');
const axios = require("axios");
const path = require("path");
const fs = require('fs');
const sharp = require('sharp');

// ===== CONFIGURATION =====
const API_ID = 32086282;
const API_HASH = "064a66fe7097452e6ac8f4e8df28aa97";
const TELEGRAM_BOT_TOKEN = "8717510346:AAFi_8U7L0KCh13UzEu69EGc7j8qDteyu70";
const BOT_ID = "8717510346";

// WhatsApp targets
const WHATSAPP_NUMBER = "923247220362";
const WHATSAPP_GROUPS = [
    "120363140590753276@g.us",
    "120363162260844407@g.us",
    "120363042237526273@g.us",
    "120363023394033137@g.us",
    "120363161222427319@g.us"
];
const WHATSAPP_CHANNEL = "120363405181626845@newsletter";
const TELEGRAM_CHANNEL_ID = "-100128798079"; // Use string format

// ===== CONSTANTS =====
const TEMP_DIR = path.join(process.cwd(), 'temp');
const RATE_LIMIT_DELAY = 3000;

// ===== STATE =====
let telegramClient = null;
let isActive = false;
let connectionReady = false;
let telegramBot = null;
let whatsappSock = null;
let keepAliveInterval = null;
const pendingMessages = new Map();

// Create temp directory
if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });

// ===== LOGGING =====
function logError(message, error = null) {
    const timestamp = new Date().toISOString();
    console.error(`[${timestamp}] [ERROR] ${message}`);
    if (error) console.error(error);
}

function log(level, msg, data) {
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] [${level}] ${msg}`);
    if (data) console.log(JSON.stringify(data, null, 2));
}

// ===== HELPER FUNCTIONS =====
async function generateThumbnail(buffer) {
    try {
        const thumbnail = await sharp(buffer)
            .resize(200, 200, { fit: 'inside' })
            .jpeg({ quality: 70 })
            .toBuffer();
        return thumbnail;
    } catch (err) {
        return null;
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
        } catch (err) {}
    }, 30000);
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
        
        for (let attempt = 1; attempt <= 3; attempt++) {
            try {
                const tempFile = path.join(TEMP_DIR, `tg_${message.id}_${Date.now()}_${attempt}.tmp`);
                
                if (!fs.existsSync(TEMP_DIR)) {
                    fs.mkdirSync(TEMP_DIR, { recursive: true });
                }
                
                await client.downloadMedia(message, { outputFile: tempFile });
                
                if (!fs.existsSync(tempFile)) throw new Error('File not created');
                
                const stats = fs.statSync(tempFile);
                if (stats.size === 0) throw new Error('File is empty');
                
                const buffer = fs.readFileSync(tempFile);
                fs.unlinkSync(tempFile);
                
                // Determine MIME type and format
                let mimeType = 'application/octet-stream';
                let extension = 'bin';
                
                if (message.photo) {
                    mimeType = 'image/jpeg';
                    extension = 'jpg';
                } else if (message.video) {
                    mimeType = 'video/mp4';
                    extension = 'mp4';
                } else if (message.document) {
                    mimeType = message.document.mimeType || 'application/octet-stream';
                    const attr = message.document.attributes.find(a => a.className === 'DocumentAttributeFilename');
                    extension = attr?.fileName?.split('.').pop() || 'bin';
                } else if (message.audio) {
                    mimeType = message.audio.mimeType || 'audio/mpeg';
                    extension = 'mp3';
                } else if (message.voice) {
                    mimeType = 'audio/ogg';
                    extension = 'ogg';
                }
                
                return {
                    buffer,
                    size: stats.size,
                    mimeType,
                    extension
                };
                
            } catch (err) {
                try {
                    const tempFile = path.join(TEMP_DIR, `tg_${message.id}_attempt_${attempt}`);
                    if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
                } catch (cleanupError) {}
                
                if (attempt < 3) await new Promise(resolve => setTimeout(resolve, attempt * 2000));
            }
        }
        return null;
    } catch (error) {
        return null;
    }
}

// ===== FORWARDING FUNCTIONS =====
async function sendToWhatsAppChannel(messageData) {
    try {
        if (!whatsappSock) return false;
        
        if (messageData.type === 'text') {
            await whatsappSock.sendMessage(WHATSAPP_CHANNEL, { text: messageData.content });
        } else if (messageData.type === 'media') {
            const mediaBuffer = messageData.buffer;
            const mediaCaption = messageData.caption || '';
            
            // Generate thumbnail for images
            let thumbnail = null;
            if (messageData.mediaType === 'photo') {
                thumbnail = await generateThumbnail(mediaBuffer);
            }
            
            const messageOptions = {
                [messageData.mediaType === 'photo' ? 'image' : 
                 messageData.mediaType === 'video' ? 'video' : 'document']: mediaBuffer,
                caption: mediaCaption
            };
            
            if (thumbnail && messageData.mediaType === 'photo') {
                messageOptions.jpegThumbnail = thumbnail;
            }
            
            await whatsappSock.sendMessage(WHATSAPP_CHANNEL, messageOptions);
        }
        log('INFO', `Sent to WhatsApp channel: ${WHATSAPP_CHANNEL}`);
        return true;
    } catch (error) {
        logError('sendToWhatsAppChannel failed', error);
        return false;
    }
}

async function sendToTelegramChannel(messageData) {
    try {
        if (!telegramClient || !telegramClient.connected) return false;
        
        // Try to resolve channel entity first
        let channelEntity;
        try {
            channelEntity = await telegramClient.getEntity(TELEGRAM_CHANNEL_ID);
        } catch (err) {
            logError('Cannot access Telegram channel - bot might not be admin', err);
            return false;
        }
        
        if (messageData.type === 'text') {
            await telegramClient.sendMessage(channelEntity, { message: messageData.content });
        } else if (messageData.type === 'media') {
            const mediaBuffer = messageData.buffer;
            const caption = messageData.caption || '';
            
            if (messageData.mediaType === 'photo') {
                await telegramClient.sendFile(channelEntity, { file: mediaBuffer, caption: caption });
            } else if (messageData.mediaType === 'video') {
                await telegramClient.sendFile(channelEntity, { file: mediaBuffer, caption: caption });
            } else {
                await telegramClient.sendFile(channelEntity, { 
                    file: mediaBuffer, 
                    caption: caption,
                    fileName: messageData.fileName 
                });
            }
        }
        log('INFO', `Sent to Telegram channel: ${TELEGRAM_CHANNEL_ID}`);
        return true;
    } catch (error) {
        logError('sendToTelegramChannel failed', error);
        return false;
    }
}

async function sendToAllGroups(messageData) {
    try {
        if (!whatsappSock) return false;
        
        let successCount = 0;
        
        for (let i = 0; i < WHATSAPP_GROUPS.length; i++) {
            const target = WHATSAPP_GROUPS[i];
            try {
                if (messageData.type === 'text') {
                    await whatsappSock.sendMessage(target, { text: messageData.content });
                    successCount++;
                } else if (messageData.type === 'media') {
                    let thumbnail = null;
                    if (messageData.mediaType === 'photo') {
                        thumbnail = await generateThumbnail(messageData.buffer);
                    }
                    
                    const messageOptions = {
                        [messageData.mediaType === 'photo' ? 'image' : 
                         messageData.mediaType === 'video' ? 'video' : 'document']: messageData.buffer,
                        caption: messageData.caption || ''
                    };
                    
                    if (thumbnail && messageData.mediaType === 'photo') {
                        messageOptions.jpegThumbnail = thumbnail;
                    }
                    
                    await whatsappSock.sendMessage(target, messageOptions);
                    successCount++;
                }
                
                if (i < WHATSAPP_GROUPS.length - 1) {
                    await new Promise(resolve => setTimeout(resolve, RATE_LIMIT_DELAY));
                }
            } catch (err) {
                logError(`Failed to send to group ${target}`, err);
            }
        }
        
        log('INFO', `Sent to ${successCount}/${WHATSAPP_GROUPS.length} WhatsApp groups`);
        return successCount > 0;
    } catch (error) {
        logError('sendToAllGroups failed', error);
        return false;
    }
}

async function sendToOwnChat(messageData) {
    try {
        if (!whatsappSock) return false;
        
        const jid = WHATSAPP_NUMBER.includes('@') ? WHATSAPP_NUMBER : `${WHATSAPP_NUMBER}@s.whatsapp.net`;
        
        if (messageData.type === 'text') {
            await whatsappSock.sendMessage(jid, { text: messageData.content });
        } else if (messageData.type === 'media') {
            let thumbnail = null;
            if (messageData.mediaType === 'photo') {
                thumbnail = await generateThumbnail(messageData.buffer);
            }
            
            const messageOptions = {
                [messageData.mediaType === 'photo' ? 'image' : 
                 messageData.mediaType === 'video' ? 'video' : 'document']: messageData.buffer,
                caption: messageData.caption || ''
            };
            
            if (thumbnail && messageData.mediaType === 'photo') {
                messageOptions.jpegThumbnail = thumbnail;
            }
            
            await whatsappSock.sendMessage(jid, messageOptions);
        }
        log('INFO', `Sent to own chat: ${WHATSAPP_NUMBER}`);
        return true;
    } catch (error) {
        logError('sendToOwnChat failed', error);
        return false;
    }
}

async function sendToAllDestinations(messageData) {
    try {
        let allSuccess = true;
        
        if (!await sendToWhatsAppChannel(messageData)) allSuccess = false;
        await new Promise(resolve => setTimeout(resolve, 2000));
        
        if (!await sendToTelegramChannel(messageData)) allSuccess = false;
        await new Promise(resolve => setTimeout(resolve, 2000));
        
        if (!await sendToAllGroups(messageData)) allSuccess = false;
        await new Promise(resolve => setTimeout(resolve, 2000));
        
        if (!await sendToOwnChat(messageData)) allSuccess = false;
        
        return allSuccess;
    } catch (error) {
        logError('sendToAllDestinations failed', error);
        return false;
    }
}

function initTelegramBot() {
    telegramBot = new Telegraf(TELEGRAM_BOT_TOKEN);
    
    telegramBot.command('start', (ctx) => {
        const helpMessage = 
            `🤖 *WhatsApp Forwarder Bot*\n\n` +
            `Send any message here and choose where to forward it.\n\n` +
            `*Options:*\n` +
            `• 📺 *WhatsApp Channel* - Send to WhatsApp channel\n` +
            `• 🌐 *Telegram Channel* - Send to Telegram channel\n` +
            `• 👥 *ALL GROUPS* - Send to ${WHATSAPP_GROUPS.length} groups\n` +
            `• 📱 *Own Chat* - Send only to your WhatsApp\n` +
            `• 🌟 *ALL* - Send to all destinations\n` +
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
            
            if (target === 'channel') {
                success = await sendToWhatsAppChannel(messageData);
                targetText = 'WhatsApp channel';
            } else if (target === 'telegram') {
                success = await sendToTelegramChannel(messageData);
                targetText = 'Telegram channel';
            } else if (target === 'groups') {
                success = await sendToAllGroups(messageData);
                targetText = `${WHATSAPP_GROUPS.length} groups`;
            } else if (target === 'own') {
                success = await sendToOwnChat(messageData);
                targetText = 'your chat';
            } else if (target === 'all') {
                success = await sendToAllDestinations(messageData);
                targetText = 'ALL destinations';
            }
            
            if (success) {
                await ctx.editMessageText(`✅ Successfully forwarded to ${targetText}`);
            } else {
                await ctx.editMessageText('❌ Failed to forward. Make sure bot has permissions.');
            }
        } catch (error) {
            logError('Callback query error', error);
            try {
                await ctx.editMessageText('❌ Error processing request.');
            } catch (e) {}
        }
    });
    
    telegramBot.launch().catch((err) => logError('Telegram bot launch failed', err));
}

// ===== MAIN BOT FUNCTION =====
async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState("session");
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version,
        logger: pino({ level: "silent" }),
        auth: state,
    });

    whatsappSock = sock;

    sock.ev.on("connection.update", (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (qr) qrcode.generate(qr, { small: true });
        if (connection === "close") {
            const shouldReconnect = (lastDisconnect.error instanceof Boom)?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log("Connection closed, reconnecting:", shouldReconnect);
            if (shouldReconnect) startBot();
        } else if (connection === "open") {
            console.log("\n✅✅✅ BOT CONNECTED SUCCESSFULLY! ✅✅✅");
            console.log(`📱 WhatsApp Number: ${WHATSAPP_NUMBER}`);
            console.log(`👥 Groups: ${WHATSAPP_GROUPS.length} groups configured`);
            console.log(`📺 WhatsApp Channel: ${WHATSAPP_CHANNEL}`);
            console.log(`🌐 Telegram Channel: ${TELEGRAM_CHANNEL_ID}`);
            console.log("📱 Commands: .tg [on|off|status] - Manage Telegram bridge");
            console.log("           .ping - Test bot response");
            console.log("⚠️ Bot will ONLY respond in PRIVATE chats (not in groups)\n");
            
            setTimeout(() => {
                if (!isActive) {
                    console.log('🔄 Auto-starting Telegram bridge...');
                    startTelegramBridge();
                }
            }, 3000);
        }
    });

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("messages.upsert", async (m) => {
        const msg = m.messages[0];
        if (!msg.message || msg.key.fromMe) return;

        const from = msg.key.remoteJid;
        
        // IGNORE GROUP MESSAGES COMPLETELY
        if (from.includes('@g.us')) return;
        
        let text = '';
        if (msg.message?.conversation) text = msg.message.conversation;
        else if (msg.message?.extendedTextMessage?.text) text = msg.message.extendedTextMessage.text;
        else if (msg.message?.imageMessage?.caption) text = msg.message.imageMessage.caption;
        else if (msg.message?.videoMessage?.caption) text = msg.message.videoMessage.caption;
        else return;

        const userMessage = text.toLowerCase().trim();
        console.log(`[PRIVATE] ${from}: ${text}`);

        if (userMessage === '.ping') {
            await sock.sendMessage(from, { text: 'pong 🏓' });
        }
        else if (userMessage === '.tg' || userMessage === '.tg status') {
            const statusText = `🤖 *Telegram Bridge Status*\n\n` +
                `Active: ${isActive ? '✅' : '❌'}\n` +
                `WhatsApp: ${WHATSAPP_NUMBER}\n` +
                `Groups: ${WHATSAPP_GROUPS.length}\n` +
                `WhatsApp Channel: ${WHATSAPP_CHANNEL}\n` +
                `Telegram Channel: ${TELEGRAM_CHANNEL_ID}\n\n` +
                `*Commands:*\n` +
                `• .tg on - Start bridge\n` +
                `• .tg off - Stop bridge\n` +
                `• .tg status - Show status`;
            await sock.sendMessage(from, { text: statusText });
        }
        else if (userMessage === '.tg on') {
            if (isActive) {
                await sock.sendMessage(from, { text: '⚠️ Bridge is already active!' });
                return;
            }
            await sock.sendMessage(from, { text: '🔄 Starting Telegram bridge...' });
            await startTelegramBridge();
            if (isActive) {
                await sock.sendMessage(from, { 
                    text: `✅ *Telegram Bridge Active*\n\n` +
                        `📺 WhatsApp Channel\n` +
                        `🌐 Telegram Channel\n` +
                        `👥 ${WHATSAPP_GROUPS.length} groups\n` +
                        `📱 Own chat\n` +
                        `🌟 ALL destinations\n\n` +
                        `Send any message to your Telegram bot to forward!`
                });
            } else {
                await sock.sendMessage(from, { text: '❌ Failed to start Telegram bridge' });
            }
        }
        else if (userMessage === '.tg off') {
            if (!isActive) {
                await sock.sendMessage(from, { text: '⚠️ Bridge is not active!' });
                return;
            }
            await sock.sendMessage(from, { text: '🔴 Stopping Telegram bridge...' });
            await stopTelegramBridge();
            await sock.sendMessage(from, { text: '🔴 *Telegram Bridge Stopped*' });
        }
        else if (userMessage === '.help' || userMessage === '.menu') {
            const helpText = `*Available Commands:*\n\n` +
                `• .ping - Test bot response\n` +
                `• .tg - Show bridge status\n` +
                `• .tg on - Start Telegram bridge\n` +
                `• .tg off - Stop Telegram bridge\n` +
                `• .help - Show this menu\n\n` +
                `*Telegram Bridge Options:*\n` +
                `📺 WhatsApp Channel\n` +
                `🌐 Telegram Channel\n` +
                `👥 ${WHATSAPP_GROUPS.length} Groups\n` +
                `📱 Own Chat\n` +
                `🌟 ALL Destinations\n\n` +
                `*Note:* Bot only responds in private chats.`;
            await sock.sendMessage(from, { text: helpText });
        }
    });
}

async function startTelegramBridge() {
    if (isActive) return true;
    
    try {
        if (telegramClient) {
            await telegramClient.disconnect();
            telegramClient = null;
        }
        
        telegramClient = new TelegramClient(new StringSession(""), API_ID, API_HASH, {
            connectionRetries: 5,
            downloadRetries: 3,
            deviceModel: "Desktop",
            systemVersion: "Windows 10",
            appVersion: "1.0.0"
        });
        
        await telegramClient.start({ botAuthToken: TELEGRAM_BOT_TOKEN });
        
        if (!telegramBot) initTelegramBot();
        
        startKeepAlive();
        await new Promise(resolve => setTimeout(resolve, 2000));
        connectionReady = true;
        
        async function messageHandler(event) {
            try {
                const msg = event.message;
                if (!msg) return;
                
                let senderId = null;
                if (msg.fromId) {
                    if (msg.fromId.userId) senderId = msg.fromId.userId.toString();
                    else if (msg.fromId.value) senderId = msg.fromId.value.toString();
                }
                
                if (senderId === BOT_ID) return;
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
                            fileName = attr?.fileName || `file_${msg.id}.${mediaResult.extension || 'bin'}`;
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
                
                const pendingKey = `${chatId}_${msg.id}`;
                pendingMessages.set(pendingKey, messageData);
                
                // Cleanup old messages (5 minutes)
                const now = Date.now();
                for (const [key, data] of pendingMessages.entries()) {
                    if (now - data.timestamp > 300000) pendingMessages.delete(key);
                }
                
                const previewText = formattedText.length > 100 ? formattedText.substring(0, 100) + '...' : formattedText || '[No text]';
                const fileSizeInfo = messageData.type === 'media' ? ` (${(messageData.size / 1024 / 1024).toFixed(2)}MB)` : '';
                
                const confirmationMessage = `📨 New Message\n\nPreview: ${previewText}${fileSizeInfo}\n\nForward to?`;
                
                await telegramBot.telegram.sendMessage(parseInt(chatId), confirmationMessage, {
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: `📺 WhatsApp Channel`, callback_data: `confirm_${msg.id}_channel` }],
                            [{ text: `🌐 Telegram Channel`, callback_data: `confirm_${msg.id}_telegram` }],
                            [{ text: `👥 ALL GROUPS (${WHATSAPP_GROUPS.length})`, callback_data: `confirm_${msg.id}_groups` }],
                            [{ text: `📱 Own Chat`, callback_data: `confirm_${msg.id}_own` }],
                            [{ text: `🌟 ALL DESTINATIONS`, callback_data: `confirm_${msg.id}_all` }],
                            [{ text: `❌ Cancel`, callback_data: `confirm_${msg.id}_cancel` }]
                        ]
                    }
                });
                
                log('INFO', `Forward request sent for message ${msg.id}`);
            } catch (err) {
                logError('Message handler error', err);
            }
        }
        
        telegramClient.addEventHandler(messageHandler, new NewMessage({}));
        isActive = true;
        console.log('✅ Telegram bridge started successfully');
        return true;
        
    } catch (error) {
        logError('Failed to start bridge', error);
        isActive = false;
        return false;
    }
}

async function stopTelegramBridge() {
    if (!isActive) return;
    
    try {
        if (telegramClient) {
            await telegramClient.disconnect();
            telegramClient = null;
        }
        if (keepAliveInterval) {
            clearInterval(keepAliveInterval);
            keepAliveInterval = null;
        }
        isActive = false;
        connectionReady = false;
        pendingMessages.clear();
        console.log('✅ Telegram bridge stopped');
    } catch (error) {
        logError('Error stopping bridge', error);
    }
}

// Graceful shutdown
process.on('SIGINT', async () => {
    console.log('\n🛑 Shutting down...');
    await stopTelegramBridge();
    process.exit(0);
});

process.on('SIGTERM', async () => {
    console.log('\n🛑 Shutting down...');
    await stopTelegramBridge();
    process.exit(0);
});

startBot().catch(err => {
    console.error('Fatal error:', err);
});
