const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion
} = require("@whiskeysockets/baileys");
const pino = require("pino");
const { Boom } = require("@hapi/boom");
const qrcode = require("qrcode-terminal");
const { Telegraf } = require('telegraf');
const TelegramBot = require('node-telegram-bot-api');
const path = require("path");
const fs = require('fs');
const sharp = require('sharp');
const axios = require('axios');

// ===== CONFIGURATION =====
const TELEGRAM_BOT_TOKEN = "8717510346:AAFi_8U7L0KCh13UzEu69EGc7j8qDteyu70";
const TELEGRAM_CHANNEL_ID = "-1001287988079";

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

// ===== CONSTANTS =====
const TEMP_DIR = path.join(process.cwd(), 'temp');
const RATE_LIMIT_DELAY = 3000;

// ===== STATE =====
let telegrafBot = null;
let sendBot = null;
let whatsappSock = null;
let isTelegramActive = false;
const pendingMessages = new Map();

// Create temp directory
if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });

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

function cleanWhitespace(text) {
    if (!text) return text;
    text = text.replace(/[ \t]+/g, ' ');
    text = text.replace(/\n{3,}/g, '\n\n');
    return text.trim();
}

// Escape HTML special characters except for our allowed tags
function escapeHtml(text) {
    if (!text) return text;
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

// Apply formatting with proper HTML escaping
function applyFormatting(text, entities) {
    if (!text) return '';
    
    // If no entities, just escape the text
    if (!entities || entities.length === 0) {
        return escapeHtml(text);
    }
    
    // Sort entities by offset (descending) to apply from end to start
    const sortedEntities = [...entities].sort((a, b) => b.offset - a.offset);
    let result = escapeHtml(text);
    
    // Allowed HTML tags mapping
    const entityTags = {
        'bold': { open: '<b>', close: '</b>' },
        'italic': { open: '<i>', close: '</i>' },
        'underline': { open: '<u>', close: '</u>' },
        'strikethrough': { open: '<s>', close: '</s>' },
        'spoiler': { open: '<tg-spoiler>', close: '</tg-spoiler>' },
        'code': { open: '<code>', close: '</code>' },
        'pre': { open: '<pre>', close: '</pre>' },
        'text_link': { open: (e) => `<a href="${escapeHtml(e.url)}">`, close: '</a>' }
    };
    
    for (const entity of sortedEntities) {
        const entityType = entity.type;
        if (!entityTags[entityType]) continue;
        
        let startTag, endTag;
        if (typeof entityTags[entityType].open === 'function') {
            startTag = entityTags[entityType].open(entity);
        } else {
            startTag = entityTags[entityType].open;
        }
        endTag = entityTags[entityType].close;
        
        const start = entity.offset;
        const end = start + entity.length;
        
        // Validate bounds
        if (start < 0 || end > result.length || start >= end) continue;
        
        // Extract content
        let content = result.substring(start, end);
        
        // Apply formatting
        result = result.substring(0, start) + startTag + content + endTag + result.substring(end);
    }
    
    // Handle manual blockquotes (lines starting with >)
    if (result.includes('&gt;')) {
        result = result.replace(/&gt;/g, '>');
        const lines = result.split('\n');
        const formattedLines = [];
        let inBlockquote = false;
        
        for (const line of lines) {
            const trimmedLine = line.trimStart();
            if (trimmedLine.startsWith('>')) {
                if (!inBlockquote) {
                    formattedLines.push('<blockquote>');
                    inBlockquote = true;
                }
                // Remove the '>' character and trim
                const contentLine = trimmedLine.substring(1).trimStart();
                formattedLines.push(contentLine);
            } else {
                if (inBlockquote) {
                    formattedLines.push('</blockquote>');
                    inBlockquote = false;
                }
                formattedLines.push(line);
            }
        }
        
        if (inBlockquote) {
            formattedLines.push('</blockquote>');
        }
        
        result = formattedLines.join('\n');
    }
    
    // Re-escape any HTML that might have been introduced by the content
    // But preserve our allowed tags
    const allowedTags = ['b', 'i', 'u', 's', 'code', 'pre', 'a', 'tg-spoiler', 'blockquote'];
    
    // Temporarily protect our tags
    const protected = [];
    let protectedResult = result;
    for (let i = 0; i < allowedTags.length; i++) {
        const tag = allowedTags[i];
        const openPattern = new RegExp(`<${tag}([^>]*)>`, 'g');
        const closePattern = new RegExp(`</${tag}>`, 'g');
        
        protectedResult = protectedResult.replace(openPattern, (match) => {
            protected.push(match);
            return `__PROTECTED_OPEN_${i}_${protected.length - 1}__`;
        });
        protectedResult = protectedResult.replace(closePattern, (match) => {
            protected.push(match);
            return `__PROTECTED_CLOSE_${i}_${protected.length - 1}__`;
        });
    }
    
    // Escape any remaining HTML
    protectedResult = escapeHtml(protectedResult);
    
    // Restore protected tags
    for (let i = protected.length - 1; i >= 0; i--) {
        protectedResult = protectedResult.replace(`__PROTECTED_OPEN_${allowedTags.length}_${i}__`, protected[i]);
        protectedResult = protectedResult.replace(`__PROTECTED_CLOSE_${allowedTags.length}_${i}__`, protected[i]);
    }
    
    return protectedResult;
}

// Convert Telegram entities to WhatsApp format
function entitiesToWhatsApp(text, entities) {
    if (!text) return text;
    
    let cleanText = text;
    cleanText = cleanText.replace(/\*\*/g, '');
    cleanText = cleanText.replace(/__/g, '');
    cleanText = cleanText.replace(/~~/g, '');
    cleanText = cleanText.replace(/`/g, '');
    
    if (!entities || entities.length === 0) {
        let formatted = cleanText;
        formatted = formatted.replace(/\*\*(.*?)\*\*/g, '*$1*');
        formatted = formatted.replace(/__(.*?)__/g, '_$1_');
        formatted = formatted.replace(/~~(.*?)~~/g, '~$1~');
        formatted = formatted.replace(/`(.*?)`/g, '```$1```');
        return cleanWhitespace(formatted);
    }
    
    const sortedEntities = [...entities].sort((a, b) => b.offset - a.offset);
    let textArray = cleanText.split('');
    
    for (const entity of sortedEntities) {
        const start = entity.offset;
        const end = start + entity.length;
        if (start >= textArray.length || end > textArray.length) continue;
        
        const content = cleanText.substring(start, end);
        
        let prefix = '', suffix = '';
        switch (entity.type) {
            case 'bold': prefix = '*'; suffix = '*'; break;
            case 'italic': prefix = '_'; suffix = '_'; break;
            case 'strikethrough': prefix = '~'; suffix = '~'; break;
            case 'code': prefix = '```'; suffix = '```'; break;
            case 'pre': prefix = '```\n'; suffix = '\n```'; break;
            default: continue;
        }
        
        let replacement;
        if (entity.type === 'pre') {
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

// ===== FORWARDING FUNCTIONS =====
async function sendToWhatsAppChannel(messageData) {
    try {
        if (!whatsappSock) return false;
        
        if (messageData.type === 'text') {
            await whatsappSock.sendMessage(WHATSAPP_CHANNEL, { text: messageData.content });
        } else if (messageData.type === 'media') {
            const mediaBuffer = messageData.buffer;
            const mediaCaption = messageData.caption || '';
            
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
        console.log(`✅ Sent to WhatsApp channel`);
        return true;
    } catch (error) {
        console.error(`❌ Failed to send to WhatsApp channel:`, error.message);
        return false;
    }
}

async function sendToTelegramChannel(messageData) {
    try {
        if (!sendBot) return false;
        
        if (messageData.type === 'text') {
            const formattedText = applyFormatting(messageData.originalText, messageData.entities);
            
            // Validate that formatted text doesn't contain invalid HTML
            if (formattedText && formattedText.length > 0) {
                await sendBot.sendMessage(TELEGRAM_CHANNEL_ID, formattedText, {
                    parse_mode: 'HTML',
                    disable_web_page_preview: true
                });
                console.log(`✅ Text sent to Telegram channel`);
            }
        } else if (messageData.type === 'media') {
            const caption = messageData.originalCaption || '';
            const formattedCaption = applyFormatting(caption, messageData.captionEntities);
            
            const mediaBuffer = messageData.buffer;
            const ext = messageData.mediaType === 'photo' ? 'jpg' : 
                       messageData.mediaType === 'video' ? 'mp4' : 'bin';
            const tempFilePath = path.join(TEMP_DIR, `send_tg_${Date.now()}.${ext}`);
            fs.writeFileSync(tempFilePath, mediaBuffer);
            
            try {
                if (messageData.mediaType === 'photo') {
                    await sendBot.sendPhoto(TELEGRAM_CHANNEL_ID, tempFilePath, {
                        caption: formattedCaption,
                        parse_mode: 'HTML'
                    });
                } else if (messageData.mediaType === 'video') {
                    await sendBot.sendVideo(TELEGRAM_CHANNEL_ID, tempFilePath, {
                        caption: formattedCaption,
                        parse_mode: 'HTML'
                    });
                } else {
                    await sendBot.sendDocument(TELEGRAM_CHANNEL_ID, tempFilePath, {
                        caption: formattedCaption,
                        parse_mode: 'HTML'
                    });
                }
                console.log(`✅ ${messageData.mediaType} sent to Telegram channel`);
            } finally {
                if (fs.existsSync(tempFilePath)) fs.unlinkSync(tempFilePath);
            }
        }
        return true;
    } catch (error) {
        console.error(`❌ Failed to send to Telegram channel:`, error.message);
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
                console.error(`Failed to send to group:`, err.message);
            }
        }
        
        console.log(`✅ Sent to ${successCount}/${WHATSAPP_GROUPS.length} WhatsApp groups`);
        return successCount > 0;
    } catch (error) {
        console.error(`Failed to send to groups:`, error.message);
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
        console.log(`✅ Sent to own chat`);
        return true;
    } catch (error) {
        console.error(`Failed to send to own chat:`, error.message);
        return false;
    }
}

async function sendToAllDestinations(messageData) {
    let allSuccess = true;
    
    if (!await sendToWhatsAppChannel(messageData)) allSuccess = false;
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    if (!await sendToTelegramChannel(messageData)) allSuccess = false;
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    if (!await sendToAllGroups(messageData)) allSuccess = false;
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    if (!await sendToOwnChat(messageData)) allSuccess = false;
    
    return allSuccess;
}

// ===== TELEGRAM BOT HANDLER =====
function initTelegramBot() {
    sendBot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: false });
    telegrafBot = new Telegraf(TELEGRAM_BOT_TOKEN);
    
    console.log('🤖 Telegram Bot Started!');
    console.log(`📢 Forwarding to channel: ${TELEGRAM_CHANNEL_ID}`);
    console.log(`👥 Groups: ${WHATSAPP_GROUPS.length} groups configured`);
    console.log(`📺 WhatsApp Channel: ${WHATSAPP_CHANNEL}`);
    console.log('✅ Bot is ready!\n');
    
    telegrafBot.command('start', (ctx) => {
        const helpMessage = 
            `🤖 *WhatsApp Forwarder Bot*\n\n` +
            `Send any message here and choose where to forward it.\n\n` +
            `*Options after sending:*\n` +
            `• 📺 *WhatsApp Channel* - Send to WhatsApp channel\n` +
            `• 🌐 *Telegram Channel* - Send to Telegram channel\n` +
            `• 👥 *ALL GROUPS* - Send to ${WHATSAPP_GROUPS.length} groups\n` +
            `• 📱 *Own Chat* - Send only to your WhatsApp\n` +
            `• 🌟 *ALL* - Send to all destinations\n` +
            `• ❌ *Cancel* - Don't forward`;
        
        ctx.reply(helpMessage, { parse_mode: 'Markdown' });
    });
    
    telegrafBot.on('text', async (ctx) => {
        const message = ctx.message;
        const originalText = message.text;
        const entities = message.entities || [];
        
        console.log(`\n📝 Text from ${ctx.from.username || ctx.from.id}`);
        console.log(`Entities: ${entities.length}`);
        
        // Filter and adjust entities
        const filteredEntities = [];
        for (const entity of entities) {
            const allowedTypes = ['bold', 'italic', 'underline', 'strikethrough', 'code', 'pre', 'text_link', 'spoiler'];
            if (allowedTypes.includes(entity.type)) {
                filteredEntities.push({
                    type: entity.type,
                    offset: entity.offset,
                    length: entity.length,
                    url: entity.url
                });
            }
        }
        
        const formattedForWhatsApp = entitiesToWhatsApp(originalText, filteredEntities);
        
        const uniqueId = `${ctx.chat.id}_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
        
        pendingMessages.set(uniqueId, {
            type: 'text',
            content: formattedForWhatsApp,
            originalText: originalText,
            entities: filteredEntities,
            timestamp: Date.now()
        });
        
        const opts = {
            reply_markup: {
                inline_keyboard: [
                    [{ text: `📺 WhatsApp Channel`, callback_data: `${uniqueId}_channel` }],
                    [{ text: `🌐 Telegram Channel`, callback_data: `${uniqueId}_telegram` }],
                    [{ text: `👥 ALL GROUPS (${WHATSAPP_GROUPS.length})`, callback_data: `${uniqueId}_groups` }],
                    [{ text: `📱 Own Chat`, callback_data: `${uniqueId}_own` }],
                    [{ text: `🌟 ALL DESTINATIONS`, callback_data: `${uniqueId}_all` }],
                    [{ text: `❌ Cancel`, callback_data: `${uniqueId}_cancel` }]
                ]
            }
        };
        
        await ctx.reply(`📨 New Message\n\nPreview: ${originalText.substring(0, 100)}${originalText.length > 100 ? '...' : ''}\n\nForward to?`, opts);
    });
    
    telegrafBot.on('photo', async (ctx) => {
        const message = ctx.message;
        const caption = message.caption || '';
        const entities = message.caption_entities || [];
        const photo = message.photo[message.photo.length - 1];
        
        console.log(`\n📸 Photo from ${ctx.from.username || ctx.from.id}`);
        console.log(`Entities: ${entities.length}`);
        
        try {
            const fileLink = await ctx.telegram.getFileLink(photo.file_id);
            const response = await axios.get(fileLink, { responseType: 'arraybuffer' });
            const buffer = Buffer.from(response.data);
            
            // Filter entities
            const filteredEntities = [];
            for (const entity of entities) {
                const allowedTypes = ['bold', 'italic', 'underline', 'strikethrough', 'code', 'pre', 'text_link', 'spoiler'];
                if (allowedTypes.includes(entity.type)) {
                    filteredEntities.push({
                        type: entity.type,
                        offset: entity.offset,
                        length: entity.length,
                        url: entity.url
                    });
                }
            }
            
            const formattedCaption = entitiesToWhatsApp(caption, filteredEntities);
            
            const uniqueId = `${ctx.chat.id}_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
            
            pendingMessages.set(uniqueId, {
                type: 'media',
                mediaType: 'photo',
                buffer: buffer,
                size: buffer.length,
                caption: formattedCaption,
                originalCaption: caption,
                captionEntities: filteredEntities,
                timestamp: Date.now()
            });
            
            const opts = {
                reply_markup: {
                    inline_keyboard: [
                        [{ text: `📺 WhatsApp Channel`, callback_data: `${uniqueId}_channel` }],
                        [{ text: `🌐 Telegram Channel`, callback_data: `${uniqueId}_telegram` }],
                        [{ text: `👥 ALL GROUPS (${WHATSAPP_GROUPS.length})`, callback_data: `${uniqueId}_groups` }],
                        [{ text: `📱 Own Chat`, callback_data: `${uniqueId}_own` }],
                        [{ text: `🌟 ALL DESTINATIONS`, callback_data: `${uniqueId}_all` }],
                        [{ text: `❌ Cancel`, callback_data: `${uniqueId}_cancel` }]
                    ]
                }
            };
            
            await ctx.reply(`📨 New Photo\n\nCaption: ${caption.substring(0, 100)}${caption.length > 100 ? '...' : ''}\n\nForward to?`, opts);
        } catch (error) {
            console.error('Error processing photo:', error.message);
            await ctx.reply('❌ Failed to process image.');
        }
    });
    
    telegrafBot.on('video', async (ctx) => {
        const message = ctx.message;
        const caption = message.caption || '';
        const entities = message.caption_entities || [];
        const video = message.video;
        
        console.log(`\n🎥 Video from ${ctx.from.username || ctx.from.id}`);
        console.log(`Entities: ${entities.length}`);
        
        try {
            const fileLink = await ctx.telegram.getFileLink(video.file_id);
            const response = await axios.get(fileLink, { responseType: 'arraybuffer' });
            const buffer = Buffer.from(response.data);
            
            // Filter entities
            const filteredEntities = [];
            for (const entity of entities) {
                const allowedTypes = ['bold', 'italic', 'underline', 'strikethrough', 'code', 'pre', 'text_link', 'spoiler'];
                if (allowedTypes.includes(entity.type)) {
                    filteredEntities.push({
                        type: entity.type,
                        offset: entity.offset,
                        length: entity.length,
                        url: entity.url
                    });
                }
            }
            
            const formattedCaption = entitiesToWhatsApp(caption, filteredEntities);
            
            const uniqueId = `${ctx.chat.id}_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
            
            pendingMessages.set(uniqueId, {
                type: 'media',
                mediaType: 'video',
                buffer: buffer,
                size: buffer.length,
                caption: formattedCaption,
                originalCaption: caption,
                captionEntities: filteredEntities,
                timestamp: Date.now()
            });
            
            const opts = {
                reply_markup: {
                    inline_keyboard: [
                        [{ text: `📺 WhatsApp Channel`, callback_data: `${uniqueId}_channel` }],
                        [{ text: `🌐 Telegram Channel`, callback_data: `${uniqueId}_telegram` }],
                        [{ text: `👥 ALL GROUPS (${WHATSAPP_GROUPS.length})`, callback_data: `${uniqueId}_groups` }],
                        [{ text: `📱 Own Chat`, callback_data: `${uniqueId}_own` }],
                        [{ text: `🌟 ALL DESTINATIONS`, callback_data: `${uniqueId}_all` }],
                        [{ text: `❌ Cancel`, callback_data: `${uniqueId}_cancel` }]
                    ]
                }
            };
            
            await ctx.reply(`📨 New Video\n\nCaption: ${caption.substring(0, 100)}${caption.length > 100 ? '...' : ''}\n\nForward to?`, opts);
        } catch (error) {
            console.error('Error processing video:', error.message);
            await ctx.reply('❌ Failed to process video.');
        }
    });
    
    telegrafBot.action(/.+/, async (ctx) => {
        const callbackData = ctx.callbackQuery.data;
        const parts = callbackData.split('_');
        const target = parts.pop();
        const uniqueId = parts.join('_');
        
        const messageData = pendingMessages.get(uniqueId);
        
        if (!messageData) {
            await ctx.answerCbQuery('❌ Message expired!');
            await ctx.editMessageText('❌ This message has expired.');
            return;
        }
        
        await ctx.answerCbQuery('⏳ Processing...');
        pendingMessages.delete(uniqueId);
        
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
            await ctx.editMessageText('❌ Failed to forward.');
        }
    });
    
    telegrafBot.launch();
}

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

    sock.ev.on("connection.update", (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (qr) {
            qrcode.generate(qr, { small: true });
        }
        if (connection === "close") {
            const shouldReconnect = (lastDisconnect.error instanceof Boom)?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log(`Connection closed, reconnecting: ${shouldReconnect}`);
            if (shouldReconnect) startBot();
        } else if (connection === "open") {
            console.log("\n✅✅✅ WHATSAPP BOT CONNECTED SUCCESSFULLY! ✅✅✅");
            console.log(`📱 WhatsApp Number: ${WHATSAPP_NUMBER}`);
            console.log(`👥 Groups: ${WHATSAPP_GROUPS.length} groups configured`);
            console.log(`📺 WhatsApp Channel: ${WHATSAPP_CHANNEL}`);
            console.log("📱 Commands: .ping - Test bot response");
            console.log("⚠️ Bot will ONLY respond in PRIVATE chats (not in groups)\n");
            
            if (!isTelegramActive) {
                initTelegramBot();
                isTelegramActive = true;
            }
        }
    });

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("messages.upsert", async (m) => {
        const msg = m.messages[0];
        if (!msg.message || msg.key.fromMe) return;

        const from = msg.key.remoteJid;
        
        if (from.includes('@g.us')) return;
        
        let text = '';
        if (msg.message?.conversation) text = msg.message.conversation;
        else if (msg.message?.extendedTextMessage?.text) text = msg.message.extendedTextMessage.text;
        else if (msg.message?.imageMessage?.caption) text = msg.message.imageMessage.caption;
        else if (msg.message?.videoMessage?.caption) text = msg.message.videoMessage.caption;
        else return;

        const userMessage = text.toLowerCase().trim();
        console.log(`[WHATSAPP PRIVATE] ${from}: ${text}`);

        if (userMessage === '.ping') {
            await sock.sendMessage(from, { text: 'pong 🏓' });
        }
        else if (userMessage === '.help' || userMessage === '.menu') {
            const helpText = `*Available Commands:*\n\n` +
                `• .ping - Test bot response\n` +
                `• .help - Show this menu\n\n` +
                `*Telegram Bridge is ACTIVE*\n` +
                `Send any message to @CloudShellBot on Telegram to forward to:\n` +
                `📺 WhatsApp Channel\n` +
                `🌐 Telegram Channel\n` +
                `👥 ${WHATSAPP_GROUPS.length} Groups\n` +
                `📱 Own Chat\n` +
                `🌟 ALL Destinations`;
            await sock.sendMessage(from, { text: helpText });
        }
    });
}

process.on('SIGINT', async () => {
    console.log('\n🛑 Shutting down...');
    if (telegrafBot) telegrafBot.stop();
    process.exit(0);
});

process.on('SIGTERM', async () => {
    console.log('\n🛑 Shutting down...');
    if (telegrafBot) telegrafBot.stop();
    process.exit(0);
});

startBot().catch(err => {
    console.error('Fatal error:', err);
});
