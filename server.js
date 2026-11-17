
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

  botName: 'Manny',

  adminControlToken: process.env.ADMIN_CONTROL_TOKEN,

  personality: `
You are Manny. Your name is ALWAYS Manny.

IDENTITY:
- Your name is Manny.
- If asked "Who are you?", answer "I'm Manny 😊"
- If asked "We ni nani?", answer "Mimi ni Manny 😊"
- If asked "Unaitwa nani?", answer "Naitwa Manny 😊"
- If asked "What's your name?", answer "I'm Manny 😊"
- Never introduce yourself as an AI, chatbot, language model or virtual assistant.
- Never introduce yourself as a generic WhatsApp assistant.
- Do not invent another name.

PERSONALITY:
- Be friendly, confident, natural and approachable.
- Talk like a normal person having a WhatsApp conversation.
- Be smart, humorous and helpful when appropriate.
- Avoid sounding robotic or formal.
- Do not repeatedly introduce yourself.

SHORT REPLIES:
- Keep every reply short, brief and complete.
- Normally reply using one sentence.
- Use a maximum of two short sentences when necessary.
- Avoid long paragraphs and unnecessary explanations.
- Answer exactly what the person asks.
- Do not repeat the user's message.
- Do not add unnecessary questions at the end.
- Do not give lengthy introductions.
- Do not explain simple greetings.

LANGUAGES:
- Understand and communicate in English.
- Understand and communicate in Kiswahili.
- Understand Kenyan Sheng.
- Understand common Kenyan slang, abbreviations and informal expressions.
- Understand common Gikuyu expressions where possible.
- Understand mixed English, Swahili and Sheng.
- Respond naturally in the language used by the sender.
- If someone uses Sheng, respond naturally in Sheng.
- If someone uses Kiswahili, respond in Kiswahili.
- If someone uses English, respond in English.
- You may mix languages naturally when appropriate.

GENDER AND PRONOUN RECOGNITION:
- Pay attention to the sender's display name and conversation context.
- Never determine gender just from a name.
- Never assume gender from profile pictures, writing style, slang or other indirect clues.
- Only use he/him or she/her when the sender has explicitly confirmed their gender or clearly identified themselves using those pronouns.
- A person's name is not proof of their gender.
- If gender is uncertain, use their name or neutral wording.
- Do not call a female person brother, bro, him or he based on assumptions.
- Do not call a male person sister, her or she based on assumptions.
- Respect corrections immediately.
- Do not repeatedly ask people about their gender.
- Never invent someone's gender.

GROUP CONVERSATIONS:
- Understand that multiple people may participate in the same group.
- Pay attention to the actual sender of each message.
- Do not confuse one group member with another.
- Keep separate conversation histories for different group members.
- Do not assume that every group message is directed at you.
- Reply naturally and briefly when a message is directed at you or clearly invites a response.
- Never expose private conversations in group replies.

CONVERSATION EXAMPLES:

User: Hi
Reply: Hey! 😊

User: Hello
Reply: Hey, what's up? 😊

User: Sema
Reply: Niko fiti! Wewe je?

User: Uko aje?
Reply: Niko poa, wewe?

User: Mambo?
Reply: Safi kabisa! 😁

User: We ni nani?
Reply: Mimi ni Manny 😊

User: Wewe ni nani?
Reply: Mimi ni Manny 😊

User: Unaitwa nani?
Reply: Naitwa Manny 😊

User: Jina lako nani?
Reply: Naitwa Manny 😊

User: Who are you?
Reply: I'm Manny 😊

User: What's your name?
Reply: I'm Manny 😊

User: Asante
Reply: Karibu! 😊

User: Niaje bro?
Reply: Fiti sana bro! 😁

User: Uko wapi?
Reply: Niko hapa tu 😊

IMPORTANT:
Always maintain the identity Manny.
Always be brief, natural and relevant.
Never produce unnecessarily long WhatsApp messages.
`,

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
// LOGGING SYSTEM
// =====================================================

const startedAt = new Date();

function log(level, step, message, details) {
  const timestamp = new Date().toISOString();
  const prefix = `[${timestamp}] [${level}] [${step}]`;

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
  const result = {
    name: error?.name,
    message: error?.message,
    status: error?.status || error?.statusCode,
    code: error?.code,
    type: error?.type,
    param: error?.param
  };

  if (error?.response?.status) {
    result.responseStatus = error.response.status;
  }

  if (error?.error) {
    result.providerError = error.error;
  }

  if (error?.response?.data) {
    result.responseData = error.response.data;
  }

  if (typeof error?.toJSON === 'function') {
    try {
      result.sdkError = error.toJSON();
    } catch {}
  }

  return result;
}

function maskPhone(value) {
  const digits = String(value || '').replace(/\D/g, '');

  if (digits.length <= 4) return '****';

  return `${digits.slice(0, 3)}******${digits.slice(-2)}`;
}

function maskJid(jid) {
  if (!jid) return 'unknown';

  const number = String(jid).split('@')[0];

  return `${maskPhone(number)}@${String(jid).split('@')[1] || 'unknown'}`;
}

// =====================================================
// GLOBAL VARIABLES
// =====================================================

const app = express();

app.use(express.json({ limit: '1mb' }));

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

// Group messaging controls
let groupMessagingEnabled = false;
let groupAnnouncementInProgress = false;

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
// MONGODB AUTHENTICATION STORAGE
// =====================================================

function serialize(data) {
  return JSON.stringify(data, BufferJSON.replacer);
}

function deserialize(data) {
  if (!data) return null;
  return JSON.parse(data, BufferJSON.reviver);
}

async function saveMongoData(id, data) {
  if (!authCollection) {
    throw new Error('MongoDB auth collection is not initialized');
  }

  await authCollection.updateOne(
    { _id: `${config.authId}:${id}` },
    {
      $set: {
        authId: config.authId,
        value: serialize(data),
        updatedAt: new Date()
      }
    },
    { upsert: true }
  );
}

async function readMongoData(id) {
  if (!authCollection) {
    throw new Error('MongoDB auth collection is not initialized');
  }

  const result = await authCollection.findOne({
    _id: `${config.authId}:${id}`
  });

  return result ? deserialize(result.value) : null;
}

async function useMongoDBAuthState() {
  log('INFO', 'AUTH', 'Loading WhatsApp credentials from MongoDB');

  const storedCreds = await readMongoData('creds');
  const creds = storedCreds || initAuthCreds();

  log(
    'SUCCESS',
    'AUTH',
    storedCreds
      ? 'Existing WhatsApp credentials found'
      : 'No saved credentials; new WhatsApp pairing required'
  );

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
    state: { creds, keys },

    async saveCreds() {
      await saveMongoData('creds', creds);
    }
  };
}

// =====================================================
// GROUP SETTINGS STORAGE
// =====================================================

async function loadBotSettings() {
  try {
    const settings = await authCollection.findOne({
      _id: `${config.authId}:settings`
    });

    groupMessagingEnabled =
      settings?.groupMessagingEnabled === true;

    log(
      'SUCCESS',
      'GROUP_SETTINGS',
      `Group messaging restored: ${groupMessagingEnabled ? 'ON' : 'OFF'}`
    );

  } catch (error) {
    groupMessagingEnabled = false;

    log(
      'ERROR',
      'GROUP_SETTINGS',
      'Could not load group settings:',
      getErrorDetails(error)
    );
  }
}

async function saveGroupSetting(enabled) {
  await authCollection.updateOne(
    {
      _id: `${config.authId}:settings`
    },
    {
      $set: {
        groupMessagingEnabled: enabled,
        updatedAt: new Date()
      }
    },
    { upsert: true }
  );
}

// =====================================================
// GROUP ANNOUNCEMENTS
// =====================================================

async function announceGroupStatus(enabled) {
  if (!sock || !isConnected) {
    throw new Error('WhatsApp is not connected.');
  }

  groupAnnouncementInProgress = true;

  const announcement = enabled
    ? 'Nonchalant_Q bot turned on, may contain Ai media, the admin will be back soon'
    : 'Nonchalant_Q bot turned off. Admin is back.';

  let successful = 0;
  let failed = 0;

  try {
    const groups = await sock.groupFetchAllParticipating();
    const groupIds = Object.keys(groups || {});

    log(
      'INFO',
      'GROUP_ANNOUNCEMENT',
      `Sending announcement to ${groupIds.length} groups.`
    );

    for (const groupId of groupIds) {
      try {
        await sock.sendMessage(groupId, {
          text: announcement
        });

        successful++;

        log(
          'SUCCESS',
          'GROUP_ANNOUNCEMENT',
          `Announcement sent to ${maskJid(groupId)}`
        );

      } catch (error) {
        failed++;

        log(
          'ERROR',
          'GROUP_ANNOUNCEMENT',
          `Announcement failed for ${maskJid(groupId)}:`,
          getErrorDetails(error)
        );
      }
    }

    return {
      total: groupIds.length,
      successful,
      failed
    };

  } finally {
    groupAnnouncementInProgress = false;
  }
}

// =====================================================
// GEMINI DIAGNOSTICS
// =====================================================

async function verifyGemini() {
  if (!config.geminiKey || !aiClient) {
    aiConnected = false;

    log(
      'ERROR',
      'GEMINI_CONFIG',
      'GEMINI_API_KEY is missing. AI replies cannot work.'
    );

    return false;
  }

  log(
    'INFO',
    'GEMINI_TEST',
    `Checking API key and model access. Model: ${config.geminiModel}`
  );

  try {
    const models = await aiClient.models.list();
    const modelIds = [];

    for await (const model of models) {
      if (model?.id) modelIds.push(model.id);
    }

    log(
      'SUCCESS',
      'GEMINI_MODELS',
      `${modelIds.length} model(s) returned.`
    );

    const matchingModel = modelIds.find(id =>
      id === config.geminiModel ||
      id.endsWith(`/${config.geminiModel}`)
    );

    if (!matchingModel) {
      log(
        'WARN',
        'GEMINI_MODEL',
        `Configured model "${config.geminiModel}" was not found in the model list.`,
        modelIds
      );
    }

    const test = await aiClient.chat.completions.create({
      model: config.geminiModel,
      messages: [
        { role: 'system', content: config.personality },
        { role: 'user', content: 'What is your name?' }
      ],
      max_tokens: 30,
      temperature: 0
    });

    const testText = test.choices?.[0]?.message?.content;

    if (!testText) {
      throw new Error('Gemini test returned an empty message');
    }

    aiConnected = true;

    log(
      'SUCCESS',
      'GEMINI_TEST',
      `Gemini test succeeded. Response: ${String(testText).slice(0, 80)}`
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
// GEMINI ERROR CLASSIFICATION
// =====================================================

function classifyGeminiError(error) {
  const status = Number(
    error?.status || error?.statusCode || 0
  );

  const message = String(error?.message || '').toLowerCase();

  if (
    status === 401 ||
    status === 403 ||
    message.includes('api key') ||
    message.includes('permission')
  ) {
    return 'AUTH_OR_PERMISSION: Check GEMINI_API_KEY and Google AI Studio permissions.';
  }

  if (
    status === 404 ||
    (message.includes('model') && message.includes('not found'))
  ) {
    return `MODEL_NOT_FOUND: The configured model "${config.geminiModel}" may be unavailable or incorrectly named.`;
  }

  if (
    status === 429 ||
    message.includes('quota') ||
    message.includes('rate limit')
  ) {
    return 'QUOTA_OR_RATE_LIMIT: Gemini quota or rate limit reached.';
  }

  if (status >= 500) {
    return 'GEMINI_SERVER_ERROR: Google Gemini returned a server error.';
  }

  if (
    error?.code === 'ETIMEDOUT' ||
    error?.code === 'ECONNRESET' ||
    message.includes('timeout')
  ) {
    return 'NETWORK_OR_TIMEOUT: Request timed out or connection was interrupted.';
  }

  return 'UNKNOWN_GEMINI_ERROR: Check the full error details above.';
}

// =====================================================
// MANNY IDENTITY RECOGNITION
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

  const identityPatterns = [
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
    /^unaitwa nani wewe$/,
    /^jina lako nani$/,
    /^jina lako ni nani$/,
    /^nani wewe$/,
    /^we ni nani wewe$/,
    /^are you manny$/,
    /^manny ni wewe$/,
    /^what is your identity$/,
    /^who am i talking to$/
  ];

  if (identityPatterns.some(pattern => pattern.test(text))) {
    return 'Mimi ni Manny 😊';
  }

  return null;
}

// =====================================================
// AI REPLY GENERATION
// =====================================================

async function generateReply(chatId, userMessage, senderContext = '') {
  const started = Date.now();
  const shortChat = maskJid(chatId);

  if (!userMessage || !String(userMessage).trim()) {
    log('WARN', 'AI_REPLY', `Empty message ignored for ${shortChat}`);
    return 'Please send a text message.';
  }

  const identityReply = getIdentityReply(userMessage);

  if (identityReply) {
    const history = historyCache.get(chatId) || [];

    history.push(
      { role: 'user', content: userMessage },
      { role: 'assistant', content: identityReply }
    );

    historyCache.set(
      chatId,
      history.slice(-config.maxHistory * 2)
    );

    return identityReply;
  }

  if (!aiClient) {
    log('ERROR', 'AI_REPLY', 'Gemini client is not configured.');
    return '⚠️ The service is temporarily unavailable.';
  }

  const history = historyCache.get(chatId) || [];

  const messages = [
    {
      role: 'system',
      content:
        config.personality +
        '\n\nSENDER INFORMATION:\n' +
        (senderContext || 'Sender identity and gender are unconfirmed.') +
        '\n\nNever assume the sender gender. Use neutral wording unless gender has been explicitly confirmed.'
    },
    ...history,
    {
      role: 'user',
      content: userMessage
    }
  ];

  log(
    'INFO',
    'AI_REPLY',
    `Sending message to Gemini. Chat: ${shortChat}; model: ${config.geminiModel}; history: ${history.length}`
  );

  try {
    const response = await aiClient.chat.completions.create({
      model: config.geminiModel,
      messages,
      max_tokens: config.maxTokens,
      temperature: config.temperature
    });

    let reply = response.choices?.[0]?.message?.content?.trim();

    if (!reply) {
      throw new Error('Gemini returned an empty response');
    }

    const MAX_REPLY_LENGTH = 500;

    if (reply.length > MAX_REPLY_LENGTH) {
      const shortened = reply.slice(0, MAX_REPLY_LENGTH);
      const lastSentence = shortened.lastIndexOf('.');

      reply = lastSentence > 200
        ? shortened.slice(0, lastSentence + 1)
        : shortened.trim();
    }

    history.push(
      { role: 'user', content: userMessage },
      { role: 'assistant', content: reply }
    );

    historyCache.set(
      chatId,
      history.slice(-config.maxHistory * 2)
    );

    aiConnected = true;

    log(
      'SUCCESS',
      'AI_REPLY',
      `Gemini generated reply in ${Date.now() - started}ms. Response length: ${reply.length}`
    );

    return reply;

  } catch (error) {
    aiConnected = false;

    log(
      'ERROR',
      'AI_REPLY',
      'Gemini request failed:',
      getErrorDetails(error)
    );

    log('ERROR', 'AI_DIAGNOSIS', classifyGeminiError(error));

    return '⚠️ Sorry, the service is temporarily unavailable. Try again shortly.';
  }
}

// =====================================================
// MESSAGE TEXT EXTRACTION
// =====================================================

function extractMessageText(message) {
  if (!message) return null;

  const content =
    message.ephemeralMessage?.message ||
    message.viewOnceMessage?.message ||
    message.viewOnceMessageV2?.message ||
    message.documentWithCaptionMessage?.message ||
    message;

  const text =
    content.conversation ||
    content.extendedTextMessage?.text ||
    content.imageMessage?.caption ||
    content.videoMessage?.caption ||
    content.documentMessage?.caption ||
    content.buttonsResponseMessage?.selectedDisplayText ||
    content.listResponseMessage?.title ||
    content.templateButtonReplyMessage?.selectedDisplayText;

  return typeof text === 'string' && text.trim()
    ? text.trim()
    : null;
}

// =====================================================
// WHATSAPP RECONNECTION
// =====================================================

function scheduleReconnect(delay = 5000) {
  if (shuttingDown || reconnectTimer) return;

  log(
    'WARN',
    'WHATSAPP_RECONNECT',
    `Reconnect scheduled in ${Math.round(delay / 1000)} seconds.`
  );

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
    log(
      'WARN',
      'WHATSAPP_START',
      'Connection attempt skipped.'
    );
    return;
  }

  isConnecting = true;
  connectionState = 'connecting';

  log('INFO', 'WHATSAPP_START', 'Starting WhatsApp connection.');

  try {
    if (!mongoConnected || !authCollection) {
      throw new Error('MongoDB is not connected.');
    }

    const { state, saveCreds } = await useMongoDBAuthState();

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

    sock.ev.on('creds.update', async () => {
      try {
        await saveCreds();
        log('SUCCESS', 'WHATSAPP_AUTH_SAVE', 'Credentials saved.');
      } catch (error) {
        log(
          'ERROR',
          'WHATSAPP_AUTH_SAVE',
          'Failed to save credentials:',
          getErrorDetails(error)
        );
      }
    });

    sock.ev.on('connection.update', async update => {
      const { connection, lastDisconnect, qr } = update;

      if (qr && !isConnected) {
        try {
          latestQRDataUrl = await QRCode.toDataURL(qr, {
            width: 450,
            margin: 2
          });

          log('SUCCESS', 'WHATSAPP_QR', 'New QR code generated.');
        } catch (error) {
          log('ERROR', 'WHATSAPP_QR', 'QR generation failed:', getErrorDetails(error));
        }
      }

      if (connection === 'connecting') {
        connectionState = 'connecting';
        log('INFO', 'WHATSAPP_CONNECTION', 'Connecting to WhatsApp.');
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
          'WHATSAPP_CONNECTION',
          'WhatsApp connected successfully. Manny is online.'
        );
      }

      if (connection === 'close') {
        isConnected = false;
        isConnecting = false;
        connectionState = 'disconnected';

        latestQRDataUrl = null;
        pairingCode = null;

        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const disconnectMessage = lastDisconnect?.error?.message;

        log(
          'ERROR',
          'WHATSAPP_CONNECTION',
          'WhatsApp connection closed.',
          { statusCode, disconnectMessage }
        );

        sock = null;

        if (statusCode === DisconnectReason.loggedOut) {
          try {
            await authCollection.deleteMany({
              authId: config.authId
            });

            connectionState = 'needs_pairing';
            groupMessagingEnabled = false;

            await saveGroupSetting(false);

            log(
              'SUCCESS',
              'WHATSAPP_LOGOUT',
              'Old WhatsApp session cleared.'
            );

            scheduleReconnect(3000);

          } catch (error) {
            log('ERROR', 'WHATSAPP_LOGOUT', 'Session clearing failed:', getErrorDetails(error));
            scheduleReconnect(10000);
          }

        } else {
          reconnectAttempts++;
          connectionState = 'reconnecting';

          const delay = Math.min(
            3000 * reconnectAttempts,
            30000
          );

          scheduleReconnect(delay);
        }
      }
    });

    // =================================================
    // RECEIVE WHATSAPP MESSAGES
    // =================================================

    sock.ev.on('messages.upsert', async event => {
      if (event.type !== 'notify') return;

      log(
        'INFO',
        'WHATSAPP_INCOMING',
        `Received ${event.messages?.length || 0} incoming notification(s).`
      );

      for (const msg of event.messages || []) {
        try {
          if (!msg.message || msg.key.fromMe) continue;

          const chatId = msg.key.remoteJid;

          if (!chatId) continue;

          // Ignore statuses, channels and broadcasts.
          if (
            chatId === 'status@broadcast' ||
            chatId.endsWith('@newsletter') ||
            chatId.endsWith('@broadcast')
          ) {
            continue;
          }

          const isGroup = chatId.endsWith('@g.us');

          // Group toggle control.
          if (isGroup) {
            if (
              !groupMessagingEnabled ||
              groupAnnouncementInProgress
            ) {
              log(
                'INFO',
                'WHATSAPP_GROUP',
                `Group message ignored because group messaging is OFF or an announcement is running.`
              );
              continue;
            }
          }

          // Identify the actual sender.
          const senderJid = isGroup
            ? (msg.key.participant || msg.participant || 'unknown')
            : chatId;

          const senderName = msg.pushName || 'Unknown sender';

          const userMessage = extractMessageText(msg.message);

          if (!userMessage) {
            log(
              'WARN',
              'WHATSAPP_INCOMING',
              `No supported text or caption from ${maskJid(senderJid)}.`
            );
            continue;
          }

          // Separate histories for every person.
          const historyId = isGroup
            ? `${chatId}:${senderJid}`
            : chatId;

          const senderContext = [
            `Display name: ${senderName}`,
            `Sender WhatsApp ID: ${maskJid(senderJid)}`,
            `Chat type: ${isGroup ? 'WhatsApp group' : 'Private chat'}`,
            'Gender: Not confirmed unless explicitly stated in conversation.'
          ].join('\n');

          log(
            'SUCCESS',
            'WHATSAPP_INCOMING',
            `Received ${isGroup ? 'group' : 'private'} message from ${maskJid(senderJid)}. Length: ${userMessage.length}`
          );

          // Generate AI response.
          const reply = await generateReply(
            historyId,
            userMessage,
            senderContext
          );

          // Recheck group toggle before sending.
          if (
            isGroup &&
            (!groupMessagingEnabled || groupAnnouncementInProgress)
          ) {
            log(
              'INFO',
              'WHATSAPP_GROUP',
              'Reply cancelled because group messaging was switched OFF.'
            );
            continue;
          }

          if (sock && isConnected) {
            await sock.sendMessage(
              chatId,
              { text: reply },
              { quoted: msg }
            );

            log(
              'SUCCESS',
              'WHATSAPP_SEND',
              `Reply sent to ${maskJid(chatId)}.`
            );
          }

        } catch (error) {
          log(
            'ERROR',
            'WHATSAPP_MESSAGE',
            'Message processing failed:',
            getErrorDetails(error)
          );
        }
      }
    });

    isConnecting = false;

    log(
      'SUCCESS',
      'WHATSAPP_SOCKET',
      'WhatsApp socket and message handlers registered.'
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
// ADMIN AUTHENTICATION
// =====================================================

function authorizeAdmin(req, res, next) {
  if (!config.adminControlToken) {
    return res.status(503).json({
      error: 'ADMIN_CONTROL_TOKEN is not configured in Render.'
    });
  }

  const suppliedToken =
    req.headers['x-admin-token'] ||
    req.body?.adminToken ||
    req.query?.token;

  if (suppliedToken !== config.adminControlToken) {
    return res.status(401).json({
      error: 'Unauthorized. Invalid admin token.'
    });
  }

  next();
}

// =====================================================
// MAIN PAGE
// =====================================================

app.get('/', (req, res) => {
  const indexPath = path.join(__dirname, 'index.html');

  if (fs.existsSync(indexPath)) {
    return res.sendFile(indexPath);
  }

  return res.redirect('/qr');
});

// =====================================================
// HEALTH CHECK
// =====================================================

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

    groupRepliesEnabled: groupMessagingEnabled,
    groupAnnouncementInProgress,

    quotedRepliesEnabled: true,
    pairingReady: !!sock && !isConnected,
    qrPending: !!latestQRDataUrl
  });
});

// =====================================================
// STATUS ENDPOINT
// =====================================================

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

    groupMessagingEnabled,
    groupAnnouncementInProgress
  });
});

// =====================================================
// GROUP STATUS ENDPOINT
// =====================================================

app.get('/groups/status', authorizeAdmin, (req, res) => {
  res.json({
    success: true,
    enabled: groupMessagingEnabled,
    connected: isConnected,
    announcementInProgress: groupAnnouncementInProgress
  });
});

// =====================================================
// GROUP ON/OFF CONTROL
// =====================================================

let groupToggleLock = false;

app.post('/groups/toggle', authorizeAdmin, async (req, res) => {
  if (groupToggleLock) {
    return res.status(409).json({
      error: 'Another group toggle operation is already running.'
    });
  }

  const enabled = req.body?.enabled;

  if (typeof enabled !== 'boolean') {
    return res.status(400).json({
      error: 'Send enabled as true or false.'
    });
  }

  if (!sock || !isConnected) {
    return res.status(503).json({
      error: 'WhatsApp is not connected.'
    });
  }

  if (enabled === groupMessagingEnabled) {
    return res.json({
      success: true,
      enabled: groupMessagingEnabled,
      message: enabled
        ? 'Group messaging is already ON.'
        : 'Group messaging is already OFF.'
    });
  }

  groupToggleLock = true;

  try {
    if (enabled) {
      // Keep replies disabled until announcements finish.
      groupMessagingEnabled = false;

      const result = await announceGroupStatus(true);

      await saveGroupSetting(true);

      groupMessagingEnabled = true;

      log(
        'SUCCESS',
        'GROUP_CONTROL',
        'Group messaging switched ON.'
      );

      return res.json({
        success: true,
        enabled: true,
        message: 'Group announcements sent. Group replies are now ON.',
        announcements: result
      });

    } else {
      // Disable replies immediately.
      groupMessagingEnabled = false;

      await saveGroupSetting(false);

      const result = await announceGroupStatus(false);

      log(
        'SUCCESS',
        'GROUP_CONTROL',
        'Group messaging switched OFF. Admin is back.'
      );

      return res.json({
        success: true,
        enabled: false,
        message: 'Group replies are OFF. Admin is back.',
        announcements: result
      });
    }

  } catch (error) {
    log(
      'ERROR',
      'GROUP_CONTROL',
      'Group toggle failed:',
      getErrorDetails(error)
    );

    // Fail closed: do not unexpectedly enable replies.
    if (enabled) {
      groupMessagingEnabled = false;

      try {
        await saveGroupSetting(false);
      } catch {}
    }

    return res.status(500).json({
      error: error.message,
      enabled: groupMessagingEnabled
    });

  } finally {
    groupToggleLock = false;
  }
});

// =====================================================
// WHATSAPP LOGIN PAGE
// =====================================================

app.get('/qr', (req, res) => {
  if (isConnected) {
    return res.send(`
      <!DOCTYPE html>
      <html>
      <head>
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <title>WhatsApp Connected</title>
      </head>
      <body style="font-family:Arial;text-align:center;padding:60px 15px;background:#f0f2f5">
        <h1 style="color:#25d366">WhatsApp Connected!</h1>
        <h3>Manny is online.</h3>
        <a href="/health">Check Bot Status</a>
      </body>
      </html>
    `);
  }

  const qrSection = latestQRDataUrl
    ? `<img id="qrImage" src="${latestQRDataUrl}" style="width:90%;max-width:350px;height:auto">`
    : `<p id="qrImage">Waiting for QR code...</p>`;

  res.send(`
<!DOCTYPE html>
<html>
<head>
  <title>WhatsApp Bot Login</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">

  <style>
    * { box-sizing:border-box; }

    body {
      margin:0;
      padding:25px 15px;
      background:#f0f2f5;
      font-family:Arial,sans-serif;
      color:#333;
      text-align:center;
    }

    h1,h2 { color:#075e54; }

    .card {
      background:white;
      max-width:480px;
      margin:25px auto;
      padding:25px;
      border-radius:18px;
      box-shadow:0 3px 15px rgba(0,0,0,.04);
    }

    input {
      width:100%;
      padding:17px;
      font-size:18px;
      border:2px solid #ccc;
      border-radius:10px;
      margin-top:12px;
    }

    button {
      width:100%;
      padding:17px;
      font-size:18px;
      font-weight:bold;
      color:white;
      background:#25d366;
      border:none;
      border-radius:10px;
      margin-top:15px;
      cursor:pointer;
    }

    button:disabled { opacity:.6; }

    #code {
      font-size:32px;
      font-weight:bold;
      color:#128c7e;
      letter-spacing:4px;
      margin-top:20px;
      word-break:break-word;
    }

    #message { line-height:1.6; margin-top:15px; }
    .status { font-size:15px; color:#667781; }
  </style>
</head>

<body>

  <h1>WhatsApp Bot Login</h1>

  <p class="status" id="status">Checking WhatsApp connection...</p>
  <p class="status" id="mongo">MongoDB: Checking...</p>
  <p class="status" id="ai">Gemini: Checking...</p>

  <div class="card">
    <h2>Login with Phone Number</h2>

    <p>Enter your WhatsApp number with country code.</p>

    <input
      id="phone"
      type="tel"
      inputmode="numeric"
      placeholder="254712345678"
      maxlength="15"
    >

    <button id="getCode" onclick="getPairingCode()">
      Get Pairing Code
    </button>

    <div id="message"></div>
    <div id="code"></div>

    <p id="instructions" style="display:none">
      Open WhatsApp → Linked Devices → Link a Device →
      Link with phone number instead.
    </p>
  </div>

  <div class="card">
    <h2>Or Scan QR Code</h2>
    ${qrSection}
    <p>WhatsApp → Linked Devices → Link a Device.</p>
  </div>

<script>
async function getPairingCode() {
  const phone = document.getElementById('phone').value.trim();
  const button = document.getElementById('getCode');
  const message = document.getElementById('message');
  const codeDisplay = document.getElementById('code');

  if (!/^\\d{10,15}$/.test(phone)) {
    message.style.color = 'red';
    message.innerText = 'Enter a valid number with country code, without +.';
    return;
  }

  button.disabled = true;
  button.innerText = 'Generating...';
  message.innerText = '';
  codeDisplay.innerText = '';

  try {
    const response = await fetch(
      '/request-pairing?phone=' + encodeURIComponent(phone)
    );

    const data = await response.json();

    if (!response.ok) throw new Error(data.error || 'Pairing failed');

    codeDisplay.innerText = data.code;
    message.style.color = 'green';
    message.innerText = 'Pairing code generated successfully!';

    document.getElementById('instructions').style.display = 'block';

  } catch(error) {
    message.style.color = 'red';
    message.innerText = error.message;

  } finally {
    button.disabled = false;
    button.innerText = 'Get Pairing Code';
  }
}

async function updateStatus() {
  try {
    const response = await fetch('/status');
    const data = await response.json();

    document.getElementById('status').innerText =
      data.connected ? 'WhatsApp Connected!' : 'WhatsApp: ' + data.state;

    document.getElementById('mongo').innerText =
      'MongoDB: ' + (data.mongoConnected ? 'Connected' : 'Disconnected');

    document.getElementById('ai').innerText =
      'Gemini: ' +
      (data.aiConnected
        ? 'Working'
        : data.aiConfigured
          ? 'Configured; test not confirmed'
          : 'API key missing');

    if (data.connected) {
      window.location.reload();
      return;
    }

    if (data.qr) {
      const qr = document.getElementById('qrImage');

      if (qr.tagName === 'IMG') {
        qr.src = data.qr;
      } else {
        qr.outerHTML =
          '<img id="qrImage" src="' + data.qr +
          '" style="width:90%;max-width:350px;height:auto">';
      }
    }

  } catch(error) {
    console.log('Status check failed:', error.message);
  }
}

setInterval(updateStatus, 5000);
updateStatus();
</script>

</body>
</html>
  `);
});

// =====================================================
// PAIRING CODE ENDPOINT
// =====================================================

app.get('/request-pairing', async (req, res) => {
  const phone = String(req.query.phone || '').replace(/\D/g, '');

  log('INFO', 'PAIRING_REQUEST', `Pairing requested for ${maskPhone(phone)}.`);

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

    log('SUCCESS', 'PAIRING_REQUEST', `Pairing code generated for ${maskPhone(phone)}.`);

    return res.json({
      success: true,
      code: pairingCode
    });

  } catch(error) {
    log('ERROR', 'PAIRING_REQUEST', 'Pairing code generation failed:', getErrorDetails(error));

    return res.status(500).json({
      error: `Could not generate pairing code: ${error.message}`
    });
  }
});

// =====================================================
// SEND MESSAGE API
// =====================================================

app.post('/send', async (req, res) => {
  const { to, message } = req.body || {};

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
      { text: String(message) }
    );

    log('SUCCESS', 'SEND_API', `Message sent to ${maskPhone(phone)}.`);

    return res.json({
      success: true,
      message: 'Message sent successfully.'
    });

  } catch(error) {
    log('ERROR', 'SEND_API', 'Message sending failed:', getErrorDetails(error));

    return res.status(500).json({
      error: error.message
    });
  }
});

// =====================================================
// UNKNOWN ROUTE
// =====================================================

app.use((req, res) => {
  log('WARN', 'HTTP_404', `Unknown route: ${req.method} ${req.path}`);

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
    'HTTP_ERROR',
    `HTTP error on ${req.method} ${req.path}:`,
    getErrorDetails(error)
  );

  if (res.headersSent) return next(error);

  res.status(500).json({
    error: 'Internal server error.'
  });
});

// =====================================================
// START HTTP SERVER
// =====================================================

const server = app.listen(config.port, '0.0.0.0', () => {
  log('SUCCESS', 'HTTP_SERVER', `Server listening on port ${config.port}.`);

  log('INFO', 'CONFIG', `Bot name: ${config.botName}`);
  log('INFO', 'CONFIG', `Gemini model: ${config.geminiModel}`);

  log('INFO', 'CONFIG', `Gemini API key present: ${!!config.geminiKey}`);
  log('INFO', 'CONFIG', `MongoDB URI present: ${!!config.mongoUri}`);

  log('INFO', 'CONFIG', `Admin token configured: ${!!config.adminControlToken}`);
});

// =====================================================
// START MONGODB AND WHATSAPP
// =====================================================

async function startBot() {
  log('INFO', 'STARTUP', '========== BOT STARTUP BEGIN ==========');

  try {
    if (!config.mongoUri) {
      throw new Error('MONGODB_URI is missing in Render Environment.');
    }

    log('INFO', 'MONGODB_CONNECT', 'Connecting to MongoDB...');

    await mongoClient.connect();

    const db = mongoClient.db(config.mongoDatabase);
    authCollection = db.collection('whatsapp_auth');

    await authCollection.createIndex({ authId: 1 });

    mongoConnected = true;

    log(
      'SUCCESS',
      'MONGODB_CONNECT',
      `MongoDB connected. Database: ${config.mongoDatabase}.`
    );

    // Restore group toggle before WhatsApp starts.
    await loadBotSettings();

    // Verify Gemini.
    await verifyGemini();

    // Connect WhatsApp.
    await connectToWhatsApp();

    log(
      'INFO',
      'STARTUP',
      'Startup completed. WhatsApp connection may still be in progress.'
    );

  } catch(error) {
    mongoConnected = false;

    log('ERROR', 'STARTUP', 'Fatal startup error:', getErrorDetails(error));

    log(
      'ERROR',
      'STARTUP',
      'Server remains available for health and log inspection.'
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

  log('WARN', 'SHUTDOWN', `Received ${signal}. Starting graceful shutdown.`);

  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
  }

  try {
    if (sock) {
      try {
        sock.end(undefined);
      } catch(error) {
        log('WARN', 'SHUTDOWN', 'Error closing WhatsApp socket:', getErrorDetails(error));
      }
    }

    if (mongoConnected) {
      await mongoClient.close();
      log('SUCCESS', 'SHUTDOWN', 'MongoDB connection closed.');
    }

    server.close(() => {
      log('SUCCESS', 'SHUTDOWN', 'HTTP server closed.');
      process.exit(0);
    });

    setTimeout(() => process.exit(0), 8000).unref();

  } catch(error) {
    log('ERROR', 'SHUTDOWN', 'Shutdown error:', getErrorDetails(error));
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
    reason instanceof Error ? getErrorDetails(reason) : reason
  );
});

process.on('uncaughtException', error => {
  log('ERROR', 'UNCAUGHT_EXCEPTION', 'Uncaught exception:', getErrorDetails(error));
  process.exit(1);
});
