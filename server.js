require('dotenv').config();
const express = require('express');
const path = require('path');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const OpenAI = require('openai');
const NodeCache = require('node-cache');

// ─── Config ────────────────────────────────────────────────────────────────
const config = {
  openai: {
    apiKey: process.env.OPENAI_API_KEY,
    model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
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
  server: { port: parseInt(process.env.PORT || '3000', 10) },
  whatsapp: {
    sessionPath: process.env.SESSION_PATH || './.wwebjs_auth',
    cachePath: process.env.CACHE_PATH || './.wwebjs_cache',
  },
  logLevel: process.env.LOG_LEVEL || 'info',
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

// ─── Validation ────────────────────────────────────────────────────────────
if (!config.openai.apiKey || !config.openai.apiKey.startsWith('sk-')) {
  log.error('Missing or invalid OPENAI_API_KEY in .env');
  process.exit(1);
}

// ─── OpenAI + History ──────────────────────────────────────────────────────
const openai = new OpenAI({ apiKey: config.openai.apiKey });
const historyCache = new NodeCache({ stdTTL: 3600, checkperiod: 600 });

function buildSystemPrompt() {
  return `${config.bot.personality}

Rules:
- Be concise (WhatsApp style). Use short paragraphs, emojis sparingly.
- If the user writes in a specific language, reply in the same language.
- Never invent facts. If unsure, ask a clarifying question.
- Stay on topic; politely decline unrelated requests.
- Format replies for readability (bullets when listing).`;
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
  if (!userMessage || !userMessage.trim()) {
    return "I didn't catch that — could you rephrase? 🙂";
  }
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
        presence_penalty: 0.3,
        frequency_penalty: 0.3,
      });
      const reply =
        res.choices?.[0]?.message?.content?.trim() ||
        "Sorry, I couldn't generate a reply. Please try again.";
      appendHistory(chatId, 'assistant', reply);
      return reply;
    } catch (err) {
      log.warn(`OpenAI attempt ${attempt} failed:`, err.message);
      if (attempt === 3) {
        log.error('OpenAI failed after retries:', err);
        return "⚠️ I'm having trouble connecting right now. Please try again in a moment.";
      }
      await new Promise((r) => setTimeout(r, 1000 * attempt));
    }
  }
}

// ─── WhatsApp Client ───────────────────────────────────────────────────────
const client = new Client({
  authStrategy: new LocalAuth({ dataPath: config.whatsapp.sessionPath }),
  puppeteer: {
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
  },
});

async function extractText(msg) {
  if (msg.body && msg.body.trim()) return msg.body.trim();
  switch (msg.type) {
    case 'image': return msg.caption?.trim() || '[User sent an image]';
    case 'video': return msg.caption?.trim() || '[User sent a video]';
    case 'audio': return '[User sent a voice note]';
    case 'document': return msg.caption?.trim() || '[User sent a document]';
    case 'location': return '[User shared a location]';
    case 'sticker': return '[User sent a sticker]';
    default: return '';
  }
}

async function handleMessage(msg) {
  try {
    if (msg.from === 'status@broadcast') return;
    const chat = await msg.getChat();
    if (chat.isGroup) return; // ignore group chats by default

    const contact = await msg.getContact();
    const senderName = contact.pushname || contact.number || 'there';
    const chatId = msg.from;
    const text = await extractText(msg);

    // Commands
    if (text.startsWith('/')) {
      const cmd = text.toLowerCase().trim();
      if (cmd === '/reset' || cmd === '/clear') {
        historyCache.del(chatId);
        await msg.reply("🧹 Conversation cleared. Let's start fresh!");
        return;
      }
      if (cmd === '/help') {
        await msg.reply(
          '🤖 *Commands:*\n• /reset – clear chat history\n• /help – show this message\n\nOtherwise, just ask me anything!'
        );
        return;
      }
    }

    if (!text) return;
    log.info(`📩 [${senderName}] ${text.slice(0, 80)}`);

    await chat.sendStateTyping();
    const reply = await generateReply(chatId, text);
    const delay = Math.min(2500, 500 + reply.length * 15);
    await new Promise((r) => setTimeout(r, delay));
    await msg.reply(reply);
    log.info(`📤 [bot→${senderName}] ${reply.slice(0, 80)}`);
  } catch (err) {
    log.error('handleMessage error:', err);
    try { await msg.reply('⚠️ Something went wrong. Please try again.'); } catch (_) {}
  }
}

client.on('qr', (qr) => {
  log.info('📱 Scan this QR code with WhatsApp:');
  qrcode.generate(qr, { small: true });
});
client.on('authenticated', () => log.info('✅ Authenticated successfully.'));
client.on('auth_failure', (m) => log.error('❌ Auth failure:', m));
client.on('loading_screen', (p) => log.debug(`Loading... ${p}%`));
client.on('ready', () => log.info(`🚀 ${config.bot.name} is online and ready!`));
client.on('disconnected', (reason) => {
  log.warn('🔌 Client disconnected:', reason);
  log.info('Reinitializing in 5s...');
  setTimeout(() => client.initialize(), 5000);
});
client.on('message', handleMessage);

client.initialize();

// ─── Express Server ────────────────────────────────────────────────────────
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname)));

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    bot: config.bot.name,
    whatsappReady: !!client.info,
    uptime: process.uptime(),
  });
});

app.post('/send', async (req, res) => {
  const { to, message } = req.body;
  if (!to || !message) {
    return res.status(400).json({ error: 'to and message are required' });
  }
  try {
    if (!client.info) return res.status(503).json({ error: 'WhatsApp not ready yet' });
    const chatId = to.includes('@c.us') ? to : `${to}@c.us`;
    const sent = await client.sendMessage(chatId, message);
    res.json({ success: true, id: sent.id.id });
  } catch (err) {
    log.error('Send error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.listen(config.server.port, () => {
  log.info(`🌐 Web UI at http://localhost:${config.server.port}`);
});

// ─── Graceful Shutdown ─────────────────────────────────────────────────────
async function shutdown() {
  log.info('🛑 Shutting down gracefully...');
  try { await client.destroy(); } catch (_) {}
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('unhandledRejection', (err) => log.error('Unhandled rejection:', err));
process.on('uncaughtException', (err) => log.error('Uncaught exception:', err));
