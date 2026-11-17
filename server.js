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

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

app.get('/health', (req, res) => {
  res.json({ status: 'ok', bot: config.bot.name, whatsappReady: isConnected, qrPending: !!latestQRDataUrl });
});

app.get('/qr', (req, res) => {
  if (isConnected) return res.send('<h2>✅ WhatsApp Connected!</h2>');
  if (!latestQRDataUrl) return res.send('<h2>⏳ Starting up... Refresh in 3s</h2><meta http-equiv="refresh" content="3">');
  res.send(`<!DOCTYPE html><html><head><title>WhatsApp QR</title>
<style>body{font-family:sans-serif;text-align:center;padding:40px;background:#f0f2f5} img{border:8px solid #fff;border-radius:12px;}</style></head>
<body><h2>📱 Scan with WhatsApp</h2><p>Linked Devices → Link a Device</p><img src="${latestQRDataUrl}" /><p>Page auto-refreshes every 20s</p><meta http-equiv="refresh" content="20"></body></html>`);
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
    printQRInTerminal: false, // We handle QR via Web UI
    logger: pino({ level: 'silent' }),
    browser: ["Ubuntu", "Chrome", "20.0.04"],
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      latestQRDataUrl = await QRCode.toDataURL(qr, { width: 320, margin: 2 });
      console.log('📱 QR Code generated. Visit /qr to scan.');
    }

    if (connection === 'close') {
      isConnected = false;
      latestQRDataUrl = null;
      const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      console.log('🔌 Connection closed. Reconnecting:', shouldReconnect);
      if (shouldReconnect) setTimeout(connectToWhatsApp, 3000);
    } else if (connection === 'open') {
      isConnected = true;
      latestQRDataUrl = null;
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
