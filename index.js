// ===== CONFIG ===== //
const config = {
  botName: "Hi Bot",
  sessionPath: "./session"
};

// ===== MAIN BOT ===== //
const { makeWASocket, useMultiFileAuthState } = require("@whiskeysockets/baileys");
const fs = require("fs");

async function startBot() {
  console.log("🚀 Starting bot...");
  
  // Auth
  const { state, saveCreds } = await useMultiFileAuthState(config.sessionPath);

  // Connect
  const sock = makeWASocket({
    auth: { creds: state.creds, keys: state.keys },
    printQRInTerminal: true
  });

  // Message Handler
  sock.ev.on("messages.upsert", async ({ messages }) => {
    const msg = messages[0];
    if (!msg?.message) return;

    const text = (msg.message.conversation || "").toLowerCase();
    const chatId = msg.key.remoteJid;

    if (text === "hi") {
      await sock.sendMessage(chatId, { text: "Hello!" });
    }
  });

  // Connection Events
  sock.ev.on("connection.update", (update) => {
    if (update.connection === "open") console.log("✅ Connected to WhatsApp!");
  });

  // Save session
  sock.ev.on("creds.update", saveCreds);
}

startBot().catch(err => console.error("❌ Error:", err));
