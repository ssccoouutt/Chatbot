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
                // Inform user that the bot is processing the link
                await sock.sendMessage(from, { text: "Detecting direct link... Downloading file, please wait." }, { quoted: msg });

                // Fetch headers to get filename and mimetype
                const response = await axios.head(url, { timeout: 10000 });
                const contentType = response.headers['content-type'] || 'application/octet-stream';
                
                // Try to extract filename from content-disposition or URL
                let fileName = 'file';
                const contentDisposition = response.headers['content-disposition'];
                if (contentDisposition && contentDisposition.includes('filename=')) {
                    fileName = contentDisposition.split('filename=')[1].split(';')[0].replace(/"/g, '').trim();
                } else {
                    fileName = path.basename(new URL(url).pathname) || 'file';
                }

                // Send the file as a document
                await sock.sendMessage(from, {
                    document: { url: url },
                    mimetype: contentType,
                    fileName: fileName
                }, { quoted: msg });

            } catch (error) {
                console.error("Error downloading file:", error);
                // If it's not a direct download link or error occurs, we don't necessarily need to spam the user
                // but for this specific request, we can notify them if the link failed.
                // await sock.sendMessage(from, { text: "Failed to download from the link. Make sure it's a direct download link." }, { quoted: msg });
            }
        }
    });
}

startBot();
