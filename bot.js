const { makeWASocket } = require("@whiskeysockets/baileys");

async function startBot() {
  const sock = makeWASocket({
    printQRInTerminal: true
  });

  sock.ev.on("connection.update", (update) => {
    if (update.qr) {
      console.log("SCAN THIS QR: https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=" + 
        encodeURIComponent(update.qr));
    }
    if (update.connection === "open") console.log("✅ Connected!");
  });

  sock.ev.on("messages.upsert", async ({ messages }) => {
    const msg = messages[0];
    if (msg?.message?.conversation?.toLowerCase() === "hi") {
      await sock.sendMessage(msg.key.remoteJid, { text: "Hello!" });
    }
  });
}

startBot().catch(console.error);
