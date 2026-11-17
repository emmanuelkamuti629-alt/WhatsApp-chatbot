
require('dotenv').config();

const express = require('express');
const path = require('path');
const fs = require('fs');
const OpenAI = require('openai');
const NodeCache = require('node-cache');
const pino = require('pino');
const QRCode = require('qrcode');
const { MongoClient } = require('mongodb');
const crypto = require('crypto');

const {
  default: makeWASocket,
  DisconnectReason,
  initAuthCreds,
  BufferJSON
} = require('@whiskeysockets/baileys');

// =====================================================
// CONFIGURATION
// =====================================================

const config = {
  port: Number(process.env.PORT || 3000),
  mongoUri: process.env.MONGODB_URI,
  database: process.env.MONGODB_DB_NAME || 'whatsapp_bot',

  geminiKey: process.env.GEMINI_API_KEY,
  geminiModel: process.env.GEMINI_MODEL || 'gemini-3.8-flash',
  geminiBaseURL:
    'https://generativelanguage.googleapis.com/v1beta/openai/',

  adminToken: process.env.ADMIN_CONTROL_TOKEN || '',

  takeoverDelay: 10 * 60 * 1000,

  maxHistory: Math.max(
    1,
    Number(process.env.MAX_HISTORY_MESSAGES || 10)
  ),

  maxTokens: Math.min(
    250,
    Math.max(80, Number(process.env.OPENAI_MAX_TOKENS || 180))
  ),

  temperature: Number(process.env.OPENAI_TEMPERATURE || 0.7),

  personality: `
You are Manny. Your name is ALWAYS Manny.

IDENTITY:
- If asked who you are, say "I'm Manny 😊".
- If asked "We ni nani?", say "Mimi ni Manny 😊".
- Never invent another name.
- Never introduce yourself as a generic chatbot.

PERSONALITY:
- Friendly, confident, humorous and natural.
- Talk like a normal Kenyan WhatsApp user.
- Be helpful and conversational.
- Avoid robotic language.

SHORT REPLIES:
- Keep replies short and complete.
- Normally use one sentence.
- Maximum two short sentences when necessary.
- Do not repeat the user's message.
- Avoid unnecessary explanations.

LANGUAGES:
- Understand English, Kiswahili, Kenyan Sheng and common Gikuyu expressions.
- Respond naturally in the language used by the sender.
- Understand mixed English, Swahili and Sheng.

GENDER RULES:
- Never determine gender from a name alone.
- Never assume gender from a profile name, nickname or writing style.
- Only use he/him or she/her when the person has clearly confirmed their gender.
- If uncertain, use the person's name or neutral wording.
- Never guess someone's gender.

IMPORTANT:
Always maintain Manny's identity.
Keep WhatsApp responses brief and natural.
`
};

// =====================================================
// APPLICATION
// =====================================================

const app = express();

app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const mongoClient = new MongoClient(config.mongoUri || '', {
  serverSelectionTimeoutMS: 10000,
  connectTimeoutMS: 10000,
  maxPoolSize: 30
});

const logger = pino({
  level: process.env.BAILEYS_LOG_LEVEL || 'silent'
});

const historyCache = new NodeCache({
  stdTTL: 86400,
  checkperiod: 600
});

const aiClient = config.geminiKey
  ? new OpenAI({
      apiKey: config.geminiKey,
      baseURL: config.geminiBaseURL,
      timeout: 30000,
      maxRetries: 1
    })
  : null;

let authCollection;
let settingsCollection;
let chatsCollection;
let accountsCollection;

let mongoConnected = false;
let aiConnected = false;
let shuttingDown = false;

let botPower = true;
let groupMessaging = false;
let announcementRunning = false;

const accounts = new Map();
const adminActivity = new Map();

const startedAt = new Date();

// =====================================================
// LOGGING
// =====================================================

function log(level, message, details) {
  const prefix = `[${new Date().toISOString()}] [${level}]`;

  const method =
    level === 'ERROR' ? 'error' :
    level === 'WARN' ? 'warn' : 'log';

  console[method](
    prefix,
    message,
    details === undefined ? '' : safe(details)
  );
}

function safe(value) {
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      status: value.status,
      code: value.code
    };
  }

  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function maskJid(jid) {
  if (!jid) return 'unknown';

  const number = String(jid).split('@')[0];

  return number.length > 4
    ? `${number.slice(0, 3)}******${number.slice(-2)}`
    : '****';
}

function validAccountId(id) {
  return /^[a-zA-Z0-9_-]{1,40}$/.test(String(id || ''));
}

// =====================================================
// ADMIN AUTHENTICATION
// =====================================================

function adminAuth(req, res, next) {
  if (!config.adminToken) {
    return next();
  }

  const supplied =
    req.headers['x-admin-token'] ||
    req.query.token ||
    '';

  const a = Buffer.from(String(supplied));
  const b = Buffer.from(String(config.adminToken));

  if (
    a.length !== b.length ||
    !crypto.timingSafeEqual(a, b)
  ) {
    return res.status(401).json({
      error: 'Invalid admin token.'
    });
  }

  next();
}

// =====================================================
// DATABASE SETTINGS
// =====================================================

async function loadSettings() {
  const saved = await settingsCollection.findOne({
    _id: 'global'
  });

  if (saved) {
    botPower = saved.botPower !== false;
    groupMessaging = saved.groupMessaging === true;
  }

  log('INFO', 'Settings loaded', {
    botPower,
    groupMessaging
  });
}

async function saveSettings() {
  await settingsCollection.updateOne(
    { _id: 'global' },
    {
      $set: {
        botPower,
        groupMessaging,
        updatedAt: new Date()
      }
    },
    { upsert: true }
  );
}

// =====================================================
// MONGODB AUTHENTICATION STORAGE
// =====================================================

function serialize(data) {
  return JSON.stringify(data, BufferJSON.replacer);
}

function deserialize(data) {
  return data ? JSON.parse(data, BufferJSON.reviver) : null;
}

async function saveAuth(accountId, id, data) {
  await authCollection.updateOne(
    {
      _id: `${accountId}:${id}`
    },
    {
      $set: {
        accountId,
        value: serialize(data),
        updatedAt: new Date()
      }
    },
    { upsert: true }
  );
}

async function readAuth(accountId, id) {
  const result = await authCollection.findOne({
    _id: `${accountId}:${id}`
  });

  return result ? deserialize(result.value) : null;
}

async function mongoAuthState(accountId) {
  const stored = await readAuth(accountId, 'creds');
  const creds = stored || initAuthCreds();

  const keys = {
    async get(type, ids) {
      const result = {};

      await Promise.all(ids.map(async id => {
        result[id] = await readAuth(
          accountId,
          `${type}-${id}`
        );
      }));

      return result;
    },

    async set(data) {
      const operations = [];

      for (const category in data) {
        for (const id in data[category]) {
          const value = data[category][id];
          const documentId = `${category}-${id}`;

          if (value === null || value === undefined) {
            operations.push(
              authCollection.deleteOne({
                _id: `${accountId}:${documentId}`
              })
            );
          } else {
            operations.push(
              saveAuth(accountId, documentId, value)
            );
          }
        }
      }

      await Promise.all(operations);
    }
  };

  return {
    state: { creds, keys },

    async saveCreds() {
      await saveAuth(accountId, 'creds', creds);
    }
  };
}

// =====================================================
// ACCOUNT MANAGEMENT
// =====================================================

function createAccountRecord(id, label) {
  if (accounts.has(id)) return accounts.get(id);

  const account = {
    id,
    label: label || id,

    sock: null,
    connected: false,
    connecting: false,
    state: 'starting',

    qr: null,
    pairingCode: null,

    reconnectTimer: null,
    reconnectAttempts: 0,
    generation: 0
  };

  accounts.set(id, account);

  return account;
}

async function saveAccountRecord(account) {
  await accountsCollection.updateOne(
    { _id: account.id },
    {
      $set: {
        label: account.label,
        updatedAt: new Date()
      },
      $setOnInsert: {
        createdAt: new Date()
      }
    },
    { upsert: true }
  );
}

async function loadAccounts() {
  const saved = await accountsCollection.find({}).toArray();

  if (!saved.some(item => item._id === 'main')) {
    await accountsCollection.updateOne(
      { _id: 'main' },
      {
        $set: {
          label: 'Main WhatsApp',
          createdAt: new Date()
        }
      },
      { upsert: true }
    );
  }

  const all = await accountsCollection.find({}).toArray();

  for (const item of all) {
    createAccountRecord(item._id, item.label);
  }
}

// =====================================================
// CHAT DIRECTORY
// =====================================================

async function rememberChat(accountId, jid, name = '') {
  if (!jid || jid === 'status@broadcast') return;

  await chatsCollection.updateOne(
    {
      _id: `${accountId}:${jid}`
    },
    {
      $set: {
        accountId,
        jid,
        name: name || jid,
        updatedAt: new Date()
      },
      $setOnInsert: {
        createdAt: new Date()
      }
    },
    { upsert: true }
  );
}

async function getKnownChats(accountId) {
  return chatsCollection.find({
    accountId
  }).toArray();
}

// =====================================================
// ADMIN ACTIVITY / TEN-MINUTE TAKEOVER
// =====================================================

function activityKey(accountId, jid) {
  return `${accountId}:${jid}`;
}

function recordAdminActivity(accountId, jid) {
  if (!jid || jid.endsWith('@g.us')) return;

  adminActivity.set(
    activityKey(accountId, jid),
    Date.now()
  );

  log('INFO', 'Admin activity recorded', {
    accountId,
    chat: maskJid(jid)
  });
}

function adminIsActive(accountId, jid) {
  const last = adminActivity.get(
    activityKey(accountId, jid)
  );

  if (!last) return false;

  return Date.now() - last < config.takeoverDelay;
}

function remainingTakeoverTime(accountId, jid) {
  const last = adminActivity.get(
    activityKey(accountId, jid)
  );

  if (!last) return 0;

  return Math.max(
    0,
    config.takeoverDelay - (Date.now() - last)
  );
}

// =====================================================
// AI REPLIES
// =====================================================

function normalizeMessage(message) {
  return String(message || '')
    .toLowerCase()
    .trim()
    .replace(/[?!.,'"`]/g, '')
    .replace(/\s+/g, ' ');
}

function identityReply(message) {
  const text = normalizeMessage(message);

  const patterns = [
    /^who are you$/,
    /^who is this$/,
    /^what is your name$/,
    /^whats your name$/,
    /^we ni nani$/,
    /^wewe ni nani$/,
    /^unaitwa nani$/,
    /^jina lako nani$/,
    /^nani wewe$/
  ];

  return patterns.some(pattern => pattern.test(text))
    ? 'Mimi ni Manny 😊'
    : null;
}

async function generateReply(accountId, chatId, userMessage) {
  const fixed = identityReply(userMessage);

  if (fixed) return fixed;

  if (!aiClient) {
    return '⚠️ The service is temporarily unavailable.';
  }

  const key = `${accountId}:${chatId}`;
  const history = historyCache.get(key) || [];

  try {
    const response = await aiClient.chat.completions.create({
      model: config.geminiModel,
      messages: [
        {
          role: 'system',
          content: config.personality
        },
        ...history,
        {
          role: 'user',
          content: userMessage
        }
      ],
      max_tokens: config.maxTokens,
      temperature: config.temperature
    });

    let reply =
      response.choices?.[0]?.message?.content?.trim();

    if (!reply) {
      throw new Error('Gemini returned an empty response');
    }

    if (reply.length > 500) {
      reply = reply.slice(0, 497).trim() + '...';
    }

    history.push(
      { role: 'user', content: userMessage },
      { role: 'assistant', content: reply }
    );

    historyCache.set(
      key,
      history.slice(-config.maxHistory * 2)
    );

    aiConnected = true;

    return reply;

  } catch (error) {
    aiConnected = false;

    log('ERROR', 'Gemini reply failed', error);

    return '⚠️ Sorry, the service is temporarily unavailable. Try again shortly.';
  }
}

// =====================================================
// MESSAGE SENDING
// =====================================================

async function sendText(account, jid, text, quoted) {
  if (!account.sock || !account.connected) {
    throw new Error(`Account ${account.id} is disconnected`);
  }

  const options = quoted ? { quoted } : {};

  return account.sock.sendMessage(
    jid,
    { text },
    options
  );
}

// =====================================================
// ON / OFF ANNOUNCEMENTS
// =====================================================

function announcementText(enabled) {
  if (enabled) {
    return '⚠️⚠️⚠️ NONCHALANT_Q BOT IS NOW ON!\n\nMay contain AI-generated media. The admin is currently away. The bot will handle messages automatically. 😊';
  }

  return '⚠️⚠️⚠️ NONCHALANT_Q BOT IS NOW OFF!\n\nThe admin is back. Automatic AI replies have been disabled. 😊';
}

async function announceAccount(account, enabled) {
  if (!account.connected || !account.sock) return;

  const chats = await getKnownChats(account.id);
  const notice = announcementText(enabled);

  log('INFO', 'Sending announcements', {
    account: account.id,
    count: chats.length,
    enabled
  });

  for (const chat of chats) {
    try {
      await sendText(account, chat.jid, notice);

      await new Promise(resolve => setTimeout(resolve, 350));

    } catch (error) {
      log('WARN', 'Announcement failed', {
        account: account.id,
        chat: maskJid(chat.jid),
        error: error.message
      });
    }
  }
}

async function announceAllAccounts(enabled) {
  if (announcementRunning) return;

  announcementRunning = true;

  try {
    for (const account of accounts.values()) {
      if (account.connected) {
        await announceAccount(account, enabled);
      }
    }
  } finally {
    announcementRunning = false;
  }
}

// =====================================================
// MESSAGE EXTRACTION
// =====================================================

function extractText(message) {
  if (!message) return '';

  return (
    message.conversation ||
    message.extendedTextMessage?.text ||
    message.imageMessage?.caption ||
    message.videoMessage?.caption ||
    message.documentMessage?.caption ||
    message.buttonsResponseMessage?.selectedDisplayText ||
    message.listResponseMessage?.title ||
    message.templateButtonReplyMessage?.selectedDisplayText ||
    ''
  ).trim();
}

// =====================================================
// PROCESS INCOMING WHATSAPP MESSAGE
// =====================================================

async function processIncoming(account, msg) {
  if (!msg || !msg.key) return;

  const jid = msg.key.remoteJid;

  if (!jid) return;

  if (
    jid === 'status@broadcast' ||
    jid.endsWith('@newsletter') ||
    jid.endsWith('@broadcast')
  ) return;

  const isGroup = jid.endsWith('@g.us');

  await rememberChat(
    account.id,
    jid,
    msg.pushName || ''
  );

  // Messages sent manually by the linked phone.
  if (msg.key.fromMe) {
    if (!isGroup) {
      recordAdminActivity(account.id, jid);
    }

    return;
  }

  if (!botPower) return;

  if (isGroup && !groupMessaging) return;

  const userMessage = extractText(msg.message);

  if (!userMessage) return;

  if (!isGroup && adminIsActive(account.id, jid)) {
    log('INFO', 'Admin still active; reply postponed', {
      account: account.id,
      chat: maskJid(jid),
      remainingSeconds: Math.ceil(
        remainingTakeoverTime(account.id, jid) / 1000
      )
    });

    return;
  }

  log('INFO', 'Incoming message', {
    account: account.id,
    chat: maskJid(jid),
    group: isGroup
  });

  const reply = await generateReply(
    account.id,
    jid,
    userMessage
  );

  // Check switches again before sending.
  if (!botPower) return;

  if (isGroup && !groupMessaging) return;

  if (!isGroup && adminIsActive(account.id, jid)) return;

  if (account.connected) {
    await sendText(account, jid, reply, msg);

    log('SUCCESS', 'Reply sent', {
      account: account.id,
      chat: maskJid(jid)
    });
  }
}

// =====================================================
// RECONNECTION
// =====================================================

function scheduleReconnect(account, delay = 5000) {
  if (shuttingDown || account.reconnectTimer) return;

  account.reconnectTimer = setTimeout(() => {
    account.reconnectTimer = null;
    connectAccount(account.id);
  }, delay);
}

// =====================================================
// CONNECT ACCOUNT
// =====================================================

async function connectAccount(accountId) {
  const account = accounts.get(accountId);

  if (!account || shuttingDown) return;

  if (account.connected || account.connecting) return;

  account.connecting = true;
  account.state = 'connecting';

  const generation = ++account.generation;

  try {
    const {
      state,
      saveCreds
    } = await mongoAuthState(accountId);

    if (
      generation !== account.generation ||
      shuttingDown
    ) return;

    const socket = makeWASocket({
      auth: state,
      logger,
      printQRInTerminal: false,
      browser: ['Ubuntu', 'Chrome', '20.0.04'],
      markOnlineOnConnect: true,
      syncFullHistory: false,
      connectTimeoutMs: 60000,
      defaultQueryTimeoutMs: 60000,
      keepAliveIntervalMs: 25000
    });

    account.sock = socket;

    socket.ev.on('creds.update', async () => {
      try {
        await saveCreds();
      } catch (error) {
        log('ERROR', 'Credential save failed', error);
      }
    });

    socket.ev.on('connection.update', async update => {
      if (generation !== account.generation) return;

      const {
        connection,
        lastDisconnect,
        qr
      } = update;

      if (qr) {
        try {
          account.qr = await QRCode.toDataURL(qr, {
            width: 400,
            margin: 2
          });
        } catch (error) {
          log('ERROR', 'QR generation failed', error);
        }
      }

      if (connection === 'open') {
        account.connected = true;
        account.connecting = false;
        account.state = 'open';

        account.qr = null;
        account.pairingCode = null;
        account.reconnectAttempts = 0;

        log('SUCCESS', 'WhatsApp account connected', account.id);
      }

      if (connection === 'close') {
        account.connected = false;
        account.connecting = false;
        account.state = 'disconnected';

        account.sock = null;
        account.qr = null;

        const statusCode =
          lastDisconnect?.error?.output?.statusCode;

        log('WARN', 'WhatsApp connection closed', {
          account: account.id,
          statusCode
        });

        if (statusCode === DisconnectReason.loggedOut) {
          account.state = 'needs_pairing';

          await authCollection.deleteMany({
            accountId
          });

          log('WARN', 'Account logged out; new pairing required', account.id);

          return;
        }

        account.reconnectAttempts++;

        const delay = Math.min(
          3000 * account.reconnectAttempts,
          30000
        );

        scheduleReconnect(account, delay);
      }
    });

    socket.ev.on('messages.upsert', async event => {
      for (const msg of event.messages || []) {
        try {
          await processIncoming(account, msg);
        } catch (error) {
          log('ERROR', 'Message processing failed', {
            account: account.id,
            error: error.message
          });
        }
      }
    });

    account.connecting = false;

    log('SUCCESS', 'Account socket created', account.id);

  } catch (error) {
    account.connecting = false;
    account.sock = null;
    account.state = 'reconnecting';

    log('ERROR', 'Account startup failed', {
      account: accountId,
      error: error.message
    });

    scheduleReconnect(account, 10000);
  }
}

// =====================================================
// DISCONNECT AND REMOVE ACCOUNT
// =====================================================

async function disconnectAccount(accountId) {
  const account = accounts.get(accountId);

  if (!account) {
    throw new Error('Account not found.');
  }

  // Invalidate pending connection callbacks.
  account.generation++;

  if (account.reconnectTimer) {
    clearTimeout(account.reconnectTimer);
    account.reconnectTimer = null;
  }

  account.connected = false;
  account.connecting = false;
  account.state = 'disconnected';

  const socket = account.sock;
  account.sock = null;

  if (socket) {
    try {
      socket.end(undefined);
    } catch (error) {
      log('WARN', 'Socket close warning', error);
    }
  }

  // Delete authentication credentials so this account
  // will require fresh pairing next time.
  await authCollection.deleteMany({
    accountId
  });

  // Remove chat directory and history for this account.
  await chatsCollection.deleteMany({
    accountId
  });

  await accountsCollection.deleteOne({
    _id: accountId
  });

  for (const key of adminActivity.keys()) {
    if (key.startsWith(`${accountId}:`)) {
      adminActivity.delete(key);
    }
  }

  accounts.delete(accountId);

  log('SUCCESS', 'Account disconnected and removed', accountId);

  return true;
}

// =====================================================
// ACCOUNT STATUS
// =====================================================

function publicAccount(account) {
  return {
    id: account.id,
    label: account.label,
    connected: account.connected,
    connecting: account.connecting,
    state: account.state,
    qr: account.qr,
    pairingCode: account.pairingCode
  };
}

function getDashboardStatus() {
  return {
    botPower,
    groupMessaging,
    aiConnected,
    aiConfigured: !!aiClient,
    mongoConnected,

    accounts: [...accounts.values()].map(publicAccount),

    uptimeSeconds: Math.floor(process.uptime()),
    startedAt: startedAt.toISOString()
  };
}

// =====================================================
// API: STATUS
// =====================================================

app.get('/api/status', adminAuth, (req, res) => {
  res.json(getDashboardStatus());
});

// =====================================================
// API: TURN BOT ON/OFF
// =====================================================

app.post('/api/bot-power', adminAuth, async (req, res) => {
  try {
    const enabled = req.body?.enabled;

    if (typeof enabled !== 'boolean') {
      return res.status(400).json({
        error: 'enabled must be true or false.'
      });
    }

    if (botPower === enabled) {
      return res.json({
        success: true,
        message: 'Bot power already has this setting.',
        status: getDashboardStatus()
      });
    }

    botPower = enabled;

    await saveSettings();

    log('SUCCESS', 'Bot power changed', {
      enabled
    });

    // Announce to all known chats across connected accounts.
    announceAllAccounts(enabled).catch(error => {
      log('ERROR', 'Announcement process failed', error);
    });

    res.json({
      success: true,
      message: enabled
        ? 'Bot turned ON.'
        : 'Bot turned OFF. Admin is back.',
      status: getDashboardStatus()
    });

  } catch (error) {
    log('ERROR', 'Bot power update failed', error);

    res.status(500).json({
      error: error.message
    });
  }
});

// =====================================================
// API: GROUP MESSAGING
// =====================================================

app.post('/api/group-messaging', adminAuth, async (req, res) => {
  try {
    const enabled = req.body?.enabled;

    if (typeof enabled !== 'boolean') {
      return res.status(400).json({
        error: 'enabled must be true or false.'
      });
    }

    groupMessaging = enabled;

    await saveSettings();

    res.json({
      success: true,
      message: enabled
        ? 'Group messaging enabled.'
        : 'Group messaging disabled.',
      status: getDashboardStatus()
    });

  } catch (error) {
    log('ERROR', 'Group messaging update failed', error);

    res.status(500).json({
      error: error.message
    });
  }
});

// =====================================================
// API: LINK NEW ACCOUNT
// =====================================================

app.post('/api/accounts', adminAuth, async (req, res) => {
  try {
    const label = String(
      req.body?.label || ''
    ).trim().slice(0, 40);

    const id = `account_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;

    const account = createAccountRecord(
      id,
      label || `WhatsApp ${accounts.size + 1}`
    );

    await saveAccountRecord(account);

    connectAccount(id);

    res.json({
      success: true,
      account: publicAccount(account),
      message: 'New account created. Waiting for pairing.'
    });

  } catch (error) {
    log('ERROR', 'Account creation failed', error);

    res.status(500).json({
      error: error.message
    });
  }
});

// =====================================================
// API: PAIR ACCOUNT USING PHONE NUMBER
// =====================================================

app.post('/api/accounts/:id/pair', adminAuth, async (req, res) => {
  try {
    const account = accounts.get(req.params.id);

    if (!account) {
      return res.status(404).json({
        error: 'Account not found.'
      });
    }

    if (account.connected) {
      return res.status(409).json({
        error: 'Account is already connected.'
      });
    }

    if (!account.sock) {
      return res.status(503).json({
        error: 'WhatsApp is still starting. Try again shortly.'
      });
    }

    const phone = String(
      req.body?.phone || ''
    ).replace(/\D/g, '');

    if (!/^\d{10,15}$/.test(phone)) {
      return res.status(400).json({
        error: 'Enter a valid phone number with country code.'
      });
    }

    const code = await account.sock.requestPairingCode(phone);

    account.pairingCode = code.match(/.{1,4}/g).join('-');

    res.json({
      success: true,
      code: account.pairingCode
    });

  } catch (error) {
    log('ERROR', 'Pairing code request failed', error);

    res.status(500).json({
      error: error.message
    });
  }
});

// =====================================================
// API: DISCONNECT ACCOUNT
// =====================================================

app.delete('/api/accounts/:id', adminAuth, async (req, res) => {
  try {
    const id = req.params.id;

    if (!validAccountId(id)) {
      return res.status(400).json({
        error: 'Invalid account ID.'
      });
    }

    await disconnectAccount(id);

    res.json({
      success: true,
      message: 'WhatsApp account disconnected and removed.'
    });

  } catch (error) {
    log('ERROR', 'Account disconnection failed', error);

    res.status(500).json({
      error: error.message
    });
  }
});

// =====================================================
// API: SEND MANUAL PRIVATE MESSAGE
// =====================================================

app.post('/api/send', adminAuth, async (req, res) => {
  try {
    const { accountId, to, message } = req.body || {};

    const account = accounts.get(accountId);

    if (!account || !account.connected) {
      return res.status(503).json({
        error: 'Selected WhatsApp account is not connected.'
      });
    }

    const phone = String(to || '').replace(/\D/g, '');

    if (!/^\d{10,15}$/.test(phone) || !message) {
      return res.status(400).json({
        error: 'Valid phone number and message are required.'
      });
    }

    await sendText(
      account,
      `${phone}@s.whatsapp.net`,
      String(message)
    );

    res.json({
      success: true,
      message: 'Message sent successfully.'
    });

  } catch (error) {
    log('ERROR', 'Manual message failed', error);

    res.status(500).json({
      error: error.message
    });
  }
});

// =====================================================
// API: HEALTH
// =====================================================

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    mongoConnected,
    aiConnected,
    botPower,
    groupMessaging,
    accounts: accounts.size,
    connectedAccounts: [...accounts.values()].filter(
      account => account.connected
    ).length,
    uptimeSeconds: Math.floor(process.uptime())
  });
});

// =====================================================
// MAIN PAGE
// =====================================================

app.get('/', (req, res) => {
  res.sendFile(
    path.join(__dirname, 'public', 'index.html')
  );
});

// =====================================================
// UNKNOWN ROUTES
// =====================================================

app.use((req, res) => {
  res.status(404).json({
    error: 'Route not found.'
  });
});

// =====================================================
// HTTP ERROR HANDLER
// =====================================================

app.use((error, req, res, next) => {
  log('ERROR', 'HTTP error', error);

  if (res.headersSent) return next(error);

  res.status(500).json({
    error: 'Internal server error.'
  });
});

// =====================================================
// START SERVER
// =====================================================

const server = app.listen(
  config.port,
  '0.0.0.0',
  () => {
    log('SUCCESS', 'HTTP server listening', config.port);
  }
);

// =====================================================
// STARTUP
// =====================================================

async function startBot() {
  try {
    if (!config.mongoUri) {
      throw new Error('MONGODB_URI is missing.');
    }

    log('INFO', 'Connecting to MongoDB');

    await mongoClient.connect();

    const db = mongoClient.db(config.database);

    authCollection = db.collection('whatsapp_auth');
    settingsCollection = db.collection('bot_settings');
    chatsCollection = db.collection('known_chats');
    accountsCollection = db.collection('whatsapp_accounts');

    await Promise.all([
      authCollection.createIndex({ accountId: 1 }),
      chatsCollection.createIndex({ accountId: 1 }),
      accountsCollection.createIndex({ _id: 1 })
    ]);

    mongoConnected = true;

    await loadSettings();
    await loadAccounts();

    log('SUCCESS', 'MongoDB connected');

    if (aiClient) {
      try {
        const test = await aiClient.chat.completions.create({
          model: config.geminiModel,
          messages: [
            {
              role: 'system',
              content: config.personality
            },
            {
              role: 'user',
              content: 'What is your name?'
            }
          ],
          max_tokens: 30,
          temperature: 0
        });

        aiConnected = !!test.choices?.[0]?.message?.content;

        log(
          aiConnected ? 'SUCCESS' : 'WARN',
          'Gemini test',
          aiConnected ? 'Gemini is working' : 'Empty response'
        );

      } catch (error) {
        aiConnected = false;
        log('ERROR', 'Gemini test failed', error);
      }
    } else {
      log('WARN', 'GEMINI_API_KEY is missing');
    }

    // Restore every previously linked account.
    for (const account of accounts.values()) {
      connectAccount(account.id);
    }

    log('SUCCESS', 'Startup completed');

  } catch (error) {
    mongoConnected = false;
    log('ERROR', 'Startup failed', error);
  }
}

startBot();

// =====================================================
// GRACEFUL SHUTDOWN
// =====================================================

async function shutdown(signal) {
  if (shuttingDown) return;

  shuttingDown = true;

  log('WARN', 'Shutdown started', signal);

  for (const account of accounts.values()) {
    if (account.reconnectTimer) {
      clearTimeout(account.reconnectTimer);
    }

    if (account.sock) {
      try {
        account.sock.end(undefined);
      } catch {}
    }
  }

  try {
    if (mongoConnected) {
      await mongoClient.close();
    }

    server.close(() => {
      process.exit(0);
    });

    setTimeout(() => process.exit(0), 8000).unref();

  } catch (error) {
    log('ERROR', 'Shutdown failed', error);
    process.exit(1);
  }
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

process.on('unhandledRejection', error => {
  log('ERROR', 'Unhandled rejection', error);
});

process.on('uncaughtException', error => {
  log('ERROR', 'Uncaught exception', error);
  process.exit(1);
});
