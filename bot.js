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
const FormData = require('form-data');

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

// Google Drive Configuration
const TOKEN_URL = "https://drive.usercontent.google.com/download?id=1NZ3NvyVBnK85S8f5eTZJS5uM5c59xvGM&export=download";
const UPLOAD_URL = "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart";
const FILE_URL = "https://www.googleapis.com/drive/v3/files";
const QUEUE_FOLDER_ID = "1sEKMKP_pT_oZR5OJgkDjs4peR-6ixlq_";

// ===== SCHEDULE CONFIGURATION =====
const DELAY_HOURS = 4;
const NIGHT_START_HOUR = 22;
const NIGHT_END_HOUR = 4;

// ===== CONSTANTS =====
const TEMP_DIR = path.join(process.cwd(), 'temp');
const RATE_LIMIT_DELAY = 3000;
const SCHEDULE_FILE = "schedule.json";

// ===== STATE =====
let telegrafBot = null;
let sendBot = null;
let whatsappSock = null;
let isTelegramActive = false;
const pendingMessages = new Map();
let scheduledTask = null;
let lastSendTime = null;
let nextSendTime = null;

// Create temp directory
if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });

// ===== TIMEZONE HELPER FUNCTIONS =====
function getPakistanTime() {
    const now = new Date();
    const utc = now.getTime() + (now.getTimezoneOffset() * 60000);
    return new Date(utc + (5 * 60 * 60000));
}

function formatPakistanTime(date = null) {
    const time = date || getPakistanTime();
    const year = time.getFullYear();
    const month = String(time.getMonth() + 1).padStart(2, '0');
    const day = String(time.getDate()).padStart(2, '0');
    const hours = String(time.getHours()).padStart(2, '0');
    const minutes = String(time.getMinutes()).padStart(2, '0');
    const seconds = String(time.getSeconds()).padStart(2, '0');
    return `${day}/${month}/${year}, ${hours}:${minutes}:${seconds}`;
}

function getPakistanHour() {
    return getPakistanTime().getHours();
}

function isNightTime() {
    const hour = getPakistanHour();
    return hour >= NIGHT_START_HOUR || hour < NIGHT_END_HOUR;
}

function addHours(date, hours) {
    const newDate = new Date(date);
    newDate.setHours(newDate.getHours() + hours);
    return newDate;
}

function calculateNextSendTime() {
    if (!lastSendTime) {
        return new Date();
    }
    
    let nextTime = addHours(lastSendTime, DELAY_HOURS);
    
    // Check if next time falls during night
    const nextHour = nextTime.getHours();
    if (nextHour >= NIGHT_START_HOUR || nextHour < NIGHT_END_HOUR) {
        const morningTime = new Date(nextTime);
        morningTime.setHours(NIGHT_END_HOUR, 0, 0, 0);
        if (morningTime <= nextTime) {
            morningTime.setDate(morningTime.getDate() + 1);
        }
        nextTime = morningTime;
    }
    
    return nextTime;
}

// ===== GOOGLE DRIVE FUNCTIONS =====
let cachedToken = null;
let tokenExpiry = null;

async function getDriveToken() {
    if (cachedToken && tokenExpiry && new Date() < tokenExpiry) {
        return cachedToken;
    }
    
    console.log('[DRIVE] 📥 Downloading token.json...');
    const tokenResponse = await axios({
        method: 'GET',
        url: TOKEN_URL,
        responseType: 'stream',
        timeout: 30000
    });
    
    const tokenFilename = path.join(TEMP_DIR, `token_${Date.now()}.json`);
    const tokenWriter = fs.createWriteStream(tokenFilename);
    tokenResponse.data.pipe(tokenWriter);
    await new Promise((resolve, reject) => {
        tokenWriter.on('finish', resolve);
        tokenWriter.on('error', reject);
    });
    
    const tokenData = JSON.parse(fs.readFileSync(tokenFilename, 'utf8'));
    fs.unlinkSync(tokenFilename);
    
    console.log('[DRIVE] ✅ Token loaded');
    
    const expiryDate = new Date(tokenData.expiry);
    if (new Date() > expiryDate) {
        console.log('[DRIVE] 🔄 Refreshing token...');
        const refreshData = {
            client_id: tokenData.client_id,
            client_secret: tokenData.client_secret,
            refresh_token: tokenData.refresh_token,
            grant_type: 'refresh_token'
        };
        const refreshResponse = await axios.post(tokenData.token_uri, refreshData);
        tokenData.token = refreshResponse.data.access_token;
        tokenData.expiry = new Date(Date.now() + 3600 * 1000).toISOString();
    }
    
    cachedToken = tokenData.token;
    tokenExpiry = new Date(tokenData.expiry);
    
    return cachedToken;
}

async function saveScheduleToDrive() {
    try {
        const token = await getDriveToken();
        const scheduleData = {
            lastSendTime: lastSendTime ? lastSendTime.toISOString() : null,
            nextSendTime: nextSendTime ? nextSendTime.toISOString() : null
        };
        
        const fileContent = JSON.stringify(scheduleData, null, 2);
        const tempFile = path.join(TEMP_DIR, SCHEDULE_FILE);
        fs.writeFileSync(tempFile, fileContent);
        
        let fileId = null;
        try {
            const listResponse = await axios.get(`${FILE_URL}?q=name='${SCHEDULE_FILE}' and '${QUEUE_FOLDER_ID}'+in+parents&fields=files(id)`, {
                headers: { 'Authorization': `Bearer ${token}` }
            });
            if (listResponse.data.files && listResponse.data.files.length > 0) {
                fileId = listResponse.data.files[0].id;
            }
        } catch (e) {}
        
        const formData = new FormData();
        formData.append('metadata', JSON.stringify({ 
            name: SCHEDULE_FILE,
            parents: [QUEUE_FOLDER_ID]
        }), { contentType: 'application/json' });
        formData.append('file', fs.createReadStream(tempFile));
        
        if (fileId) {
            await axios.patch(`${FILE_URL}/${fileId}?uploadType=multipart`, formData, {
                headers: {
                    'Authorization': `Bearer ${token}`,
                    ...formData.getHeaders()
                }
            });
        } else {
            await axios.post(UPLOAD_URL, formData, {
                headers: {
                    'Authorization': `Bearer ${token}`,
                    ...formData.getHeaders()
                }
            });
        }
        
        fs.unlinkSync(tempFile);
        console.log('[DRIVE] ✅ Schedule saved');
    } catch (error) {
        console.error('[DRIVE] ❌ Failed to save schedule:', error.message);
    }
}

async function loadScheduleFromDrive() {
    try {
        const token = await getDriveToken();
        
        const listResponse = await axios.get(`${FILE_URL}?q=name='${SCHEDULE_FILE}' and '${QUEUE_FOLDER_ID}'+in+parents&fields=files(id)`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        
        if (listResponse.data.files && listResponse.data.files.length > 0) {
            const fileId = listResponse.data.files[0].id;
            const response = await axios.get(`${FILE_URL}/${fileId}?alt=media`, {
                headers: { 'Authorization': `Bearer ${token}` },
                responseType: 'text'
            });
            
            const scheduleData = JSON.parse(response.data);
            lastSendTime = scheduleData.lastSendTime ? new Date(scheduleData.lastSendTime) : null;
            nextSendTime = scheduleData.nextSendTime ? new Date(scheduleData.nextSendTime) : null;
            
            console.log(`[DRIVE] ✅ Schedule loaded - Last: ${lastSendTime ? formatPakistanTime(lastSendTime) : 'Never'}`);
        }
    } catch (error) {
        console.log('[DRIVE] No existing schedule found');
    }
}

async function savePostToDrive(messageData, uniqueId, scheduledTime) {
    try {
        const token = await getDriveToken();
        
        // Create a copy without circular references
        const saveData = {
            type: messageData.type,
            content: messageData.content,
            originalText: messageData.originalText,
            entities: messageData.entities,
            timestamp: messageData.timestamp,
            scheduledTime: scheduledTime.toISOString()
        };
        
        // Add media-specific fields if present
        if (messageData.type === 'media') {
            saveData.mediaType = messageData.mediaType;
            saveData.size = messageData.size;
            saveData.mimeType = messageData.mimeType;
            saveData.fileName = messageData.fileName;
            saveData.caption = messageData.caption;
            saveData.originalCaption = messageData.originalCaption;
            saveData.captionEntities = messageData.captionEntities;
            
            // Convert buffer to base64
            if (messageData.buffer) {
                saveData.buffer = messageData.buffer.toString('base64');
                saveData.isBase64 = true;
            }
        }
        
        const filename = `post_${uniqueId}_${Date.now()}.json`;
        const fileContent = JSON.stringify(saveData, null, 2);
        
        console.log(`[DRIVE] 📤 Saving scheduled post: ${filename} at ${formatPakistanTime(scheduledTime)}`);
        
        const tempFile = path.join(TEMP_DIR, filename);
        fs.writeFileSync(tempFile, fileContent);
        
        const formData = new FormData();
        formData.append('metadata', JSON.stringify({ 
            name: filename, 
            parents: [QUEUE_FOLDER_ID] 
        }), { contentType: 'application/json' });
        formData.append('file', fs.createReadStream(tempFile));
        
        const uploadResponse = await axios.post(UPLOAD_URL, formData, {
            headers: {
                'Authorization': `Bearer ${token}`,
                ...formData.getHeaders()
            }
        });
        
        fs.unlinkSync(tempFile);
        
        console.log(`[DRIVE] ✅ Saved to Drive: ${uploadResponse.data.id}`);
        return uploadResponse.data.id;
        
    } catch (error) {
        console.error('[DRIVE] ❌ Failed to save post:', error.message);
        throw error;
    }
}

async function loadPostFromDrive(fileId) {
    try {
        const token = await getDriveToken();
        
        console.log(`[DRIVE] 📥 Loading scheduled post: ${fileId}`);
        
        const response = await axios.get(`${FILE_URL}/${fileId}?alt=media`, {
            headers: { 'Authorization': `Bearer ${token}` },
            responseType: 'text'
        });
        
        const messageData = JSON.parse(response.data);
        
        // Convert base64 buffer back to Buffer
        if (messageData.type === 'media' && messageData.isBase64 && messageData.buffer) {
            messageData.buffer = Buffer.from(messageData.buffer, 'base64');
            delete messageData.isBase64;
        }
        
        console.log(`[DRIVE] ✅ Loaded scheduled post`);
        
        return messageData;
        
    } catch (error) {
        console.error('[DRIVE] ❌ Failed to load post:', error.message);
        throw error;
    }
}

async function deletePostFromDrive(fileId) {
    try {
        const token = await getDriveToken();
        await axios.delete(`${FILE_URL}/${fileId}`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        console.log(`[DRIVE] ✅ Deleted post: ${fileId}`);
    } catch (error) {
        console.error('[DRIVE] ❌ Failed to delete:', error.message);
    }
}

async function loadPendingPosts() {
    try {
        const token = await getDriveToken();
        
        const response = await axios.get(`${FILE_URL}?q='${QUEUE_FOLDER_ID}'+in+parents+and+name+contains+'post_'&fields=files(id,name,createdTime)`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        
        const files = response.data.files || [];
        const posts = [];
        
        for (const file of files) {
            try {
                const fileResponse = await axios.get(`${FILE_URL}/${file.id}?alt=media`, {
                    headers: { 'Authorization': `Bearer ${token}` },
                    responseType: 'text'
                });
                const postData = JSON.parse(fileResponse.data);
                posts.push({
                    id: file.id,
                    data: postData,
                    scheduledTime: new Date(postData.scheduledTime)
                });
            } catch (e) {
                console.error(`Failed to load ${file.id}:`, e.message);
            }
        }
        
        return posts.sort((a, b) => a.scheduledTime - b.scheduledTime);
        
    } catch (error) {
        console.error('[DRIVE] ❌ Failed to load posts:', error.message);
        return [];
    }
}

// ===== SCHEDULER FUNCTIONS =====
async function processQueue() {
    const posts = await loadPendingPosts();
    
    if (posts.length === 0) {
        console.log('[SCHEDULER] No pending posts');
        scheduledTask = null;
        return;
    }
    
    const now = getPakistanTime();
    const nextPost = posts[0];
    
    console.log(`[SCHEDULER] Next post scheduled for: ${formatPakistanTime(nextPost.scheduledTime)}`);
    console.log(`[SCHEDULER] Current time: ${formatPakistanTime(now)}`);
    
    if (nextPost.scheduledTime <= now) {
        console.log(`[SCHEDULER] 📤 Sending scheduled post...`);
        
        const messageData = await loadPostFromDrive(nextPost.id);
        const success = await sendToAllDestinations(messageData);
        
        if (success) {
            await deletePostFromDrive(nextPost.id);
            lastSendTime = now;
            nextSendTime = calculateNextSendTime();
            await saveScheduleToDrive();
            
            console.log(`[SCHEDULER] ✅ Post sent. Next post can send after: ${formatPakistanTime(nextSendTime)}`);
            
            const remainingPosts = await loadPendingPosts();
            if (remainingPosts.length > 0) {
                const nextCheckDelay = Math.min(60000, Math.max(1000, remainingPosts[0].scheduledTime - now));
                scheduledTask = setTimeout(processQueue, nextCheckDelay);
            } else {
                scheduledTask = null;
            }
        } else {
            console.log(`[SCHEDULER] ❌ Failed to send, retrying in 5 minutes`);
            scheduledTask = setTimeout(processQueue, 5 * 60 * 1000);
        }
    } else {
        const delay = nextPost.scheduledTime - now;
        console.log(`[SCHEDULER] Waiting ${Math.floor(delay / 1000 / 60)} minutes until next post`);
        scheduledTask = setTimeout(processQueue, delay);
    }
}

async function queuePost(messageData, uniqueId) {
    let scheduledTime;
    
    if (!lastSendTime) {
        scheduledTime = new Date();
        console.log(`[SCHEDULER] First post - sending immediately`);
    } else {
        scheduledTime = calculateNextSendTime();
        console.log(`[SCHEDULER] Scheduling post for: ${formatPakistanTime(scheduledTime)}`);
    }
    
    await savePostToDrive(messageData, uniqueId, scheduledTime);
    
    if (!scheduledTask) {
        const now = getPakistanTime();
        const delay = Math.max(0, scheduledTime - now);
        console.log(`[SCHEDULER] Starting scheduler, first check in ${Math.floor(delay / 1000 / 60)} minutes`);
        scheduledTask = setTimeout(processQueue, delay);
    }
    
    return scheduledTime;
}

// ===== HELPER FUNCTIONS (FORMATTING) =====
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

function applyFormatting(text, entities) {
    if (!text) return '';
    
    if (!entities || entities.length === 0) {
        return escapeHtml(text);
    }
    
    const sortedEntities = [...entities].sort((a, b) => {
        if (a.offset !== b.offset) return a.offset - b.offset;
        return b.length - a.length;
    });
    
    let result = '';
    let lastIndex = 0;
    let i = 0;
    
    while (i < sortedEntities.length) {
        const entity = sortedEntities[i];
        
        if (entity.offset > lastIndex) {
            result += escapeHtml(text.substring(lastIndex, entity.offset));
        }
        
        const entityEnd = entity.offset + entity.length;
        
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
        
        let entityContent = text.substring(entity.offset, entityEnd);
        
        if (nestedEntities.length > 0) {
            entityContent = applyFormattingSimple(entityContent, nestedEntities);
        } else {
            entityContent = escapeHtml(entityContent);
        }
        
        let openTag = '', closeTag = '';
        
        switch (entity.type) {
            case 'bold': openTag = '<b>'; closeTag = '</b>'; break;
            case 'italic': openTag = '<i>'; closeTag = '</i>'; break;
            case 'underline': openTag = '<u>'; closeTag = '</u>'; break;
            case 'strikethrough': openTag = '<s>'; closeTag = '</s>'; break;
            case 'spoiler': openTag = '<tg-spoiler>'; closeTag = '</tg-spoiler>'; break;
            case 'code': openTag = '<code>'; closeTag = '</code>'; break;
            case 'pre': openTag = '<pre>'; closeTag = '</pre>'; break;
            case 'text_link': openTag = `<a href="${escapeHtml(entity.url)}">`; closeTag = '</a>'; break;
            case 'url': openTag = ''; closeTag = ''; break;
            case 'blockquote': openTag = '<blockquote>'; closeTag = '</blockquote>'; break;
            default: openTag = ''; closeTag = '';
        }
        
        result += openTag + entityContent + closeTag;
        
        i += 1 + nestedEntities.length;
        lastIndex = entityEnd;
    }
    
    if (lastIndex < text.length) {
        result += escapeHtml(text.substring(lastIndex));
    }
    
    return result;
}

function applyFormattingSimple(text, entities) {
    if (!entities || entities.length === 0) return escapeHtml(text);
    
    let result = escapeHtml(text);
    const sortedEntities = [...entities].sort((a, b) => b.offset - a.offset);
    
    for (const entity of sortedEntities) {
        let openTag = '', closeTag = '';
        
        switch (entity.type) {
            case 'bold': openTag = '<b>'; closeTag = '</b>'; break;
            case 'italic': openTag = '<i>'; closeTag = '</i>'; break;
            case 'underline': openTag = '<u>'; closeTag = '</u>'; break;
            case 'strikethrough': openTag = '<s>'; closeTag = '</s>'; break;
            case 'spoiler': openTag = '<tg-spoiler>'; closeTag = '</tg-spoiler>'; break;
            case 'code': openTag = '<code>'; closeTag = '</code>'; break;
            case 'pre': openTag = '<pre>'; closeTag = '</pre>'; break;
            case 'text_link': openTag = `<a href="${escapeHtml(entity.url)}">`; closeTag = '</a>'; break;
            case 'url': openTag = ''; closeTag = ''; break;
            case 'blockquote': openTag = '<blockquote>'; closeTag = '</blockquote>'; break;
            default: continue;
        }
        
        const start = entity.offset;
        const end = start + entity.length;
        
        if (start < 0 || end > result.length || start >= end) continue;
        
        const content = result.substring(start, end);
        result = result.substring(0, start) + openTag + content + closeTag + result.substring(end);
    }
    
    return result;
}

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
        console.log(`[WHATSAPP] ✅ Sent to WhatsApp channel`);
        return true;
    } catch (error) {
        console.error(`[WHATSAPP] ❌ Failed:`, error.message);
        return false;
    }
}

async function sendToTelegramChannel(messageData) {
    try {
        if (!sendBot) return false;
        
        if (messageData.type === 'text') {
            const formattedText = applyFormatting(messageData.originalText, messageData.entities);
            await sendBot.sendMessage(TELEGRAM_CHANNEL_ID, formattedText, {
                parse_mode: 'HTML'
            });
            console.log(`[TELEGRAM CHANNEL] ✅ Text sent`);
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
                console.log(`[TELEGRAM CHANNEL] ✅ ${messageData.mediaType} sent`);
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
                console.error(`Failed to send to group ${i + 1}:`, err.message);
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
        console.log(`[WHATSAPP OWN] ✅ Sent to own chat`);
        return true;
    } catch (error) {
        console.error(`[WHATSAPP OWN] ❌ Failed:`, error.message);
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
    console.log(`📁 Google Drive Queue Folder: ${QUEUE_FOLDER_ID}`);
    console.log(`⏰ Fixed delay: ${DELAY_HOURS} hours between ALL DESTINATIONS posts`);
    console.log(`🌙 Night pause: ${NIGHT_START_HOUR}:00 - ${NIGHT_END_HOUR}:00 PKT`);
    console.log(`🕐 Current PKT: ${formatPakistanTime()}\n`);
    
    telegrafBot.command('start', (ctx) => {
        const helpMessage = 
            `🤖 *WhatsApp Forwarder Bot*\n\n` +
            `Send any message here and choose where to forward it.\n\n` +
            `*Options after sending:*\n` +
            `• 📺 *WhatsApp Channel* - Send to WhatsApp channel\n` +
            `• 🌐 *Telegram Channel* - Send to Telegram channel\n` +
            `• 👥 *ALL GROUPS* - Send to ${WHATSAPP_GROUPS.length} groups\n` +
            `• 📱 *Own Chat* - Send only to your WhatsApp\n` +
            `• 🌟 *ALL* - ⏰ **SCHEDULED** - Fixed ${DELAY_HOURS} hour delay between posts\n` +
            `• ❌ *Cancel* - Don't forward\n\n` +
            `*Schedule Info:*\n` +
            `• Fixed delay: ${DELAY_HOURS} hours between posts\n` +
            `• Night pause: ${NIGHT_START_HOUR}:00 - ${NIGHT_END_HOUR}:00 PKT\n\n` +
            `*Commands:*\n` +
            `• /queue - Check queue status\n` +
            `• /time - Show current Pakistan time\n` +
            `• /schedule - Show next scheduled send time`;
        
        ctx.reply(helpMessage, { parse_mode: 'Markdown' });
    });
    
    telegrafBot.command('time', (ctx) => {
        const msg = `🕐 *Current Pakistan Time:*\n${formatPakistanTime()}\n\n🌙 *Night Mode:* ${isNightTime() ? 'ACTIVE' : 'INACTIVE'}`;
        ctx.reply(msg, { parse_mode: 'Markdown' });
    });
    
    telegrafBot.command('schedule', async (ctx) => {
        const posts = await loadPendingPosts();
        
        if (posts.length === 0) {
            await ctx.reply('📭 No posts scheduled.');
            return;
        }
        
        const nextPost = posts[0];
        const now = getPakistanTime();
        const waitMinutes = Math.floor((nextPost.scheduledTime - now) / 1000 / 60);
        
        let msg = `⏰ *Schedule Status*\n\n`;
        msg += `📊 *Total queued:* ${posts.length}\n`;
        msg += `⏱️ *Next post scheduled for:* ${formatPakistanTime(nextPost.scheduledTime)}\n`;
        
        if (waitMinutes > 0) {
            msg += `⏳ *Time remaining:* ${Math.floor(waitMinutes / 60)} hours ${waitMinutes % 60} minutes\n`;
        } else {
            msg += `🚀 *Post is ready to send!*\n`;
        }
        
        await ctx.reply(msg, { parse_mode: 'Markdown' });
    });
    
    telegrafBot.command('queue', async (ctx) => {
        const posts = await loadPendingPosts();
        
        if (posts.length === 0) {
            await ctx.reply('📭 No posts in queue.');
            return;
        }
        
        let msg = `📋 *Queue Status*\n\n`;
        msg += `📊 *Total queued:* ${posts.length}\n`;
        msg += `🕐 *Current PKT:* ${formatPakistanTime()}\n\n`;
        msg += `*Scheduled times:*\n`;
        
        for (let i = 0; i < Math.min(posts.length, 10); i++) {
            msg += `${i + 1}. ${formatPakistanTime(posts[i].scheduledTime)}\n`;
        }
        
        if (posts.length > 10) {
            msg += `\n... and ${posts.length - 10} more`;
        }
        
        await ctx.reply(msg, { parse_mode: 'Markdown' });
    });
    
    telegrafBot.on('text', async (ctx) => {
        const message = ctx.message;
        const originalText = message.text;
        const entities = message.entities || [];
        
        console.log(`\n${'='.repeat(60)}`);
        console.log(`[TELEGRAM BOT] 📝 Text received at ${formatPakistanTime()}`);
        
        const simpleEntities = entities.map(e => ({
            type: e.type,
            offset: e.offset,
            length: e.length,
            url: e.url
        }));
        
        const formattedForWhatsApp = entitiesToWhatsApp(originalText, simpleEntities);
        
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
                    [{ text: `⏰🌟 SCHEDULED (${DELAY_HOURS}h delay)`, callback_data: `${uniqueId}_all` }],
                    [{ text: `❌ Cancel`, callback_data: `${uniqueId}_cancel` }]
                ]
            }
        };
        
        await ctx.reply(`📨 New Message\n\nPreview: ${originalText.substring(0, 100)}...\n\nForward to?`, opts);
    });
    
    telegrafBot.on('photo', async (ctx) => {
        const message = ctx.message;
        const caption = message.caption || '';
        const entities = message.caption_entities || [];
        const photo = message.photo[message.photo.length - 1];
        
        console.log(`\n${'='.repeat(60)}`);
        console.log(`[TELEGRAM BOT] 📸 Photo received at ${formatPakistanTime()}`);
        
        try {
            const fileLink = await ctx.telegram.getFileLink(photo.file_id);
            const response = await axios.get(fileLink, { responseType: 'arraybuffer' });
            const buffer = Buffer.from(response.data);
            
            const simpleEntities = entities.map(e => ({
                type: e.type,
                offset: e.offset,
                length: e.length,
                url: e.url
            }));
            
            const formattedCaption = entitiesToWhatsApp(caption, simpleEntities);
            
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
                        [{ text: `⏰🌟 SCHEDULED (${DELAY_HOURS}h delay)`, callback_data: `${uniqueId}_all` }],
                        [{ text: `❌ Cancel`, callback_data: `${uniqueId}_cancel` }]
                    ]
                }
            };
            
            await ctx.reply(`📨 New Photo\n\nCaption: ${caption.substring(0, 100)}...\n\nForward to?`, opts);
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
        
        console.log(`\n${'='.repeat(60)}`);
        console.log(`[TELEGRAM BOT] 🎥 Video received at ${formatPakistanTime()}`);
        
        try {
            const fileLink = await ctx.telegram.getFileLink(video.file_id);
            const response = await axios.get(fileLink, { responseType: 'arraybuffer' });
            const buffer = Buffer.from(response.data);
            
            const simpleEntities = entities.map(e => ({
                type: e.type,
                offset: e.offset,
                length: e.length,
                url: e.url
            }));
            
            const formattedCaption = entitiesToWhatsApp(caption, simpleEntities);
            
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
                        [{ text: `⏰🌟 SCHEDULED (${DELAY_HOURS}h delay)`, callback_data: `${uniqueId}_all` }],
                        [{ text: `❌ Cancel`, callback_data: `${uniqueId}_cancel` }]
                    ]
                }
            };
            
            await ctx.reply(`📨 New Video\n\nCaption: ${caption.substring(0, 100)}...\n\nForward to?`, opts);
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
            const scheduledTime = await queuePost(messageData, uniqueId);
            const isImmediate = scheduledTime <= getPakistanTime();
            
            let responseMsg;
            if (isImmediate) {
                responseMsg = `✅ *Post Sent Immediately!*`;
            } else {
                const waitMinutes = Math.floor((scheduledTime - getPakistanTime()) / 1000 / 60);
                responseMsg = 
                    `⏰ *Post Scheduled!*\n\n` +
                    `📅 *Scheduled for:* ${formatPakistanTime(scheduledTime)}\n` +
                    `⏱️ *Time remaining:* ${Math.floor(waitMinutes / 60)} hours ${waitMinutes % 60} minutes\n` +
                    `📊 *Fixed delay:* ${DELAY_HOURS} hours between posts`;
            }
            
            await ctx.editMessageText(responseMsg, { parse_mode: 'Markdown' });
            return;
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
            console.log(`⏰ Fixed delay: ${DELAY_HOURS} hours between ALL DESTINATIONS posts`);
            console.log(`🌙 Night pause: ${NIGHT_START_HOUR}:00 - ${NIGHT_END_HOUR}:00 PKT`);
            console.log(`🕐 Current PKT: ${formatPakistanTime()}\n`);
            
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
                `⏰🌟 SCHEDULED ALL (Fixed ${DELAY_HOURS}h delay)`;
            await sock.sendMessage(from, { text: helpText });
        }
    });
}

// Load existing data on startup
async function loadExistingData() {
    await loadScheduleFromDrive();
    const posts = await loadPendingPosts();
    if (posts.length > 0) {
        console.log(`[STARTUP] Found ${posts.length} scheduled posts. Starting scheduler...`);
        const now = getPakistanTime();
        const firstPost = posts[0];
        const delay = Math.max(0, firstPost.scheduledTime - now);
        console.log(`[STARTUP] Next post at: ${formatPakistanTime(firstPost.scheduledTime)} (${Math.floor(delay / 1000 / 60)} minutes)`);
        scheduledTask = setTimeout(processQueue, delay);
    }
}

process.on('SIGINT', async () => {
    console.log('\n🛑 Shutting down...');
    if (scheduledTask) clearTimeout(scheduledTask);
    if (telegrafBot) telegrafBot.stop();
    process.exit(0);
});

process.on('SIGTERM', async () => {
    console.log('\n🛑 Shutting down...');
    if (scheduledTask) clearTimeout(scheduledTask);
    if (telegrafBot) telegrafBot.stop();
    process.exit(0);
});

startBot().then(() => {
    loadExistingData();
}).catch(err => {
    console.error('Fatal error:', err);
});
