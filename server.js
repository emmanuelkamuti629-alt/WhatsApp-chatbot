require('dotenv').config();
const express = require('express');
const path = require('path');
const makeWASocket = require('@whiskeysockets/baileys').default;
const { useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
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
  if (isConnected) return res.send('<h2 style="text-align:center;font-family:sans-serif;padding:40px;">✅ WhatsApp Connected! You can close this page.</h2>');
  
  let codeHtml = '';
  if (pairingCode) {
    codeHtml = `
      <div style="background:#fff; padding:20px; border-radius:12px; margin-top:20px; box-shadow:0 4px 12px rgba(0,0,0,0.1);">
        <h3>Your Pairing Code: <span style="color:#25d366; font-size:28px; letter-spacing:2px;">${pairingCode}</span></h3>
        <p>1. Open WhatsApp on your phone<br>2. Go to Linked Devices<br>3. Tap "Link a Device"<br>4. Tap "Link with phone number instead"<br>5. Enter this code</p>
      </div>
    `;
  } else if (!isConnected) {
    codeHtml = `
      <div style="background:#fff; padding:20px; border-radius:12px; margin-top:20px; box-shadow:0 4px 12px rgba(0,0,0,0.1);">
        <h3>Want to use a Pairing Code instead?</h3>
        <input id="phone" type="tel" placeholder="e.g. 254712345678" style="padding:10px; border-radius:6px; border:1px solid #ccc; width:80%; margin-bottom:10px;">
        <br>
        <button onclick="getCode()" style="padding:10px 20px; background:#25d366; color:white; border:none; border-radius:6px; font-weight:bold; cursor:pointer;">Get Pairing Code</button>
      </div>
      <script>
        async function getCode() {
          const phone = document.getElementById('phone').value;
          if(!phone) return alert('Enter phone number with country code (no +)');
          await fetch('/request-pairing?phone=' + phone);
          setTimeout(() => window.location.reload(), 2000);
        }
      </script>
    `;
  }

  res.send(`<!DOCTYPE html><html><head><title>WhatsApp Login</title>
<style>body{font-family:sans-serif;text-align:center;padding:20px;background:#f0f2f5} img{border:8px solid #fff;border-radius:12px; max-width:100%;}</style></head>
<body>
  <h2>📱 WhatsApp Login</h2>
  ${latestQRDataUrl ? `<p>Scan with WhatsApp (Linked Devices)</p><img src="${latestQRDataUrl}" />` : '<p>Starting up... Refresh in 3 seconds.</p>'}
  ${codeHtml}
  <meta http-equiv="refresh" content="30">
</body></html>`);
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

  sock = makeWASocket({
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
        latestQRDataUrl = await QRCode.toDataURL(qr, { width: 320, margin: 2 });
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
