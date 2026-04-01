const axios = require('axios');
const fs = require('fs');
const path = require('path');
const FormData = require('form-data');

// HARDCODED FILE ID
const SCHEDULE_FILE_ID = "1tzY2CysClbADcj1zEgLwfzzRAFYOr6Wu";
const TOKEN_URL = "https://drive.usercontent.google.com/download?id=1NZ3NvyVBnK85S8f5eTZJS5uM5c59xvGM&export=download";
const FILE_URL = "https://www.googleapis.com/drive/v3/files";
const TEMP_DIR = path.join(__dirname, 'temp');

if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });

async function getToken() {
    const response = await axios({ method: 'GET', url: TOKEN_URL, responseType: 'stream' });
    const tokenFile = path.join(TEMP_DIR, 'token.json');
    const writer = fs.createWriteStream(tokenFile);
    response.data.pipe(writer);
    await new Promise((resolve, reject) => { writer.on('finish', resolve); writer.on('error', reject); });
    const tokenData = JSON.parse(fs.readFileSync(tokenFile, 'utf8'));
    fs.unlinkSync(tokenFile);
    
    if (new Date() > new Date(tokenData.expiry)) {
        const refresh = await axios.post(tokenData.token_uri, {
            client_id: tokenData.client_id,
            client_secret: tokenData.client_secret,
            refresh_token: tokenData.refresh_token,
            grant_type: 'refresh_token'
        });
        tokenData.token = refresh.data.access_token;
    }
    return tokenData.token;
}

async function saveSchedule(content) {
    const token = await getToken();
    const tempFile = path.join(TEMP_DIR, 'schedule.txt');
    fs.writeFileSync(tempFile, content);
    
    console.log(`Saving to file ID: ${SCHEDULE_FILE_ID}`);
    console.log(`Content: "${content}"`);
    
    await axios.patch(`${FILE_URL}/${SCHEDULE_FILE_ID}?uploadType=media`, fs.createReadStream(tempFile), {
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'text/plain' }
    });
    
    fs.unlinkSync(tempFile);
    console.log('✅ SAVED!');
}

async function loadSchedule() {
    const token = await getToken();
    const response = await axios.get(`${FILE_URL}/${SCHEDULE_FILE_ID}?alt=media`, {
        headers: { 'Authorization': `Bearer ${token}` },
        responseType: 'text'
    });
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
