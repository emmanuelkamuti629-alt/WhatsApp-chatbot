require('dotenv').config();
const express = require('express');
const path = require('path');
const makeWASocket = require('@whiskeysockets/baileys').default;
// Added fetchLatestWaWebVersion to fix the pairing rejection error
const { useMultiFileAuthState, DisconnectReason, fetchLatestWaWebVersion } = require('@whiskeysockets/baileys');
const QRCode = require('qrcode');
const OpenAI = require('openai');
const NodeCache = require('node-cache');
const pino = require('pino');

// ─── Config ────────────────────────────────────────────────────────────────
const config = {
  openai: {
    apiKey: process.env.GROQ_API_KEY || process.env.GEMINI_API_KEY || process.env.OPENAI_API_KEY,
    baseURL: process.env.GROQ_API_KEY 
      ? 'https://api.groq.com/openai/v1' 
      : (process.env.GEMINI_API_KEY ? 'https://generativelanguage.googleapis.com/v1beta/openai/' : undefined),
    model: process.env.OPENAI_MODEL || 'llama-3.3-70b-versatile',
    maxTokens: parseInt(process.env.OPENAI_MAX_TOKENS || '500', 10),
    temperature: parseFloat(process.env.OPENAI_TEMPERATURE || '0.7'),
  },
  bot: {
    name: process.env.BOT_NAME || 'Smart Assistant',
    personality: process.env.BOT_PERSONALITY || 'You are a helpful, accurate assistant.',
    maxHistory: parseInt(process.env.MAX_HISTORY_MESSAGES || '10', 10),
  },
  server: { port: process.env.PORT || 3000 },
  whatsapp: { sessionPath: process.env.SESSION_PATH || './.baileys_auth' }
};

// ─── AI Setup ──────────────────────────────────────────────────────────────
const openai = new OpenAI({ apiKey: config.openai.apiKey, baseURL: config.openai.baseURL });
const historyCache = new NodeCache({ stdTTL: 3600 });

async function generateReply(chatId, userMessage) {
  if (!userMessage) return null;
  let history = historyCache.get(chatId) || [];
  history.push({ role: 'user', content: userMessage });
  
  const messages = [{ role: 'system', content: config.bot.personality }, ...history];

  try {
    const res = await openai.chat.completions.create({
      model: config.openai.model,
      messages,
      max_tokens: config.openai.maxTokens,
      temperature: config.openai.temperature,
    });
    const reply = res.choices[0].message.content;
    history.push({ role: 'assistant', content: reply });
    historyCache.set(chatId, history.slice(-config.bot.maxHistory * 2));
    return reply;
  } catch (err) {
    console.error('AI Error:', err.message);
    return "⚠️ I'm having trouble thinking right now. Please try again.";
  }
}

// ─── Express Setup ─────────────────────────────────────────────────────────
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname)));
let latestQRDataUrl = null;
let isConnected = false;
let pairingCode = null;

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

app.get('/health', (req, res) => {
  res.json({ status: 'ok', bot: config.bot.name, whatsappReady: isConnected, qrPending: !!latestQRDataUrl });
});

app.get('/qr', (req, res) => {
  if (isConnected) {
    return res.send(`
      <body style="display:flex;justify-content:center;align-items:center;height:100vh;margin:0;background:#f0f2f5;font-family:sans-serif;">
        <h2 style="color:#25d366;">✅ WhatsApp Connected!<br>You can close this page.</h2>
      </body>
    `);
  }
  
  let contentHtml = '';

  if (pairingCode) {
    // Huge pairing code display
    contentHtml = `
      <div style="text-align:center; width: 100%;">
        <h2 style="color:#075e54; margin-bottom:10px;">Your Pairing Code</h2>
        <div style="font-size:clamp(40px, 12vw, 80px); font-weight:900; color:#128c7e; letter-spacing:5px; margin:20px 0; word-wrap:break-word;">
          ${pairingCode}
        </div>
        <div style="font-size:clamp(16px, 4vw, 22px); color:#3b4a54; line-height:1.6; text-align:left; max-width:500px; margin:0 auto; background:#fff; padding:20px; border-radius:12px; box-shadow:0 4px 12px rgba(0,0,0,0.05);">
          1. Open WhatsApp on your phone<br>
          2. Go to <b>Linked Devices</b><br>
          3. Tap <b>Link a Device</b><br>
          4. Tap <b>Link with phone number instead</b><br>
          5. Enter the code above
        </div>
      </div>
    `;
  } else if (latestQRDataUrl) {
    // Huge QR code display (75% of viewport width)
    contentHtml = `
      <div style="text-align:center; width: 100%;">
        <h2 style="color:#075e54; margin-bottom:10px;">Scan with WhatsApp</h2>
        <p style="color:#667781; font-size:clamp(16px, 4vw, 20px);">Linked Devices → Link a Device</p>
        <img src="${latestQRDataUrl}" style="width: 75vw; max-width: 400px; height: auto; border:10px solid #fff; border-radius:16px; box-shadow:0 8px 24px rgba(0,0,0,0.15); margin: 20px auto; display:block;" />
      </div>
    `;
  } else {
    contentHtml = `
      <div style="text-align:center;">
        <h2 style="color:#667781;">⏳ Starting up...</h2>
        <p>Refresh in 3 seconds.</p>
      </div>
    `;
  }

  // If not connected and no pairing code yet, show the input box
  let inputHtml = '';
  if (!pairingCode && !isConnected) {
    inputHtml = `
      <div style="margin-top:30px; background:#fff; padding:20px; border-radius:12px; box-shadow:0 4px 12px rgba(0,0,0,0.05); width:90%; max-width:500px; box-sizing:border-box;">
        <h3 style="margin-top:0; color:#075e54;">Prefer a Pairing Code?</h3>
        <p style="font-size:14px; color:#667781;">Enter your phone number with country code (no +).</p>
        <input id="phone" type="tel" placeholder="e.g. 254712345678" style="padding:15px; border-radius:8px; border:2px solid #ccc; width:100%; box-sizing:border-box; font-size:18px; margin-bottom:15px;">
        <button onclick="getCode()" style="padding:15px; background:#25d366; color:white; border:none; border-radius:8px; font-size:18px; font-weight:bold; cursor:pointer; width:100%;">Get Code</button>
      </div>
      <script>
        async function getCode() {
          const phone = document.getElementById('phone').value;
          if(!phone) return alert('Enter phone number with country code');
          document.querySelector('button').innerText = 'Generating...';
          await fetch('/request-pairing?phone=' + phone);
          setTimeout(() => window.location.reload(), 2000);
        }
      </script>
    `;
  }

  // Full page layout (occupies 3/4 of screen with padding)
  res.send(`<!DOCTYPE html>
<html>
<head>
  <title>WhatsApp Login</title>
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="refresh" content="30">
</head>
<body style="margin:0; padding:0; background:#f0f2f5; font-family:-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; display:flex; flex-direction:column; align-items:center; justify-content:center; min-height:100vh;">
  <div style="width:100%; padding:20px; display:flex; flex-direction:column; align-items:center; box-sizing:border-box;">
    ${contentHtml}
    ${inputHtml}
  </div>
</body>
</html>`);
});

// Endpoint to trigger pairing code
app.get('/request-pairing', async (req, res) => {
  const phone = req.query.phone;
  if (!phone) return res.status(400).send('Phone required');
  if (!sock) return res.status(500).send('Socket not ready');
  
  try {
    // Request the 8-digit code from WhatsApp
    const code = await sock.requestPairingCode(phone);
    pairingCode = code.match(/.{1,4}/g)?.join('-') || code; // Format as XXXX-XXXX
    latestQRDataUrl = null; // Hide QR if code is requested
    res.json({ success: true, code: pairingCode });
  } catch (err) {
    console.error('Pairing code error:', err);
    res.status(500).send('Failed to get code');
  }
});

app.post('/send', async (req, res) => {
  const { to, message } = req.body;
  if (!sock || !isConnected) return res.status(503).json({ error: 'WhatsApp not ready' });
  try {
    await sock.sendMessage(`${to}@s.whatsapp.net`, { text: message });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(config.server.port, '0.0.0.0', () => {
  console.log(`🌐 Web UI on port ${config.server.port}`);
});

// ─── WhatsApp Baileys Connection ───────────────────────────────────────────
let sock = null;

async function connectToWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState(config.whatsapp.sessionPath);
  
  // Fetch the latest version to prevent pairing rejection
  const { version } = await fetchLatestWaWebVersion({});
  console.log(`Using WhatsApp Web Version: ${version.join('.')}`);

  sock = makeWASocket({
    version, // Apply latest version
    auth: state,
    printQRInTerminal: false, 
    logger: pino({ level: 'silent' }),
    browser: ["Ubuntu", "Chrome", "20.0.04"],
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      if (!pairingCode) {
        latestQRDataUrl = await QRCode.toDataURL(qr, { width: 500, margin: 1 });
        console.log('📱 QR Code generated. Visit /qr to scan.');
      }
    }

    if (connection === 'close') {
      isConnected = false;
      latestQRDataUrl = null;
      pairingCode = null;
      const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      console.log('🔌 Connection closed. Reconnecting:', shouldReconnect);
      if (shouldReconnect) setTimeout(connectToWhatsApp, 3000);
    } else if (connection === 'open') {
      isConnected = true;
      latestQRDataUrl = null;
      pairingCode = null;
      console.log('🚀 WhatsApp Bot is ONLINE!');
    }
  });

  sock.ev.on('messages.upsert', async (m) => {
    const msg = m.messages[0];
    if (!msg.message || msg.key.fromMe) return;
    if (msg.key.remoteJid === 'status@broadcast') return;

    const text = msg.message.conversation || msg.message.extendedTextMessage?.text;
    if (!text) return;

    const chatId = msg.key.remoteJid;
    console.log(`📩 Incoming from ${chatId}: ${text.slice(0, 50)}`);

    const reply = await generateReply(chatId, text);
    if (reply) {
      await sock.sendMessage(chatId, { text: reply });
      console.log(`📤 Replied: ${reply.slice(0, 50)}`);
    }
  });
}

connectToWhatsApp();
