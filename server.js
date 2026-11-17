require('dotenv').config();

const express = require('express');
const path = require('path');
const fs = require('fs');
const OpenAI = require('openai');
const NodeCache = require('node-cache');
const pino = require('pino');
const QRCode = require('qrcode');
const { MongoClient } = require('mongodb');

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
  mongoDatabase: process.env.MONGODB_DB_NAME || 'whatsapp_bot',
  authId: process.env.WHATSAPP_AUTH_ID || 'main',

  geminiKey: process.env.GEMINI_API_KEY,
  geminiModel: process.env.GEMINI_MODEL || 'gemini-3.8-flash',
  geminiBaseURL: 'https://generativelanguage.googleapis.com/v1beta/openai/',

  adminToken: process.env.ADMIN_CONTROL_TOKEN || '',

  botName: 'Manny',

  maxHistory: Math.max(
    1,
    Number(process.env.MAX_HISTORY_MESSAGES || 10)
  ),

  maxTokens: Math.min(
    250,
    Math.max(80, Number(process.env.OPENAI_MAX_TOKENS || 180))
  ),

  temperature: Number(process.env.OPENAI_TEMPERATURE || 0.7)
};

// =====================================================
// AI PERSONALITY
// =====================================================

const personality = `
You are Manny. Your name is ALWAYS Manny.

IDENTITY:
- If asked who you are, say you are Manny.
- Never introduce yourself as an AI, chatbot, language model or virtual assistant.
- Do not invent another name.

PERSONALITY:
- Friendly, confident, natural, humorous when appropriate and helpful.
- Talk like a normal person on WhatsApp.
- Avoid robotic or formal replies.
- Keep replies short, normally one sentence and at most two short sentences.
- Answer what the person asks.
- Do not repeat their message or add unnecessary questions.

LANGUAGES:
- Understand and respond naturally in English.
- Understand Kiswahili.
- Understand Kenyan Sheng.
- Understand common Gikuyu expressions where possible.
- Match the sender's language.
- Handle mixed English, Swahili and Sheng naturally.

GENDER AND PRONOUN RULE (VERY IMPORTANT):
- NEVER guess whether a person is male or female from their name.
- A name is NOT proof of someone's gender.
- Do not use profile names to determine gender.
- Do not guess from writing style, voice, photos or conversation topics.
- Use he/him or she/her ONLY when that person has explicitly confirmed those pronouns or clearly stated their gender in conversation.
- If gender is not confirmed, avoid gendered pronouns.
- Use the person's name, "they", or rewrite the sentence neutrally.
- Do not call someone bro, sis, brother, sister, mama, dad or similar gendered terms unless the person has used or confirmed that form of address.
- Never claim gender has been confirmed when it has not.

GROUP CONVERSATIONS:
- Remember that group replies are visible to everyone.
- Be respectful and natural.
- Do not reveal private conversation history in groups.
- Respond to the actual message.
- Avoid unnecessarily long replies.

IMPORTANT:
Always maintain the identity Manny.
Be brief, natural and relevant.
`;

// =====================================================
// LOGGING AND HELPERS
// =====================================================

const startedAt = new Date();

function log(level, step, message, details) {
  const prefix = `[${new Date().toISOString()}] [${level}] [${step}]`;

  const method =
    level === 'ERROR' ? 'error' :
    level === 'WARN' ? 'warn' : 'log';

  if (details !== undefined) {
    console[method](prefix, message, safeDetails(details));
  } else {
    console[method](prefix, message);
  }
}

function safeDetails(value) {
  if (value instanceof Error) return getErrorDetails(value);
  if (typeof value === 'string') return value;

  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function getErrorDetails(error) {
  return {
    name: error?.name,
    message: error?.message,
    status: error?.status || error?.statusCode,
    code: error?.code,
    type: error?.type,
    responseStatus: error?.response?.status,
    responseData: error?.response?.data
  };
}

function maskPhone(value) {
  const digits = String(value || '').replace(/\D/g, '');

  return digits.length <= 4
    ? '****'
    : `${digits.slice(0, 3)}******${digits.slice(-2)}`;
}

function maskJid(jid) {
  if (!jid) return 'unknown';

  const parts = String(jid).split('@');

  return `${maskPhone(parts[0])}@${parts[1] || 'unknown'}`;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// =====================================================
// APP, CLIENTS AND STATE
// =====================================================

const app = express();

app.use(express.json({ limit: '1mb' }));
app.use(express.static(__dirname));

const historyCache = new NodeCache({
  stdTTL: 86400,
  checkperiod: 600
});

const baileysLogger = pino({
  level: process.env.BAILEYS_LOG_LEVEL || 'silent'
});

const mongoClient = new MongoClient(config.mongoUri || '', {
  serverSelectionTimeoutMS: 10000,
  connectTimeoutMS: 10000,
  maxPoolSize: 10
});

let authCollection = null;
let settingsCollection = null;

let sock = null;

let isConnected = false;
let isConnecting = false;

let mongoConnected = false;
let aiConnected = false;

let latestQRDataUrl = null;
let pairingCode = null;

let connectionState = 'starting';

let reconnectTimer = null;
let reconnectAttempts = 0;

let shuttingDown = false;

let groupRepliesEnabled = false;
let groupAnnouncementInProgress = false;

const processingMessages = new Set();

// =====================================================
// GEMINI CLIENT
// =====================================================

const aiClient = config.geminiKey
  ? new OpenAI({
      apiKey: config.geminiKey,
      baseURL: config.geminiBaseURL,
      timeout: 30000,
      maxRetries: 1
    })
  : null;

// =====================================================
// MONGODB BAILEYS AUTH STORAGE
// =====================================================

function serialize(data) {
  return JSON.stringify(data, BufferJSON.replacer);
}

function deserialize(data) {
  return data
    ? JSON.parse(data, BufferJSON.reviver)
    : null;
}

async function saveMongoData(id, data) {
  if (!authCollection) {
    throw new Error('MongoDB auth collection is not initialized');
  }

  await authCollection.updateOne(
    {
      _id: `${config.authId}:${id}`
    },
    {
      $set: {
        authId: config.authId,
        value: serialize(data),
        updatedAt: new Date()
      }
    },
    {
      upsert: true
    }
  );
}

async function readMongoData(id) {
  if (!authCollection) {
    throw new Error('MongoDB auth collection is not initialized');
  }

  const result = await authCollection.findOne({
    _id: `${config.authId}:${id}`
  });

  return result
    ? deserialize(result.value)
    : null;
}

async function useMongoDBAuthState() {
  const storedCreds = await readMongoData('creds');

  const creds = storedCreds || initAuthCreds();

  const keys = {
    async get(type, ids) {
      const result = {};

      await Promise.all(
        ids.map(async id => {
          result[id] = await readMongoData(`${type}-${id}`);
        })
      );

      return result;
    },

    async set(data) {
      const operations = [];

      for (const category in data) {
        for (const id in data[category]) {
          const value = data[category][id];

          if (value === null || value === undefined) {
            operations.push(
              authCollection.deleteOne({
                _id: `${config.authId}:${category}-${id}`
              })
            );
          } else {
            operations.push(
              saveMongoData(`${category}-${id}`, value)
            );
          }
        }
      }

      await Promise.all(operations);
    }
  };

  return {
    state: {
      creds,
      keys
    },

    async saveCreds() {
      await saveMongoData('creds', creds);
    }
  };
}

// =====================================================
// GROUP SETTINGS STORAGE
// =====================================================

async function loadGroupSetting() {
  const saved = await settingsCollection.findOne({
    _id: `${config.authId}:groupRepliesEnabled`
  });

  groupRepliesEnabled = saved?.value === true;

  log(
    'INFO',
    'GROUP_SETTING',
    `Group replies loaded as ${groupRepliesEnabled ? 'ON' : 'OFF'}.`
  );
}

async function saveGroupSetting(enabled) {
  await settingsCollection.updateOne(
    {
      _id: `${config.authId}:groupRepliesEnabled`
    },
    {
      $set: {
        value: Boolean(enabled),
        updatedAt: new Date()
      }
    },
    {
      upsert: true
    }
  );
}

// =====================================================
// GEMINI DIAGNOSTICS
// =====================================================

async function verifyGemini() {
  if (!aiClient) {
    aiConnected = false;

    log(
      'ERROR',
      'GEMINI_CONFIG',
      'GEMINI_API_KEY is missing.'
    );

    return false;
  }

  try {
    const response = await aiClient.chat.completions.create({
      model: config.geminiModel,

      messages: [
        {
          role: 'system',
          content: personality
        },
        {
          role: 'user',
          content: 'What is your name?'
        }
      ],

      max_tokens: 30,
      temperature: 0
    });

    if (!response.choices?.[0]?.message?.content?.trim()) {
      throw new Error('Gemini returned an empty test response');
    }

    aiConnected = true;

    log(
      'SUCCESS',
      'GEMINI_TEST',
      `Gemini is working with ${config.geminiModel}.`
    );

    return true;

  } catch (error) {
    aiConnected = false;

    log(
      'ERROR',
      'GEMINI_TEST',
      'Gemini verification failed:',
      getErrorDetails(error)
    );

    return false;
  }
}

// =====================================================
// IDENTITY RECOGNITION
// =====================================================

function normalizeMessage(message) {
  return String(message || '')
    .toLowerCase()
    .trim()
    .replace(/[?!.,'"`]/g, '')
    .replace(/\s+/g, ' ');
}

function getIdentityReply(message) {
  const text = normalizeMessage(message);

  const patterns = [
    /^who are you$/,
    /^who is this$/,
    /^what is your name$/,
    /^whats your name$/,
    /^what are you called$/,
    /^what should i call you$/,
    /^tell me your name$/,
    /^we ni nani$/,
    /^wewe ni nani$/,
    /^unaitwa nani$/,
    /^jina lako nani$/,
    /^jina lako ni nani$/,
    /^nani wewe$/,
    /^are you manny$/
  ];

  return patterns.some(pattern => pattern.test(text))
    ? 'Mimi ni Manny 😊'
    : null;
}

// =====================================================
// AI REPLY GENERATION
// =====================================================

async function generateReply(
  historyKey,
  userMessage,
  senderName,
  isGroup
) {
  const identityReply = getIdentityReply(userMessage);

  if (identityReply) {
    return identityReply;
  }

  if (!aiClient) {
    return '⚠️ The service is temporarily unavailable.';
  }

  const history = historyCache.get(historyKey) || [];

  const senderContext = senderName
    ? `The sender's WhatsApp display name is: ${senderName}. This name does NOT confirm gender. Do not infer gender from it.`
    : 'The sender name is unknown. Do not infer gender.';

  const chatContext = isGroup
    ? 'This message came from a WhatsApp group. Reply naturally to the sender while remembering the reply will be visible to the group.'
    : 'This is a private WhatsApp conversation.';

  const messages = [
    {
      role: 'system',
      content: `${personality}

CHAT CONTEXT:
${chatContext}
${senderContext}`
    },

    ...history,

    {
      role: 'user',
      content: userMessage
    }
  ];

  try {
    const response = await aiClient.chat.completions.create({
      model: config.geminiModel,
      messages,
      max_tokens: config.maxTokens,
      temperature: config.temperature
    });

    let reply =
      response.choices?.[0]?.message?.content?.trim();

    if (!reply) {
      throw new Error('Gemini returned an empty response');
    }

    if (reply.length > 500) {
      const shortened = reply.slice(0, 500);

      const lastSentence = shortened.lastIndexOf('.');

      reply = lastSentence > 200
        ? shortened.slice(0, lastSentence + 1)
        : shortened.trim();
    }

    history.push(
      {
        role: 'user',
        content: userMessage
      },
      {
        role: 'assistant',
        content: reply
      }
    );

    historyCache.set(
      historyKey,
      history.slice(-config.maxHistory * 2)
    );

    aiConnected = true;

    return reply;

  } catch (error) {
    aiConnected = false;

    log(
      'ERROR',
      'AI_REPLY',
      'Gemini request failed:',
      getErrorDetails(error)
    );

    return '⚠️ Sorry, the service is temporarily unavailable. Try again shortly.';
  }
}

// =====================================================
// GROUP ANNOUNCEMENTS AND ADMIN CONTROL
// =====================================================

function isGroupJid(jid) {
  return typeof jid === 'string' && jid.endsWith('@g.us');
}

async function announceToAllGroups(text) {
  if (!sock || !isConnected) {
    throw new Error('WhatsApp is not connected');
  }

  const groups = await sock.groupFetchAllParticipating();

  const groupIds = Object.keys(groups || {});

  let sent = 0;
  let failed = 0;

  log(
    'INFO',
    'GROUP_ANNOUNCEMENT',
    `Sending announcement to ${groupIds.length} joined groups.`
  );

  for (const groupId of groupIds) {
    try {
      await sock.sendMessage(groupId, {
        text
      });

      sent++;

      await sleep(700);

    } catch (error) {
      failed++;

      log(
        'WARN',
        'GROUP_ANNOUNCEMENT',
        `Could not send announcement to ${maskJid(groupId)}: ${error.message}`
      );
    }
  }

  log(
    'SUCCESS',
    'GROUP_ANNOUNCEMENT',
    `Announcement complete. Sent: ${sent}; failed: ${failed}.`
  );

  return {
    total: groupIds.length,
    sent,
    failed
  };
}

// =====================================================
// ADMIN AUTHENTICATION
// =====================================================

function requireAdmin(req, res, next) {
  if (!config.adminToken) {
    return res.status(503).json({
      error: 'ADMIN_CONTROL_TOKEN is not configured in Render environment variables.'
    });
  }

  const supplied = String(
    req.headers['x-admin-token'] ||
    req.body?.adminToken ||
    ''
  );

  if (supplied !== config.adminToken) {
    return res.status(401).json({
      error: 'Incorrect admin password.'
    });
  }

  next();
}

// =====================================================
// GROUP SETTINGS API
// =====================================================

app.get('/api/group-settings', requireAdmin, (req, res) => {
  res.json({
    enabled: groupRepliesEnabled,
    connected: isConnected
  });
});

app.post('/api/group-toggle', requireAdmin, async (req, res) => {
  const enabled = req.body?.enabled;

  if (typeof enabled !== 'boolean') {
    return res.status(400).json({
      error: 'enabled must be true or false.'
    });
  }

  if (!sock || !isConnected) {
    return res.status(503).json({
      error: 'WhatsApp is not connected. Connect WhatsApp before changing group mode.'
    });
  }

  if (groupAnnouncementInProgress) {
    return res.status(409).json({
      error: 'A group announcement is already in progress. Please wait.'
    });
  }

  if (enabled === groupRepliesEnabled) {
    return res.json({
      success: true,
      enabled,
      message: `Group messaging is already ${enabled ? 'ON' : 'OFF'}.`
    });
  }

  groupAnnouncementInProgress = true;

  try {
    if (enabled) {

      // GROUP ON ANNOUNCEMENT

      const announcement =
        'Nonchalant_Q bot turned on, may contain Ai media,the admin will be back soon';

      const result = await announceToAllGroups(announcement);

      // Enable group replies after announcements.

      await saveGroupSetting(true);

      groupRepliesEnabled = true;

      return res.json({
        success: true,
        enabled: true,
        announcement: result,
        message: 'Group messaging turned ON. The announcement was sent to joined groups.'
      });
    }

    // GROUP OFF

    groupRepliesEnabled = false;

    await saveGroupSetting(false);

    const announcement =
      'Nonchalant_Q bot turned off. Admin is back.';

    const result = await announceToAllGroups(announcement);

    return res.json({
      success: true,
      enabled: false,
      announcement: result,
      message: 'Group messaging turned OFF. The admin-back announcement was sent to joined groups.'
    });

  } catch (error) {
    log(
      'ERROR',
      'GROUP_TOGGLE',
      'Could not change group messaging mode:',
      getErrorDetails(error)
    );

    return res.status(500).json({
      error: error.message || 'Could not change group messaging mode.'
    });

  } finally {
    groupAnnouncementInProgress = false;
  }
});

// =====================================================
// WHATSAPP RECONNECTION
// =====================================================

function scheduleReconnect(delay = 5000) {
  if (shuttingDown || reconnectTimer) return;

  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectToWhatsApp();
  }, delay);
}

// =====================================================
// WHATSAPP CONNECTION
// =====================================================

async function connectToWhatsApp() {
  if (shuttingDown || isConnecting || isConnected) {
    return;
  }

  isConnecting = true;
  connectionState = 'connecting';

  try {
    if (!mongoConnected || !authCollection) {
      throw new Error('MongoDB is not connected');
    }

    const {
      state,
      saveCreds
    } = await useMongoDBAuthState();

    sock = makeWASocket({
      auth: state,
      logger: baileysLogger,
      printQRInTerminal: false,
      browser: ['Ubuntu', 'Chrome', '20.0.04'],
      markOnlineOnConnect: true,
      syncFullHistory: false,
      connectTimeoutMs: 60000,
      defaultQueryTimeoutMs: 60000,
      keepAliveIntervalMs: 25000
    });

    // SAVE CREDENTIALS

    sock.ev.on('creds.update', async () => {
      try {
        await saveCreds();

      } catch (error) {
        log(
          'ERROR',
          'AUTH_SAVE',
          'Could not save WhatsApp credentials:',
          getErrorDetails(error)
        );
      }
    });

    // CONNECTION STATUS

    sock.ev.on('connection.update', async update => {
      const {
        connection,
        lastDisconnect,
        qr
      } = update;

      if (qr && !isConnected) {
        try {
          latestQRDataUrl = await QRCode.toDataURL(qr, {
            width: 450,
            margin: 2
          });

        } catch (error) {
          log(
            'ERROR',
            'QR',
            'QR generation failed:',
            getErrorDetails(error)
          );
        }
      }

      if (connection === 'connecting') {
        connectionState = 'connecting';
      }

      if (connection === 'open') {
        isConnected = true;
        isConnecting = false;

        connectionState = 'open';
        reconnectAttempts = 0;

        latestQRDataUrl = null;
        pairingCode = null;

        log(
          'SUCCESS',
          'WHATSAPP',
          'WhatsApp connected successfully.'
        );
      }

      if (connection === 'close') {
        isConnected = false;
        isConnecting = false;

        connectionState = 'disconnected';

        latestQRDataUrl = null;
        pairingCode = null;

        const statusCode =
          lastDisconnect?.error?.output?.statusCode;

        log(
          'WARN',
          'WHATSAPP',
          `Connection closed. Status: ${statusCode || 'unknown'}`
        );

        sock = null;

        if (statusCode === DisconnectReason.loggedOut) {
          try {
            await authCollection.deleteMany({
              authId: config.authId
            });

            connectionState = 'needs_pairing';

          } catch (error) {
            log(
              'ERROR',
              'LOGOUT',
              'Could not clear old session:',
              getErrorDetails(error)
            );
          }

          scheduleReconnect(3000);

        } else {
          reconnectAttempts++;

          connectionState = 'reconnecting';

          scheduleReconnect(
            Math.min(3000 * reconnectAttempts, 30000)
          );
        }
      }
    });

    // =================================================
    // INCOMING MESSAGES: PRIVATE + OPTIONAL GROUPS
    // =================================================

    sock.ev.on('messages.upsert', async event => {
      if (event.type !== 'notify') return;

      for (const msg of event.messages || []) {
        const messageId = msg.key?.id;

        if (!msg.message || msg.key?.fromMe || !messageId) {
          continue;
        }

        if (processingMessages.has(messageId)) {
          continue;
        }

        processingMessages.add(messageId);

        try {
          const chatId = msg.key.remoteJid;

          if (
            !chatId ||
            chatId === 'status@broadcast' ||
            chatId.endsWith('@newsletter') ||
            chatId.endsWith('@broadcast')
          ) {
            continue;
          }

          const isGroup = isGroupJid(chatId);

          // GROUP SWITCH CHECK

          if (isGroup && !groupRepliesEnabled) {
            continue;
          }

          if (isGroup && groupAnnouncementInProgress) {
            continue;
          }

          const message = msg.message;

          const userMessage =
            message.conversation ||
            message.extendedTextMessage?.text ||
            message.imageMessage?.caption ||
            message.videoMessage?.caption ||
            message.documentMessage?.caption ||
            message.buttonsResponseMessage?.selectedDisplayText ||
            message.listResponseMessage?.title;

          if (!userMessage || !String(userMessage).trim()) {
            continue;
          }

          // ACTUAL SENDER IN GROUP

          const senderJid = isGroup
            ? (msg.key.participant || msg.participant || '')
            : chatId;

          const senderName =
            msg.pushName ||
            msg.verifiedBizName ||
            '';

          const historyKey = isGroup
            ? `${chatId}:${senderJid || 'unknown'}`
            : chatId;

          log(
            'INFO',
            'INCOMING',
            `${isGroup ? 'Group' : 'Private'} message from ${maskJid(senderJid || chatId)}.`
          );

          // GENERATE REPLY

          const reply = await generateReply(
            historyKey,
            String(userMessage).trim(),
            senderName,
            isGroup
          );

          if (!sock || !isConnected) {
            continue;
          }

          // SEND QUOTED REPLY

          await sock.sendMessage(
            chatId,
            {
              text: reply
            },
            {
              quoted: msg
            }
          );

          log(
            'SUCCESS',
            'SEND_REPLY',
            `Reply sent to ${maskJid(chatId)}.`
          );

        } catch (error) {
          log(
            'ERROR',
            'MESSAGE',
            'Message processing failed:',
            getErrorDetails(error)
          );

        } finally {
          processingMessages.delete(messageId);
        }
      }
    });

    isConnecting = false;

    log(
      'INFO',
      'WHATSAPP',
      'WhatsApp socket created; waiting for connection.'
    );

  } catch (error) {
    isConnecting = false;
    sock = null;

    connectionState = 'reconnecting';

    log(
      'ERROR',
      'WHATSAPP_START',
      'WhatsApp startup failed:',
      getErrorDetails(error)
    );

    scheduleReconnect(10000);
  }
}

// =====================================================
// DASHBOARD AND STATUS ROUTES
// =====================================================

app.get('/', (req, res) => {
  const indexPath = path.join(__dirname, 'index.html');

  if (fs.existsSync(indexPath)) {
    return res.sendFile(indexPath);
  }

  return res.status(404).send(
    'index.html is missing. Add index.html beside server.js.'
  );
});

// HEALTH CHECK

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    bot: config.botName,

    uptimeSeconds: Math.floor(process.uptime()),

    startedAt: startedAt.toISOString(),

    aiProvider: 'Google Gemini',
    aiModel: config.geminiModel,

    aiConfigured: !!aiClient,
    aiConnected,

    mongoConnected,

    whatsappReady: isConnected,
    whatsappState: connectionState,

    groupRepliesEnabled,
    quotedRepliesEnabled: true,

    pairingReady: !!sock && !isConnected,
    qrPending: !!latestQRDataUrl
  });
});

// STATUS ENDPOINT

app.get('/status', (req, res) => {
  res.json({
    connected: isConnected,
    state: connectionState,

    mongoConnected,

    aiConfigured: !!aiClient,
    aiConnected,

    qrPending: !!latestQRDataUrl,
    qr: latestQRDataUrl,

    pairingCode,
    groupRepliesEnabled
  });
});

// =====================================================
// PAIRING CODE ENDPOINT
// =====================================================

app.get('/request-pairing', async (req, res) => {
  const phone = String(req.query.phone || '')
    .replace(/\D/g, '');

  if (!/^\d{10,15}$/.test(phone)) {
    return res.status(400).json({
      error: 'Enter a valid number with country code, without +.'
    });
  }

  if (isConnected) {
    return res.status(409).json({
      error: 'WhatsApp is already connected.'
    });
  }

  if (!sock) {
    return res.status(503).json({
      error: 'WhatsApp is still starting. Wait a few seconds and try again.'
    });
  }

  try {
    const code = await sock.requestPairingCode(phone);

    pairingCode = code.match(/.{1,4}/g).join('-');

    return res.json({
      success: true,
      code: pairingCode
    });

  } catch (error) {
    log(
      'ERROR',
      'PAIRING',
      'Pairing code generation failed:',
      getErrorDetails(error)
    );

    return res.status(500).json({
      error: `Could not generate pairing code: ${error.message}`
    });
  }
});

// =====================================================
// MANUAL PRIVATE MESSAGE API
// =====================================================

app.post('/send', async (req, res) => {
  const {
    to,
    message
  } = req.body || {};

  if (!sock || !isConnected) {
    return res.status(503).json({
      error: 'WhatsApp is not connected.'
    });
  }

  if (!to || !message) {
    return res.status(400).json({
      error: 'Phone number and message are required.'
    });
  }

  const phone = String(to).replace(/\D/g, '');

  if (!/^\d{10,15}$/.test(phone)) {
    return res.status(400).json({
      error: 'Invalid phone number.'
    });
  }

  try {
    await sock.sendMessage(
      `${phone}@s.whatsapp.net`,
      {
        text: String(message)
      }
    );

    return res.json({
      success: true,
      message: 'Message sent successfully.'
    });

  } catch (error) {
    log(
      'ERROR',
      'SEND_API',
      'Message sending failed:',
      getErrorDetails(error)
    );

    return res.status(500).json({
      error: error.message
    });
  }
});

// =====================================================
// UNKNOWN ROUTE
// =====================================================

app.use((req, res) => {
  res.status(404).json({
    error: 'Route not found.'
  });
});

// =====================================================
// GLOBAL HTTP ERROR HANDLER
// =====================================================

app.use((error, req, res, next) => {
  log(
    'ERROR',
    'HTTP',
    'HTTP error:',
    getErrorDetails(error)
  );

  if (res.headersSent) {
    return next(error);
  }

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
    log(
      'SUCCESS',
      'HTTP',
      `Server listening on port ${config.port}.`
    );

    log(
      'INFO',
      'CONFIG',
      `Gemini model: ${config.geminiModel}`
    );

    log(
      'INFO',
      'CONFIG',
      `Admin token configured: ${!!config.adminToken}`
    );
  }
);

// =====================================================
// START MONGODB AND WHATSAPP
// =====================================================

async function startBot() {
  log(
    'INFO',
    'STARTUP',
    '========== BOT STARTUP BEGIN =========='
  );

  try {
    if (!config.mongoUri) {
      throw new Error(
        'MONGODB_URI is missing in Render Environment.'
      );
    }

    if (!config.adminToken) {
      log(
        'WARN',
        'ADMIN',
        'ADMIN_CONTROL_TOKEN is missing; dashboard group switch will be locked.'
      );
    }

    await mongoClient.connect();

    const db = mongoClient.db(config.mongoDatabase);

    authCollection = db.collection('whatsapp_auth');

    settingsCollection = db.collection('bot_settings');

    await authCollection.createIndex({
      authId: 1
    });

    mongoConnected = true;

    await loadGroupSetting();

    await verifyGemini();

    await connectToWhatsApp();

  } catch (error) {
    mongoConnected = false;

    log(
      'ERROR',
      'STARTUP',
      'Startup failed:',
      getErrorDetails(error)
    );
  }
}

startBot();

// =====================================================
// GRACEFUL SHUTDOWN
// =====================================================

async function shutdown(signal) {
  if (shuttingDown) return;

  shuttingDown = true;

  log(
    'WARN',
    'SHUTDOWN',
    `Received ${signal}; shutting down.`
  );

  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
  }

  try {
    if (sock) {
      try {
        sock.end(undefined);
      } catch (error) {
        log(
          'WARN',
          'SHUTDOWN',
          error.message
        );
      }
    }

    if (mongoConnected) {
      await mongoClient.close();
    }

    server.close(() => process.exit(0));

    setTimeout(
      () => process.exit(0),
      8000
    ).unref();

  } catch (error) {
    log(
      'ERROR',
      'SHUTDOWN',
      'Shutdown error:',
      getErrorDetails(error)
    );

    process.exit(1);
  }
}

// =====================================================
// PROCESS ERROR HANDLERS
// =====================================================

process.on('SIGTERM', () => shutdown('SIGTERM'));

process.on('SIGINT', () => shutdown('SIGINT'));

process.on('unhandledRejection', reason => {
  log(
    'ERROR',
    'UNHANDLED_REJECTION',
    'Unhandled promise rejection:',
    reason
  );
});

process.on('uncaughtException', error => {
  log(
    'ERROR',
    'UNCAUGHT_EXCEPTION',
    'Uncaught exception:',
    getErrorDetails(error)
  );

  process.exit(1);
});
