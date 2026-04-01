const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');

// HARDCODED FILE ID
const SCHEDULE_FILE_ID = "1tzY2CysClbADcj1zEgLwfzzRAFYOr6Wu";
const TOKEN_URL = "https://drive.usercontent.google.com/download?id=1NZ3NvyVBnK85S8f5eTZJS5uM5c59xvGM&export=download";

async function getAuth() {
    // Download token
    const tokenResponse = await axios({ method: 'GET', url: TOKEN_URL, responseType: 'stream' });
    const tempDir = path.join(__dirname, 'temp');
    if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });
    const tokenFile = path.join(tempDir, 'token.json');
    const writer = fs.createWriteStream(tokenFile);
    tokenResponse.data.pipe(writer);
    await new Promise((resolve, reject) => { writer.on('finish', resolve); writer.on('error', reject); });
    
    const tokenData = JSON.parse(fs.readFileSync(tokenFile, 'utf8'));
    fs.unlinkSync(tokenFile);
    
    // Refresh if needed
    if (new Date() > new Date(tokenData.expiry)) {
        const refresh = await axios.post(tokenData.token_uri, {
            client_id: tokenData.client_id,
            client_secret: tokenData.client_secret,
            refresh_token: tokenData.refresh_token,
            grant_type: 'refresh_token'
        });
        tokenData.token = refresh.data.access_token;
    }
    
    return { Authorization: `Bearer ${tokenData.token}` };
}

async function saveSchedule(content) {
    const auth = await getAuth();
    const tempFile = path.join(__dirname, 'temp', 'schedule.txt');
    fs.writeFileSync(tempFile, content);
    
    console.log(`Saving to file ID: ${SCHEDULE_FILE_ID}`);
    console.log(`Content: "${content}"`);
    
    // Use the googleapis library - more reliable
    const drive = google.drive({ version: 'v3', headers: auth });
    
    const media = {
        mimeType: 'text/plain',
        body: fs.createReadStream(tempFile)
    };
    
    await drive.files.update({
        fileId: SCHEDULE_FILE_ID,
        media: media,
        fields: 'id'
    });
    
    fs.unlinkSync(tempFile);
    console.log('✅ SAVED!');
}

async function loadSchedule() {
    const auth = await getAuth();
    const drive = google.drive({ version: 'v3', headers: auth });
    
    const response = await drive.files.get({
        fileId: SCHEDULE_FILE_ID,
        alt: 'media'
    }, { responseType: 'text' });
    
    console.log(`Loaded content: "${response.data}"`);
    return response.data;
}

// TEST
(async () => {
    const testTime = new Date().toISOString();
    console.log(`\n=== TESTING ===`);
    console.log(`Test time: ${testTime}`);
    
    await saveSchedule(testTime);
    const loaded = await loadSchedule();
    
    if (loaded === testTime) {
        console.log('✅ SUCCESS! Schedule saved and loaded correctly!');
    } else {
        console.log('❌ FAILED! Mismatch');
    }
})();
