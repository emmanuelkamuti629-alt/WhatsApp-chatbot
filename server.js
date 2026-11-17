require('dotenv').config();
const express = require('express');
const path = require('path');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const QRCode = require('qrcode');
const OpenAI = require('openai');
const NodeCache = require('node-cache');

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
    personality:
      process.env.BOT_PERSONALITY ||
      'You are a helpful, accurate assistant. Answer clearly and concisely.',
    maxHistory: parseInt(process.env.MAX_HISTORY_MESSAGES || '10', 10),
  },
  server: {
    port: parseInt(process.env.PORT || '3000', 10),
    host: '0.0.0.0',
  },
  whatsapp: {
    sessionPath: process.env.SESSION_PATH || './.wwebjs_auth',
  },
  logLevel: process.env.LOG_LEVEL || 'info',
  publicUrl: process.env.RENDER_EXTERNAL_URL || '',
};

// ─── Logger ────────────────────────────────────────────────────────────────
const levels = { error: 0, warn: 1, info: 2, debug: 3 };
const curLevel = levels[config.logLevel] ?? 2;
const ts = () => new Date().toISOString();
const log = {
  error: (...a) => curLevel >= 0 && console.error(`[${ts()}] ❌`, ...a),
  warn: (...a) => curLevel >= 1 && console.warn(`[${ts()}] ⚠️`, ...a),
  info: (...a) => curLevel >= 2 && console.log(`[${ts()}] ℹ️`, ...a),
  debug: (...a) => curLevel >= 3 && console.log(`[${ts()}] 🐛`, ...a),
};

if (!config.openai.apiKey) {
  log.error('Missing API Key (GROQ_API_KEY or GEMINI_API_KEY) in environment variables');
  process.exit(1);
}

// ─── OpenAI + History ──────────────────────────────────────────────────────
const openai = new OpenAI({ 
  apiKey: config.openai.apiKey,
  baseURL: config.openai.baseURL
});
const historyCache = new NodeCache({ stdTTL: 3600, checkperiod: 600 });

let latestQR = null;
let latestQRDataUrl = null;

function buildSystemPrompt() {
  return `${config.bot.personality}\n\nRules:\n- Be concise (WhatsApp style).\n- Reply in the user's language.\n- Never invent facts.`;
}

function getHistory(chatId) {
  return historyCache.get(chatId) || [];
}

function appendHistory(chatId, role, content) {
  const history = getHistory(chatId);
  history.push({ role, content });
  historyCache.set(chatId, history.slice(-config.bot.maxHistory * 2));
}

async function generateReply(chatId, userMessage) {
  if (!userMessage || !userMessage.trim()) return "I didn't catch that — could you rephrase? 🙂";
  appendHistory(chatId, 'user', userMessage);

  const messages = [
    { role: 'system', content: buildSystemPrompt() },
    ...getHistory(chatId),
  ];

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await openai.chat.completions.create({
        model: config.openai.model,
        messages,
        max_tokens: config.openai.maxTokens,
        temperature: config.openai.temperature,
      });
      const reply = res.choices?.[0]?.message?.content?.trim() || "Sorry, I couldn't generate a reply.";
      appendHistory(chatId, 'assistant', reply);
      return reply;
    } catch (err) {
      log.warn(`AI attempt ${attempt} failed:`, err.message);
      if (attempt === 3) return "⚠️ I'm having trouble connecting right now.";
      await new Promise((r) => setTimeout(r, 1000 * attempt));
    }
  }
}

// ─── Chrome Path Resolution ────────────────────────────────────────────────
// Puppeteer normally looks in ~/.cache/puppeteer on Render. 
// We define the args carefully to prevent crashes on small cloud instances.
const puppeteerConfig = {
  headless: true,
  args: [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-accelerated-2d-canvas',
    '--no-first-run',
    '--no-zygote',
    '--disable-gpu',
  ],
};

// If Render successfully downloaded Chrome during the build phase, 
// it puts it in /opt/render/.cache/puppeteer. Puppeteer finds this automatically.

// ─── WhatsApp Client ───────────────────────────────────────────────────────
const client = new Client({
  authStrategy: new LocalAuth({ dataPath: config.whatsapp.sessionPath }),
  puppeteer: puppeteerConfig,
});

async function extractText(msg) {
  if (msg.body && msg.body.trim()) return msg.body.trim();
  return '';
}

async function handleMessage(msg) {
  try {
    if (msg.from === 'status@broadcast') return;
    const chat = await msg.getChat();
    if (chat.isGroup) return;

    const text = await extractText(msg);
    if (!text) return;

    log.info(`📩 Incoming: ${text.slice(0, 50)}...`);
    await chat.sendStateTyping();
    const reply = await generateReply(msg.from, text);
    await msg.reply(reply);
    log.info(`📤 Replied: ${reply.slice(0, 50)}...`);
  } catch (err) {
    log.error('handleMessage error:', err);
  }
}

client.on('qr', async (qr) => {
  latestQR = qr;
  log.info('📱 QR Code generated. Visit /qr to scan.');
  try {
    latestQRDataUrl = await QRCode.toDataURL(qr, { width: 320, margin: 2 });
  } catch (e) {
    log.warn('Failed to generate QR image');
  }
});

client.on('ready', () => {
  log.info(`🚀 Bot is online and ready!`);
  latestQR = null;
  latestQRDataUrl = null;
});

client.on('auth_failure', (m) => log.error('❌ Auth failure:', m));
client.on('disconnected', (reason) => {
  log.warn('🔌 Disconnected:', reason);
  setTimeout(() => client.initialize(), 5000);
});

client.on('message', handleMessage);

// Start Client with a 90-second timeout to prevent infinite hangs
log.info('Starting WhatsApp Client...');
Promise.race([
  client.initialize(),
  new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout: Chrome failed to start in 90s')), 90000))
]).catch((e) => log.error('Client Init Failed:', e.message));

// ─── Express Server ────────────────────────────────────────────────────────
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname)));

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    whatsappReady: !!client.info,
    qrPending: !!latestQR,
  });
});

app.get('/qr', (req, res) => {
  if (client.info) return res.send('<h2>✅ Already authenticated. No QR needed.</h2>');
  if (!latestQRDataUrl) {
    return res.send('<h2>⏳ QR not ready yet. Check Render logs for errors.</h2><meta http-equiv="refresh" content="3">');
  }
  res.send(`<!DOCTYPE html><html><head><title>WhatsApp QR</title>
<style>body{font-family:sans-serif;text-align:center;padding:40px;background:#f0f2f5}
img{border:8px solid #fff;border-radius:12px;box-shadow:0 8px 24px rgba(0,0,0,0.15)}</style></head>
<body><h2>📱 Scan with WhatsApp</h2><p>Linked Devices → Link a Device</p>
<img src="${latestQRDataUrl}" alt="QR Code" />
<p>Page auto-refreshes every 20s</p><meta http-equiv="refresh" content="20"></body></html>`);
});

app.post('/send', async (req, res) => {
  const { to, message } = req.body;
  try {
    if (!client.info) return res.status(503).json({ error: 'WhatsApp not ready' });
    const chatId = to.includes('@c.us') ? to : `${to}@c.us`;
    await client.sendMessage(chatId, message);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(config.server.port, config.server.host, () => {
  log.info(`🌐 Web UI listening on port ${config.server.port}`);
});
