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
const TELEGRAM_BOT_TOKEN = "8717510346:AAFE_BBeFoyvjw7WgiJlDvKUO2v2QXLFHWI";
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
const WHATSAPP_CHANNEL = "120363304414452603@newsletter";

// Google Drive Configuration
const TOKEN_URL = "https://drive.usercontent.google.com/download?id=1NZ3NvyVBnK85S8f5eTZJS5uM5c59xvGM&export=download";
const UPLOAD_URL = "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart";
const FILE_URL = "https://www.googleapis.com/drive/v3/files";
const POSTS_FOLDER_ID = "1sEKMKP_pT_oZR5OJgkDjs4peR-6ixlq_";
const MEDIA_FOLDER_ID = "1pll1-8s83ZUna1K9lL_miFkYsiEvxh-z";

// ===== SCHEDULE CONFIGURATION =====
const MIN_DELAY_HOURS = 3;
const MAX_DELAY_HOURS = 4;
const NIGHT_START_HOUR = 22;
const NIGHT_END_HOUR = 4;
const MISSED_POST_WINDOW_MS = 15 * 60 * 1000; // 15 minutes

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
const processingPosts = new Set(); // Track posts being processed

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

function getRandomDelayHours() {
    const delay = MIN_DELAY_HOURS + Math.random() * (MAX_DELAY_HOURS - MIN_DELAY_HOURS);
    return delay;
}

function addRandomHours(date) {
    const delayHours = getRandomDelayHours();
    const newDate = new Date(date);
    newDate.setHours(newDate.getHours() + delayHours);
    const fractionalHours = delayHours - Math.floor(delayHours);
    newDate.setMinutes(newDate.getMinutes() + Math.floor(fractionalHours * 60));
    console.log(`[SCHEDULER] Adding ${delayHours.toFixed(2)} hours (${Math.floor(delayHours)}h ${Math.floor(fractionalHours * 60)}m)`);
    return newDate;
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
            lastSendTime: lastSendTime ? lastSendTime.toISOString() : null
        };
        
        const fileContent = JSON.stringify(scheduleData, null, 2);
        const tempFile = path.join(TEMP_DIR, SCHEDULE_FILE);
        fs.writeFileSync(tempFile, fileContent);
        
        let fileId = null;
        try {
            const listResponse = await axios.get(`${FILE_URL}?q=name='${SCHEDULE_FILE}' and '${POSTS_FOLDER_ID}'+in+parents&fields=files(id)`, {
                headers: { 'Authorization': `Bearer ${token}` }
            });
            if (listResponse.data.files && listResponse.data.files.length > 0) {
                fileId = listResponse.data.files[0].id;
            }
        } catch (e) {}
        
        const formData = new FormData();
        formData.append('metadata', JSON.stringify({ 
            name: SCHEDULE_FILE,
            parents: [POSTS_FOLDER_ID]
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
        
        const listResponse = await axios.get(`${FILE_URL}?q=name='${SCHEDULE_FILE}' and '${POSTS_FOLDER_ID}'+in+parents&fields=files(id)`, {
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
            
            console.log(`[DRIVE] ✅ Schedule loaded - Last send: ${lastSendTime ? formatPakistanTime(lastSendTime) : 'Never'}`);
        }
    } catch (error) {
        console.log('[DRIVE] No existing schedule found');
    }
}

// Save media file to Drive
async function saveMediaToDrive(buffer, mimeType, extension) {
    try {
        const token = await getDriveToken();
        const filename = `media_${Date.now()}_${Math.random().toString(36).substr(2, 8)}.${extension}`;
        const tempFile = path.join(TEMP_DIR, filename);
        fs.writeFileSync(tempFile, buffer);
        
        const formData = new FormData();
        formData.append('metadata', JSON.stringify({ 
            name: filename, 
            parents: [MEDIA_FOLDER_ID],
            mimeType: mimeType
        }), { contentType: 'application/json' });
        formData.append('file', fs.createReadStream(tempFile));
        
        const uploadResponse = await axios.post(UPLOAD_URL, formData, {
            headers: {
                'Authorization': `Bearer ${token}`,
                ...formData.getHeaders()
            }
        });
        
        fs.unlinkSync(tempFile);
        console.log(`[DRIVE] ✅ Media saved: ${uploadResponse.data.id}`);
        return uploadResponse.data.id;
        
    } catch (error) {
        console.error('[DRIVE] ❌ Failed to save media:', error.message);
        throw error;
    }
}

// Load media file from Drive
async function loadMediaFromDrive(fileId) {
    try {
        const token = await getDriveToken();
        const response = await axios.get(`${FILE_URL}/${fileId}?alt=media`, {
            headers: { 'Authorization': `Bearer ${token}` },
            responseType: 'arraybuffer'
        });
        return Buffer.from(response.data);
    } catch (error) {
        console.error('[DRIVE] ❌ Failed to load media:', error.message);
        throw error;
    }
}

// Delete media file from Drive
async function deleteMediaFromDrive(fileId) {
    try {
        const token = await getDriveToken();
        await axios.delete(`${FILE_URL}/${fileId}`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        console.log(`[DRIVE] ✅ Deleted media: ${fileId}`);
    } catch (error) {
        console.error('[DRIVE] ❌ Failed to delete media:', error.message);
    }
}

// Save post metadata to Drive
async function savePostToDrive(messageData, uniqueId, scheduledTime, position, mediaFileId = null) {
    try {
        const token = await getDriveToken();
        
        const saveData = {
            type: messageData.type,
            content: messageData.content,
            originalText: messageData.originalText,
            entities: messageData.entities,
            timestamp: messageData.timestamp,
            scheduledTime: scheduledTime.toISOString(),
            position: position,
            mediaFileId: mediaFileId
        };
        
        if (messageData.type === 'media') {
            saveData.mediaType = messageData.mediaType;
            saveData.size = messageData.size;
            saveData.mimeType = messageData.mimeType;
            saveData.fileName = messageData.fileName;
            saveData.caption = messageData.caption;
            saveData.originalCaption = messageData.originalCaption;
            saveData.captionEntities = messageData.captionEntities;
        }
        
        const filename = `post_${uniqueId}_${Date.now()}_${position}.json`;
        const fileContent = JSON.stringify(saveData, null, 2);
        
        console.log(`[DRIVE] 📤 Saving post #${position}: ${filename} at ${formatPakistanTime(scheduledTime)}`);
        
        const tempFile = path.join(TEMP_DIR, filename);
        fs.writeFileSync(tempFile, fileContent);
        
        const formData = new FormData();
        formData.append('metadata', JSON.stringify({ 
            name: filename, 
            parents: [POSTS_FOLDER_ID] 
        }), { contentType: 'application/json' });
        formData.append('file', fs.createReadStream(tempFile));
        
        const uploadResponse = await axios.post(UPLOAD_URL, formData, {
            headers: {
                'Authorization': `Bearer ${token}`,
                ...formData.getHeaders()
            }
        });
        
        fs.unlinkSync(tempFile);
        
        console.log(`[DRIVE] ✅ Post saved: ${uploadResponse.data.id}`);
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
        
        // Load media file if it's a media post
        if (messageData.type === 'media' && messageData.mediaFileId) {
            console.log(`[DRIVE] Loading media: ${messageData.mediaFileId}`);
            messageData.buffer = await loadMediaFromDrive(messageData.mediaFileId);
            console.log(`[DRIVE] ✅ Loaded media: ${messageData.buffer.length} bytes`);
        }
        
        console.log(`[DRIVE] ✅ Loaded post #${messageData.position}`);
        
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
        console.error('[DRIVE] ❌ Failed to delete post:', error.message);
    }
}

async function loadPendingPosts() {
    try {
        const token = await getDriveToken();
        
        const response = await axios.get(`${FILE_URL}?q='${POSTS_FOLDER_ID}'+in+parents+and+name+contains+'post_'&fields=files(id,name,createdTime)`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        
        const files = response.data.files || [];
        const posts = [];
        
        for (const file of files) {
            // Skip if this post is currently being processed
            if (processingPosts.has(file.id)) {
                console.log(`[DRIVE] Skipping post ${file.id} (currently being processed)`);
                continue;
            }
            
            try {
                const fileResponse = await axios.get(`${FILE_URL}/${file.id}?alt=media`, {
                    headers: { 'Authorization': `Bearer ${token}` },
                    responseType: 'text'
                });
                const postData = JSON.parse(fileResponse.data);
                posts.push({
                    id: file.id,
                    data: postData,
                    scheduledTime: new Date(postData.scheduledTime),
                    position: postData.position
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
async function sendPost(postData, postId) {
    console.log(`[SCHEDULER] 📤 Sending post #${postData.position}...`);
    
    // Reconstruct messageData from saved data
    const messageData = {
        type: postData.type,
        content: postData.content,
        originalText: postData.originalText,
        entities: postData.entities,
        timestamp: postData.timestamp
    };
    
    if (postData.type === 'media') {
        messageData.mediaType = postData.mediaType;
        messageData.size = postData.size;
        messageData.mimeType = postData.mimeType;
        messageData.fileName = postData.fileName;
        messageData.caption = postData.caption;
        messageData.originalCaption = postData.originalCaption;
        messageData.captionEntities = postData.captionEntities;
        messageData.buffer = postData.buffer;
        
        console.log(`[SCHEDULER] Media buffer size: ${messageData.buffer ? messageData.buffer.length : 0} bytes`);
        
        if (!messageData.buffer || messageData.buffer.length === 0) {
            console.error(`[SCHEDULER] ❌ No media buffer found for post #${postData.position}!`);
            return false;
        }
    }
    
    const success = await sendToAllDestinations(messageData);
    return success;
}

async function processQueue() {
    const posts = await loadPendingPosts();
    
    if (posts.length === 0) {
        console.log('[SCHEDULER] No pending posts');
        scheduledTask = null;
        return;
    }
    
    const now = getPakistanTime();
    const nextPost = posts[0];
    
    console.log(`[SCHEDULER] Next post #${nextPost.position} scheduled for: ${formatPakistanTime(nextPost.scheduledTime)}`);
    console.log(`[SCHEDULER] Current time: ${formatPakistanTime(now)}`);
    
    const timeDiff = now - nextPost.scheduledTime;
    const isWithinWindow = timeDiff >= 0 && timeDiff <= MISSED_POST_WINDOW_MS;
    const isTooOld = timeDiff > MISSED_POST_WINDOW_MS;
    
    // If scheduled time is in the future, wait
    if (nextPost.scheduledTime > now) {
        const delay = nextPost.scheduledTime - now;
        console.log(`[SCHEDULER] Waiting ${Math.floor(delay / 1000 / 60)} minutes until next post`);
        scheduledTask = setTimeout(processQueue, delay);
        return;
    }
    
    // Scheduled time is now or in the past
    if (isTooOld) {
        console.log(`[SCHEDULER] ⚠️ Post #${nextPost.position} is ${Math.floor(timeDiff / 1000 / 60)} minutes old - TOO OLD! Deleting.`);
        
        if (nextPost.data.mediaFileId) {
            await deleteMediaFromDrive(nextPost.data.mediaFileId);
        }
        await deletePostFromDrive(nextPost.id);
        
        console.log(`[SCHEDULER] 🗑️ Deleted expired post #${nextPost.position}`);
        setImmediate(processQueue);
        return;
    }
    
    if (isWithinWindow) {
        console.log(`[SCHEDULER] ⏰ Post #${nextPost.position} was missed by ${Math.floor(timeDiff / 1000 / 60)} minutes - sending now!`);
    } else {
        console.log(`[SCHEDULER] 📤 Time to send post #${nextPost.position}`);
    }
    
    // Mark as processing to prevent duplicate
    processingPosts.add(nextPost.id);
    
    const success = await sendPost(nextPost.data, nextPost.id);
    
    if (success) {
        if (nextPost.data.mediaFileId) {
            await deleteMediaFromDrive(nextPost.data.mediaFileId);
        }
        await deletePostFromDrive(nextPost.id);
        
        lastSendTime = now;
        await saveScheduleToDrive();
        
        console.log(`[SCHEDULER] ✅ Post #${nextPost.position} sent successfully at ${formatPakistanTime(now)}`);
    } else {
        console.log(`[SCHEDULER] ❌ Failed to send post #${nextPost.position}`);
    }
    
    // Remove from processing set
    processingPosts.delete(nextPost.id);
    
    // Continue processing next posts
    setImmediate(processQueue);
}

async function forceSendNextPost() {
    const posts = await loadPendingPosts();
    
    if (posts.length === 0) {
        return { success: false, message: "No posts in queue" };
    }
    
    const nextPost = posts[0];
    console.log(`[SCHEDULER] 🚀 Force sending post #${nextPost.position} immediately!`);
    
    // Mark as processing
    processingPosts.add(nextPost.id);
    
    const success = await sendPost(nextPost.data, nextPost.id);
    
    if (success) {
        if (nextPost.data.mediaFileId) {
            await deleteMediaFromDrive(nextPost.data.mediaFileId);
        }
        await deletePostFromDrive(nextPost.id);
        
        lastSendTime = getPakistanTime();
        await saveScheduleToDrive();
        
        console.log(`[SCHEDULER] ✅ Post #${nextPost.position} sent successfully`);
        
        // Update remaining posts' schedules
        const remainingPosts = await loadPendingPosts();
        if (remainingPosts.length > 0) {
            let currentTime = lastSendTime;
            for (let i = 0; i < remainingPosts.length; i++) {
                const post = remainingPosts[i];
                let newTime = addRandomHours(currentTime);
                
                const newHour = newTime.getHours();
                if (newHour >= NIGHT_START_HOUR || newHour < NIGHT_END_HOUR) {
                    const morningTime = new Date(newTime);
                    morningTime.setHours(NIGHT_END_HOUR, 0, 0, 0);
                    if (morningTime <= newTime) {
                        morningTime.setDate(morningTime.getDate() + 1);
                    }
                    newTime = morningTime;
                }
                
                console.log(`[SCHEDULER] Updating post #${post.position} to ${formatPakistanTime(newTime)}`);
                
                const token = await getDriveToken();
                const updatedData = { ...post.data, scheduledTime: newTime.toISOString() };
                const fileContent = JSON.stringify(updatedData, null, 2);
                const tempFile = path.join(TEMP_DIR, `update_${Date.now()}.json`);
                fs.writeFileSync(tempFile, fileContent);
                
                const formData = new FormData();
                formData.append('metadata', JSON.stringify({ name: post.id }), { contentType: 'application/json' });
                formData.append('file', fs.createReadStream(tempFile));
                
                await axios.patch(`${FILE_URL}/${post.id}?uploadType=multipart`, formData, {
                    headers: {
                        'Authorization': `Bearer ${token}`,
                        ...formData.getHeaders()
                    }
                });
                
                fs.unlinkSync(tempFile);
                currentTime = newTime;
            }
        }
        
        processingPosts.delete(nextPost.id);
        return { success: true, message: `Post #${nextPost.position} sent successfully` };
    } else {
        processingPosts.delete(nextPost.id);
        return { success: false, message: "Failed to send post" };
    }
}

async function queuePost(messageData, uniqueId) {
    const posts = await loadPendingPosts();
    const position = posts.length + 1;
    
    let scheduledTime;
    let mediaFileId = null;
    
    // Save media to Drive first if it's a media message
    if (messageData.type === 'media' && messageData.buffer && messageData.buffer.length > 0) {
        const ext = messageData.mediaType === 'photo' ? 'jpg' : 
                    messageData.mediaType === 'video' ? 'mp4' : 'bin';
        mediaFileId = await saveMediaToDrive(messageData.buffer, messageData.mimeType, ext);
        console.log(`[SCHEDULER] Media saved with ID: ${mediaFileId}`);
        
        // Remove buffer from messageData before saving to Drive (it will be reloaded later)
        delete messageData.buffer;
    }
    
    if (posts.length === 0 && !lastSendTime) {
        scheduledTime = getPakistanTime();
        console.log(`[SCHEDULER] First post #${position} - will send immediately after saving`);
    } else {
        let lastTime;
        if (posts.length > 0) {
            const lastPost = posts[posts.length - 1];
            lastTime = lastPost.scheduledTime;
            console.log(`[SCHEDULER] Last queued post scheduled at: ${formatPakistanTime(lastTime)}`);
        } else if (lastSendTime) {
            lastTime = lastSendTime;
            console.log(`[SCHEDULER] Last send time: ${formatPakistanTime(lastTime)}`);
        } else {
            lastTime = getPakistanTime();
        }
        
        scheduledTime = addRandomHours(lastTime);
        
        const scheduledHour = scheduledTime.getHours();
        if (scheduledHour >= NIGHT_START_HOUR || scheduledHour < NIGHT_END_HOUR) {
            const morningTime = new Date(scheduledTime);
            morningTime.setHours(NIGHT_END_HOUR, 0, 0, 0);
            if (morningTime <= scheduledTime) {
                morningTime.setDate(morningTime.getDate() + 1);
            }
            scheduledTime = morningTime;
            console.log(`[SCHEDULER] Adjusted for night: new time ${formatPakistanTime(scheduledTime)}`);
        }
        
        const delayHours = (scheduledTime - lastTime) / (1000 * 60 * 60);
        console.log(`[SCHEDULER] Scheduling post #${position} for: ${formatPakistanTime(scheduledTime)} (${delayHours.toFixed(2)}h delay)`);
    }
    
    // Save post metadata to Drive
    const postId = await savePostToDrive(messageData, uniqueId, scheduledTime, position, mediaFileId);
    
    // Now load the post back (which will load the media if needed) and send if immediate
    const now = getPakistanTime();
    if (scheduledTime <= now) {
        console.log(`[SCHEDULER] Post #${position} is immediate, loading and sending...`);
        
        // Load the post we just saved
        const loadedPost = await loadPostFromDrive(postId);
        
        if (loadedPost) {
            // Mark as processing
            processingPosts.add(postId);
            
            const success = await sendPost(loadedPost, postId);
            
            if (success) {
                if (loadedPost.mediaFileId) {
                    await deleteMediaFromDrive(loadedPost.mediaFileId);
                }
                await deletePostFromDrive(postId);
                lastSendTime = now;
                await saveScheduleToDrive();
                console.log(`[SCHEDULER] ✅ Immediate post #${position} sent successfully`);
                processingPosts.delete(postId);
                return { scheduledTime, position, sent: true };
            } else {
                console.log(`[SCHEDULER] ❌ Failed to send immediate post #${position}, will retry via scheduler`);
                processingPosts.delete(postId);
            }
        }
    }
    
    // Start scheduler if not running
    if (!scheduledTask) {
        const now = getPakistanTime();
        const nextPosts = await loadPendingPosts();
        if (nextPosts.length > 0) {
            const delay = Math.max(0, nextPosts[0].scheduledTime - now);
            console.log(`[SCHEDULER] Starting scheduler, first check in ${Math.floor(delay / 1000 / 60)} minutes`);
            if (delay > 0) {
                scheduledTask = setTimeout(processQueue, delay);
            } else {
                processQueue();
            }
        }
    }
    
    return { scheduledTime, position, sent: false };
}

// ===== FORMATTING FUNCTIONS =====
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
        } else if (messageData.type === 'media' && messageData.buffer) {
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
        } else {
            console.log(`[WHATSAPP] No buffer found for media`);
            return false;
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
        } else if (messageData.type === 'media' && messageData.buffer) {
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
        } else {
            console.log(`[TELEGRAM CHANNEL] No buffer found for media`);
            return false;
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
                } else if (messageData.type === 'media' && messageData.buffer) {
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
        } else if (messageData.type === 'media' && messageData.buffer) {
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
    console.log(`📁 Posts Folder ID: ${POSTS_FOLDER_ID}`);
    console.log(`📁 Media Folder ID: ${MEDIA_FOLDER_ID}`);
    console.log(`⏰ Random delay: ${MIN_DELAY_HOURS}-${MAX_DELAY_HOURS} hours between ALL DESTINATIONS posts`);
    console.log(`🌙 Night pause: ${NIGHT_START_HOUR}:00 - ${NIGHT_END_HOUR}:00 PKT`);
    console.log(`⏱️ Missed post window: ${MISSED_POST_WINDOW_MS / 1000 / 60} minutes`);
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
            `• 🌟 *ALL* - ⏰ **SCHEDULED** - Random ${MIN_DELAY_HOURS}-${MAX_DELAY_HOURS} hour delay between posts\n` +
            `• ❌ *Cancel* - Don't forward\n\n` +
            `*Commands:*\n` +
            `• /queue - Check queue status\n` +
            `• /time - Show current Pakistan time\n` +
            `• /schedule - Show next scheduled send time\n` +
            `• /send - Force send the next scheduled post immediately`;
        
        ctx.reply(helpMessage, { parse_mode: 'Markdown' });
    });
    
    telegrafBot.command('send', async (ctx) => {
        await ctx.answerCbQuery('⏳ Sending next post...');
        const result = await forceSendNextPost();
        
        if (result.success) {
            await ctx.reply(`✅ ${result.message}`);
        } else {
            await ctx.reply(`❌ ${result.message}`);
        }
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
        msg += `⏱️ *Next post #${nextPost.position} scheduled for:* ${formatPakistanTime(nextPost.scheduledTime)}\n`;
        
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
            const timeDiff = posts[i].scheduledTime - getPakistanTime();
            const isExpired = timeDiff < -MISSED_POST_WINDOW_MS;
            const expiredMark = isExpired ? ' ⚠️ EXPIRED (will be deleted)' : '';
            msg += `${i + 1}. Post #${posts[i].position}: ${formatPakistanTime(posts[i].scheduledTime)}${expiredMark}\n`;
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
                    [{ text: `⏰🌟 SCHEDULED (${MIN_DELAY_HOURS}-${MAX_DELAY_HOURS}h delay)`, callback_data: `${uniqueId}_all` }],
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
                        [{ text: `⏰🌟 SCHEDULED (${MIN_DELAY_HOURS}-${MAX_DELAY_HOURS}h delay)`, callback_data: `${uniqueId}_all` }],
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
                        [{ text: `⏰🌟 SCHEDULED (${MIN_DELAY_HOURS}-${MAX_DELAY_HOURS}h delay)`, callback_data: `${uniqueId}_all` }],
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
            const { scheduledTime, position, sent } = await queuePost(messageData, uniqueId);
            
            if (sent) {
                await ctx.editMessageText(`✅ *Post #${position} Sent Immediately!*`, { parse_mode: 'Markdown' });
            } else {
                const waitMinutes = Math.floor((scheduledTime - getPakistanTime()) / 1000 / 60);
                const responseMsg = 
                    `⏰ *Post #${position} Scheduled!*\n\n` +
                    `📅 *Scheduled for:* ${formatPakistanTime(scheduledTime)}\n` +
                    `⏱️ *Time remaining:* ${Math.floor(waitMinutes / 60)} hours ${waitMinutes % 60} minutes\n` +
                    `🎲 *Random delay:* ${MIN_DELAY_HOURS}-${MAX_DELAY_HOURS} hours\n` +
                    `🌙 *Night pause:* ${NIGHT_START_HOUR}:00-${NIGHT_END_HOUR}:00 PKT\n\n` +
                    `📋 *Total in queue:* ${position}`;
                
                await ctx.editMessageText(responseMsg, { parse_mode: 'Markdown' });
            }
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
            console.log(`⏰ Random delay: ${MIN_DELAY_HOURS}-${MAX_DELAY_HOURS} hours between ALL DESTINATIONS posts`);
            console.log(`🌙 Night pause: ${NIGHT_START_HOUR}:00 - ${NIGHT_END_HOUR}:00 PKT`);
            console.log(`⏱️ Missed post window: ${MISSED_POST_WINDOW_MS / 1000 / 60} minutes`);
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
                `⏰🌟 SCHEDULED ALL (Random ${MIN_DELAY_HOURS}-${MAX_DELAY_HOURS}h delay)`;
            await sock.sendMessage(from, { text: helpText });
        }
    });
}

// Load existing data on startup
async function loadExistingData() {
    await loadScheduleFromDrive();
    const posts = await loadPendingPosts();
    
    if (posts.length > 0) {
        console.log(`[STARTUP] Found ${posts.length} scheduled posts. Checking for missed posts...`);
        
        const now = getPakistanTime();
        let deletedCount = 0;
        
        // Delete any posts that are too old
        for (const post of posts) {
            const timeDiff = now - post.scheduledTime;
            if (timeDiff > MISSED_POST_WINDOW_MS) {
                console.log(`[STARTUP] 🗑️ Deleting expired post #${post.position} (${Math.floor(timeDiff / 1000 / 60)} minutes old)`);
                if (post.data.mediaFileId) {
                    await deleteMediaFromDrive(post.data.mediaFileId);
                }
                await deletePostFromDrive(post.id);
                deletedCount++;
            }
        }
        
        if (deletedCount > 0) {
            console.log(`[STARTUP] Deleted ${deletedCount} expired posts`);
        }
        
        // Get remaining posts
        const remainingPosts = await loadPendingPosts();
        
        if (remainingPosts.length > 0) {
            console.log(`[STARTUP] Starting scheduler with ${remainingPosts.length} remaining posts...`);
            const nextPost = remainingPosts[0];
            const delay = Math.max(0, nextPost.scheduledTime - now);
            console.log(`[STARTUP] Next post at: ${formatPakistanTime(nextPost.scheduledTime)} (${Math.floor(delay / 1000 / 60)} minutes)`);
            if (delay > 0) {
                scheduledTask = setTimeout(processQueue, delay);
            } else {
                processQueue();
            }
        }
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
