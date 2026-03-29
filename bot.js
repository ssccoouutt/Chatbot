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

function escapeHtml(text) {
    if (!text) return text;
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

// PROPER NESTED FORMATTING WITH BLOCKQUOTE SUPPORT
function applyFormatting(text, entities) {
    if (!text) return '';
    
    console.log(`\n[FORMATTING DEBUG] ========== START ==========`);
    console.log(`[FORMATTING DEBUG] Original text: ${text.substring(0, 200)}...`);
    console.log(`[FORMATTING DEBUG] Entities count: ${entities?.length || 0}`);
    
    if (entities && entities.length > 0) {
        for (let i = 0; i < entities.length; i++) {
            console.log(`[FORMATTING DEBUG] Entity ${i}: type=${entities[i].type}, offset=${entities[i].offset}, length=${entities[i].length}`);
        }
    }
    
    if (!entities || entities.length === 0) {
        let escaped = escapeHtml(text);
        console.log(`[FORMATTING DEBUG] Final result (no entities): ${escaped.substring(0, 200)}`);
        console.log(`[FORMATTING DEBUG] ========== END ==========\n`);
        return escaped;
    }
    
    // Sort entities by offset (ascending) and length (descending) for proper nesting
    const sortedEntities = [...entities].sort((a, b) => {
        if (a.offset !== b.offset) return a.offset - b.offset;
        return b.length - a.length;
    });
    
    console.log(`[FORMATTING DEBUG] Sorted entities count: ${sortedEntities.length}`);
    
    // Build the formatted text with proper nesting
    let result = '';
    let lastIndex = 0;
    let i = 0;
    
    while (i < sortedEntities.length) {
        const entity = sortedEntities[i];
        
        // Add text before this entity
        if (entity.offset > lastIndex) {
            const beforeText = text.substring(lastIndex, entity.offset);
            console.log(`[FORMATTING DEBUG] Adding text before entity: "${beforeText.substring(0, 50)}"`);
            result += escapeHtml(beforeText);
        }
        
        const entityEnd = entity.offset + entity.length;
        
        // Find all entities nested inside this one
        const nestedEntities = [];
        let j = i + 1;
        while (j < sortedEntities.length) {
            const nextEntity = sortedEntities[j];
            if (nextEntity.offset >= entity.offset && nextEntity.offset + nextEntity.length <= entityEnd) {
                nestedEntities.push({
                    type: nextEntity.type,
                    offset: nextEntity.offset - entity.offset,
                    length: nextEntity.length,
                    url: nextEntity.url
                });
                j++;
            } else {
                break;
            }
        }
        
        console.log(`[FORMATTING DEBUG] Entity type: ${entity.type}, has ${nestedEntities.length} nested entities`);
        
        // Get the content of this entity
        let entityContent = text.substring(entity.offset, entityEnd);
        
        // Apply nested formatting recursively
        if (nestedEntities.length > 0) {
            console.log(`[FORMATTING DEBUG] Applying nested formatting for ${entity.type}`);
            entityContent = applyFormattingSimple(entityContent, nestedEntities);
        } else {
            entityContent = escapeHtml(entityContent);
        }
        
        // Get HTML tags for this entity
        let openTag = '';
        let closeTag = '';
        
        switch (entity.type) {
            case 'bold':
                openTag = '<b>';
                closeTag = '</b>';
                break;
            case 'italic':
                openTag = '<i>';
                closeTag = '</i>';
                break;
            case 'underline':
                openTag = '<u>';
                closeTag = '</u>';
                break;
            case 'strikethrough':
                openTag = '<s>';
                closeTag = '</s>';
                break;
            case 'spoiler':
                openTag = '<tg-spoiler>';
                closeTag = '</tg-spoiler>';
                break;
            case 'code':
                openTag = '<code>';
                closeTag = '</code>';
                break;
            case 'pre':
                openTag = '<pre>';
                closeTag = '</pre>';
                break;
            case 'text_link':
                openTag = `<a href="${escapeHtml(entity.url)}">`;
                closeTag = '</a>';
                break;
            case 'url':
                // DON'T wrap URLs - keep them as plain text (no <a> tags)
                openTag = '';
                closeTag = '';
                console.log(`[FORMATTING DEBUG] URL entity found, keeping as plain text`);
                break;
            case 'blockquote':
                openTag = '<blockquote>';
                closeTag = '</blockquote>';
                console.log(`[FORMATTING DEBUG] Processing BLOCKQUOTE entity`);
                break;
            default:
                openTag = '';
                closeTag = '';
                console.log(`[FORMATTING DEBUG] Unknown entity type: ${entity.type}, treating as text`);
                entityContent = escapeHtml(entityContent);
        }
        
        result += openTag + entityContent + closeTag;
        console.log(`[FORMATTING DEBUG] Added formatted entity: ${openTag}${entityContent.substring(0, 50)}${closeTag}`);
        
        i += 1 + nestedEntities.length;
        lastIndex = entityEnd;
    }
    
    // Add remaining text
    if (lastIndex < text.length) {
        const remainingText = text.substring(lastIndex);
        console.log(`[FORMATTING DEBUG] Adding remaining text: "${remainingText.substring(0, 50)}"`);
        result += escapeHtml(remainingText);
    }
    
    console.log(`[FORMATTING DEBUG] Final result: ${result.substring(0, 300)}`);
    console.log(`[FORMATTING DEBUG] ========== END ==========\n`);
    
    return result;
}

// Simple formatting for nested content (no further nesting)
function applyFormattingSimple(text, entities) {
    if (!entities || entities.length === 0) return escapeHtml(text);
    
    console.log(`[SIMPLE DEBUG] Processing ${entities.length} nested entities`);
    
    let result = escapeHtml(text);
    const sortedEntities = [...entities].sort((a, b) => b.offset - a.offset);
    
    for (const entity of sortedEntities) {
        let openTag = '';
        let closeTag = '';
        
        switch (entity.type) {
            case 'bold':
                openTag = '<b>';
                closeTag = '</b>';
                break;
            case 'italic':
                openTag = '<i>';
                closeTag = '</i>';
                break;
            case 'underline':
                openTag = '<u>';
                closeTag = '</u>';
                break;
            case 'strikethrough':
                openTag = '<s>';
                closeTag = '</s>';
                break;
            case 'spoiler':
                openTag = '<tg-spoiler>';
                closeTag = '</tg-spoiler>';
                break;
            case 'code':
                openTag = '<code>';
                closeTag = '</code>';
                break;
            case 'pre':
                openTag = '<pre>';
                closeTag = '</pre>';
                break;
            case 'text_link':
                openTag = `<a href="${escapeHtml(entity.url)}">`;
                closeTag = '</a>';
                break;
            case 'url':
                // DON'T wrap URLs - keep as plain text
                openTag = '';
                closeTag = '';
                break;
            case 'blockquote':
                openTag = '<blockquote>';
                closeTag = '</blockquote>';
                break;
            default:
                continue;
        }
        
        const start = entity.offset;
        const end = start + entity.length;
        
        if (start < 0 || end > result.length || start >= end) continue;
        
        const content = result.substring(start, end);
        result = result.substring(0, start) + openTag + content + closeTag + result.substring(end);
    }
    
    return result;
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
        
        console.log(`[WHATSAPP] Sending to WhatsApp channel`);
        
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
        console.log(`[WHATSAPP] ✅ Sent successfully`);
        return true;
    } catch (error) {
        console.error(`[WHATSAPP] ❌ Failed:`, error.message);
        return false;
    }
}

async function sendToTelegramChannel(messageData) {
    try {
        if (!sendBot) return false;
        
        console.log(`[TELEGRAM CHANNEL] Sending to channel: ${TELEGRAM_CHANNEL_ID}`);
        
        if (messageData.type === 'text') {
            const formattedText = applyFormatting(messageData.originalText, messageData.entities);
            console.log(`[TELEGRAM CHANNEL] Final HTML length: ${formattedText.length}`);
            console.log(`[TELEGRAM CHANNEL] Final HTML preview: ${formattedText.substring(0, 300)}`);
            
            await sendBot.sendMessage(TELEGRAM_CHANNEL_ID, formattedText, {
                parse_mode: 'HTML'
            });
            console.log(`[TELEGRAM CHANNEL] ✅ Text sent successfully`);
        } else if (messageData.type === 'media') {
            const caption = messageData.originalCaption || '';
            const formattedCaption = applyFormatting(caption, messageData.captionEntities);
            
            console.log(`[TELEGRAM CHANNEL] Media type: ${messageData.mediaType}`);
            console.log(`[TELEGRAM CHANNEL] Formatted caption length: ${formattedCaption.length}`);
            
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
                console.log(`[TELEGRAM CHANNEL] ✅ ${messageData.mediaType} sent successfully`);
            } finally {
                if (fs.existsSync(tempFilePath)) fs.unlinkSync(tempFilePath);
            }
        }
        return true;
    } catch (error) {
        console.error(`[TELEGRAM CHANNEL] ❌ Failed:`, error.message);
        return false;
    }
}

async function sendToAllGroups(messageData) {
    try {
        if (!whatsappSock) return false;
        
        let successCount = 0;
        console.log(`[WHATSAPP GROUPS] Sending to ${WHATSAPP_GROUPS.length} groups`);
        
        for (let i = 0; i < WHATSAPP_GROUPS.length; i++) {
            const target = WHATSAPP_GROUPS[i];
            try {
                if (messageData.type === 'text') {
                    await whatsappSock.sendMessage(target, { text: messageData.content });
                    successCount++;
                    console.log(`[WHATSAPP GROUPS] ✅ Sent to group ${i + 1}`);
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
                    console.log(`[WHATSAPP GROUPS] ✅ Media sent to group ${i + 1}`);
                }
                
                if (i < WHATSAPP_GROUPS.length - 1) {
                    await new Promise(resolve => setTimeout(resolve, RATE_LIMIT_DELAY));
                }
            } catch (err) {
                console.error(`[WHATSAPP GROUPS] ❌ Failed to send to group ${i + 1}:`, err.message);
            }
        }
        
        console.log(`[WHATSAPP GROUPS] ✅ Sent to ${successCount}/${WHATSAPP_GROUPS.length} groups`);
        return successCount > 0;
    } catch (error) {
        console.error(`[WHATSAPP GROUPS] ❌ Failed:`, error.message);
        return false;
    }
}

async function sendToOwnChat(messageData) {
    try {
        if (!whatsappSock) return false;
        
        const jid = WHATSAPP_NUMBER.includes('@') ? WHATSAPP_NUMBER : `${WHATSAPP_NUMBER}@s.whatsapp.net`;
        console.log(`[WHATSAPP OWN] Sending to: ${jid}`);
        
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
        console.log(`[WHATSAPP OWN] ✅ Sent successfully`);
        return true;
    } catch (error) {
        console.error(`[WHATSAPP OWN] ❌ Failed:`, error.message);
        return false;
    }
}

async function sendToAllDestinations(messageData) {
    let allSuccess = true;
    
    console.log(`\n[ALL DESTINATIONS] ========== STARTING ==========`);
    
    console.log(`[ALL DESTINATIONS] Sending to WhatsApp channel...`);
    if (!await sendToWhatsAppChannel(messageData)) allSuccess = false;
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    console.log(`[ALL DESTINATIONS] Sending to Telegram channel...`);
    if (!await sendToTelegramChannel(messageData)) allSuccess = false;
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    console.log(`[ALL DESTINATIONS] Sending to WhatsApp groups...`);
    if (!await sendToAllGroups(messageData)) allSuccess = false;
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    console.log(`[ALL DESTINATIONS] Sending to own chat...`);
    if (!await sendToOwnChat(messageData)) allSuccess = false;
    
    console.log(`[ALL DESTINATIONS] ========== COMPLETE (Success: ${allSuccess}) ==========\n`);
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
        
        console.log(`\n${'='.repeat(60)}`);
        console.log(`[TELEGRAM BOT] 📝 Text message received`);
        console.log(`[TELEGRAM BOT] From: ${ctx.from.username || ctx.from.id}`);
        console.log(`[TELEGRAM BOT] Text length: ${originalText.length}`);
        console.log(`[TELEGRAM BOT] Text preview: ${originalText.substring(0, 200)}`);
        console.log(`[TELEGRAM BOT] Entities count: ${entities.length}`);
        
        // Convert entities to simple format - KEEP blockquote entities
        const simpleEntities = entities.map(e => ({
            type: e.type,
            offset: e.offset,
            length: e.length,
            url: e.url
        }));
        
        const formattedForWhatsApp = entitiesToWhatsApp(originalText, simpleEntities);
        console.log(`[TELEGRAM BOT] WhatsApp formatted preview: ${formattedForWhatsApp.substring(0, 200)}`);
        
        const uniqueId = `${ctx.chat.id}_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
        
        pendingMessages.set(uniqueId, {
            type: 'text',
            content: formattedForWhatsApp,
            originalText: originalText,
            entities: simpleEntities,
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
        console.log(`[TELEGRAM BOT] Confirmation sent to user`);
    });
    
    telegrafBot.on('photo', async (ctx) => {
        const message = ctx.message;
        const caption = message.caption || '';
        const entities = message.caption_entities || [];
        const photo = message.photo[message.photo.length - 1];
        
        console.log(`\n${'='.repeat(60)}`);
        console.log(`[TELEGRAM BOT] 📸 Photo received`);
        console.log(`[TELEGRAM BOT] From: ${ctx.from.username || ctx.from.id}`);
        console.log(`[TELEGRAM BOT] Caption length: ${caption.length}`);
        console.log(`[TELEGRAM BOT] Caption preview: ${caption.substring(0, 200)}`);
        console.log(`[TELEGRAM BOT] Entities count: ${entities.length}`);
        
        try {
            const fileLink = await ctx.telegram.getFileLink(photo.file_id);
            console.log(`[TELEGRAM BOT] Photo file link: ${fileLink}`);
            
            const response = await axios.get(fileLink, { responseType: 'arraybuffer' });
            const buffer = Buffer.from(response.data);
            console.log(`[TELEGRAM BOT] Photo size: ${buffer.length} bytes`);
            
            const simpleEntities = entities.map(e => ({
                type: e.type,
                offset: e.offset,
                length: e.length,
                url: e.url
            }));
            
            const formattedCaption = entitiesToWhatsApp(caption, simpleEntities);
            console.log(`[TELEGRAM BOT] WhatsApp formatted caption preview: ${formattedCaption.substring(0, 200)}`);
            
            const uniqueId = `${ctx.chat.id}_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
            
            pendingMessages.set(uniqueId, {
                type: 'media',
                mediaType: 'photo',
                buffer: buffer,
                size: buffer.length,
                caption: formattedCaption,
                originalCaption: caption,
                captionEntities: simpleEntities,
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
            console.log(`[TELEGRAM BOT] Confirmation sent to user`);
        } catch (error) {
            console.error(`[TELEGRAM BOT] Error processing photo:`, error.message);
            await ctx.reply('❌ Failed to process image.');
        }
    });
    
    telegrafBot.on('video', async (ctx) => {
        const message = ctx.message;
        const caption = message.caption || '';
        const entities = message.caption_entities || [];
        const video = message.video;
        
        console.log(`\n${'='.repeat(60)}`);
        console.log(`[TELEGRAM BOT] 🎥 Video received`);
        console.log(`[TELEGRAM BOT] From: ${ctx.from.username || ctx.from.id}`);
        console.log(`[TELEGRAM BOT] Caption length: ${caption.length}`);
        console.log(`[TELEGRAM BOT] Caption preview: ${caption.substring(0, 200)}`);
        console.log(`[TELEGRAM BOT] Entities count: ${entities.length}`);
        
        try {
            const fileLink = await ctx.telegram.getFileLink(video.file_id);
            console.log(`[TELEGRAM BOT] Video file link: ${fileLink}`);
            
            const response = await axios.get(fileLink, { responseType: 'arraybuffer' });
            const buffer = Buffer.from(response.data);
            console.log(`[TELEGRAM BOT] Video size: ${buffer.length} bytes`);
            
            const simpleEntities = entities.map(e => ({
                type: e.type,
                offset: e.offset,
                length: e.length,
                url: e.url
            }));
            
            const formattedCaption = entitiesToWhatsApp(caption, simpleEntities);
            console.log(`[TELEGRAM BOT] WhatsApp formatted caption preview: ${formattedCaption.substring(0, 200)}`);
            
            const uniqueId = `${ctx.chat.id}_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
            
            pendingMessages.set(uniqueId, {
                type: 'media',
                mediaType: 'video',
                buffer: buffer,
                size: buffer.length,
                caption: formattedCaption,
                originalCaption: caption,
                captionEntities: simpleEntities,
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
            console.log(`[TELEGRAM BOT] Confirmation sent to user`);
        } catch (error) {
            console.error(`[TELEGRAM BOT] Error processing video:`, error.message);
            await ctx.reply('❌ Failed to process video.');
        }
    });
    
    telegrafBot.action(/.+/, async (ctx) => {
        const callbackData = ctx.callbackQuery.data;
        const parts = callbackData.split('_');
        const target = parts.pop();
        const uniqueId = parts.join('_');
        
        console.log(`\n[TELEGRAM BOT] 🔘 Callback received: ${callbackData}`);
        console.log(`[TELEGRAM BOT] Target: ${target}, UniqueId: ${uniqueId}`);
        
        const messageData = pendingMessages.get(uniqueId);
        
        if (!messageData) {
            console.log(`[TELEGRAM BOT] ❌ Message expired or not found`);
            await ctx.answerCbQuery('❌ Message expired!');
            await ctx.editMessageText('❌ This message has expired.');
            return;
        }
        
        await ctx.answerCbQuery('⏳ Processing...');
        pendingMessages.delete(uniqueId);
        
        if (target === 'cancel') {
            console.log(`[TELEGRAM BOT] User cancelled forwarding`);
            await ctx.editMessageText('❌ Cancelled.');
            return;
        }
        
        let success = false;
        let targetText = '';
        
        console.log(`[TELEGRAM BOT] Processing forward to: ${target}`);
        
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
            console.log(`[TELEGRAM BOT] ✅ Forward successful to ${targetText}`);
            await ctx.editMessageText(`✅ Successfully forwarded to ${targetText}`);
        } else {
            console.log(`[TELEGRAM BOT] ❌ Forward failed to ${targetText}`);
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
            console.log(`[DEBUG] QR Code received, scanning...`);
            qrcode.generate(qr, { small: true });
        }
        if (connection === "close") {
            const shouldReconnect = (lastDisconnect.error instanceof Boom)?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log(`[DEBUG] Connection closed, reconnecting: ${shouldReconnect}`);
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
        console.log(`[WHATSAPP PRIVATE] 📱 Message from ${from}: ${text}`);

        if (userMessage === '.ping') {
            console.log(`[WHATSAPP PRIVATE] Sending pong`);
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
