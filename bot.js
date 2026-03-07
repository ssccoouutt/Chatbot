const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    generateForwardMessageContent,
    prepareWAMessageMedia,
    generateWAMessageFromContent,
    generateWAMessageID,
    downloadContentFromMessage,
    makeInMemoryStore,
    jidDecode,
    proto
} = require("@whiskeysockets/baileys");
const pino = require("pino");
const { Boom } = require("@hapi/boom");
const qrcode = require("qrcode-terminal");
const axios = require("axios");
const path = require("path");
const fs = require("fs");
const { promisify } = require("util");
const pipeline = promisify(require("stream").pipeline);

/**
 * Function to check if a string is a valid URL
 */
function isUrl(url) {
    return url.match(new RegExp(/https?:\/\/(www\.)?[-a-zA-Z0-9@:%._+~#=]{1,256}\.[a-zA-Z0-9()]{1,6}\b([-a-zA-Z0-9()@:%_+.~#?&/=]*)/, 'gi'));
}

async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState("session");
    const { version, isLatest } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version,
        logger: pino({ level: "silent" }),
        printQRInTerminal: true,
        auth: state,
    });

    sock.ev.on("connection.update", (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (qr) {
            qrcode.generate(qr, { small: true });
        }
        if (connection === "close") {
            const shouldReconnect = (lastDisconnect.error instanceof Boom)?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log("Connection closed due to ", lastDisconnect.error, ", reconnecting ", shouldReconnect);
            if (shouldReconnect) {
                startBot();
            }
        } else if (connection === "open") {
            console.log("Opened connection");
        }
    });

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("messages.upsert", async (m) => {
        const msg = m.messages[0];
        if (!msg.message || msg.key.fromMe) return;

        const from = msg.key.remoteJid;
        const messageType = Object.keys(msg.message)[0];
        const text = messageType === "conversation" ? msg.message.conversation :
                     messageType === "extendedTextMessage" ? msg.message.extendedTextMessage.text : "";

        if (!text) return;

        // Handle "hi" command
        if (text.toLowerCase() === "hi") {
            await sock.sendMessage(from, { text: "hlw are you" }, { quoted: msg });
        } 
        // Handle "king" command
        else if (text.toLowerCase() === "king") {
            await sock.sendMessage(from, { 
                document: { url: './dummy.txt' }, 
                mimetype: 'text/plain', 
                fileName: 'dummy.txt' 
            }, { quoted: msg });
        }
        // Handle direct download links
        else if (isUrl(text)) {
            const url = text.trim();
            try {
                await sock.sendMessage(from, { text: "Detecting direct link..." }, { quoted: msg });

                const headResponse = await axios.head(url, { timeout: 10000 });
                const contentType = headResponse.headers['content-type'] || 'application/octet-stream';
                const contentLength = parseInt(headResponse.headers['content-length'], 10);
                const isMedia = contentType.startsWith('image/') || contentType.startsWith('video/');
                const isUnder100MB = contentLength && contentLength <= 100 * 1024 * 1024; // 100 MB

                let fileName = 'file';
                const contentDisposition = headResponse.headers['content-disposition'];
                if (contentDisposition && contentDisposition.includes('filename=')) {
                    fileName = contentDisposition.split('filename=')[1].split(';')[0].replace(/"/g, '').trim();
                } else {
                    fileName = path.basename(new URL(url).pathname) || 'file';
                }

                if (isMedia && isUnder100MB) {
                    await sock.sendMessage(from, { text: "Downloading media, please wait." }, { quoted: msg });
                    if (contentType.startsWith('image/')) {
                        await sock.sendMessage(from, { image: { url: url }, caption: fileName }, { quoted: msg });
                    } else if (contentType.startsWith('video/')) {
                        await sock.sendMessage(from, { video: { url: url }, caption: fileName }, { quoted: msg });
                    }
                } else {
                    await sock.sendMessage(from, { text: "Downloading document, please wait." }, { quoted: msg });
                    await sock.sendMessage(from, {
                        document: { url: url },
                        mimetype: contentType,
                        fileName: fileName
                    }, { quoted: msg });
                }

            } catch (error) {
                console.error("Error processing file from URL:", error);
                await sock.sendMessage(from, { text: "Failed to process the link. Make sure it's a direct download link and accessible." }, { quoted: msg });
            }
        }
    });
}

startBot();
