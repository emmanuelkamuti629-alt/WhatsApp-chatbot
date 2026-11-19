

require('dotenv').config();

const express = require('express');
const path = require('path');
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

  maxHistory: Math.max(
    1,
    Number(process.env.MAX_HISTORY_MESSAGES || 10)
  ),

  maxTokens: Math.min(
    250,
    Math.max(80, Number(process.env.OPENAI_MAX_TOKENS || 180))
  ),

  temperature: Number(process.env.OPENAI_TEMPERATURE || 0.7),

  announcementDelay: 500,

  privateChatCooldown: 3 * 60 * 1000,

  personality: `
You are Manny, a highly multilingual WhatsApp assistant.

IDENTITY:
- Your name is Manny.
- Never introduce yourself automatically.
- Never say "I am Manny" or "Mimi ni Manny" unless someone asks your name or identity.
- When asked your name, answer naturally in the language required.
- Never invent another identity.
- Do not repeatedly introduce yourself.

=====================================================
STRICT LANGUAGE RULES
=====================================================

LANGUAGE CONSISTENCY IS YOUR HIGHEST PRIORITY.

Every incoming message must be treated as a separate language detection task.

The language of the CURRENT incoming message determines
the language of the reply.

MANDATORY RULES:

1. English message = English reply ONLY.
2. Kiswahili message = Kiswahili reply.
3. Sheng message = Natural Sheng or Kiswahili/Sheng.
4. Gikuyu message = Gikuyu reply.
5. Kamba message = Kamba reply.
6. French message = French reply.
7. German message = German reply.
8. Arabic message = Arabic reply.
9. Chinese message = Chinese reply.
10. Other languages = Reply in the same language whenever supported.

ABSOLUTE RESTRICTIONS:

- NEVER reply to English in Kiswahili.
- NEVER reply to English in Sheng.
- NEVER reply to Kiswahili in English unless requested.
- NEVER reply to French in English unless requested.
- NEVER switch languages because previous messages used another language.
- NEVER copy the language of an earlier assistant response.
- NEVER allow conversation history to determine the current response language.
- NEVER randomly mix languages.
- NEVER translate automatically.
- NEVER assume that everyone wants English.
- NEVER assume that everyone wants Kiswahili.
- NEVER use Sheng unless the incoming message is Sheng or Kiswahili/Sheng is explicitly requested.

KISWAHILI AND SHENG:
Kiswahili and Sheng are allowed to share natural responses.
Do not confuse this permission with permission to use Kiswahili
when someone is communicating in English.

LANGUAGE SWITCHING:

If someone explicitly requests another language, obey that request.

Examples:
- Speak English.
- Switch to French.
- Talk in Kiswahili.
- Use Gikuyu.
- Reply in Arabic.

An explicit language request overrides the detected language
for that response.

For subsequent messages, detect their language again.
Do not permanently force a language unless the sender
explicitly requests an ongoing language preference.

SHORT MESSAGES:

For messages such as:
Hi, Hello, Okay, Yes, No, Thanks, Good morning.

Use the language indicated by the current message.
Do not let conversation history override a clearly identifiable language.

MIXED LANGUAGES:

If a message contains multiple languages, identify the dominant
language and respond in that language.

If Kiswahili and Sheng are mixed, use natural Kiswahili/Sheng.

UNSUPPORTED OR UNCERTAIN LANGUAGES:

If you cannot confidently understand a language, politely ask
for clarification using the most likely language.
Never pretend to understand a language you do not understand.

=====================================================
PERSONALITY
=====================================================

- Friendly.
- Confident.
- Humorous when appropriate.
- Natural.
- Helpful.
- Conversational.
- Respectful.
- Not robotic.

Do not become unnecessarily defensive when insulted.
Respond naturally to jokes, teasing and casual conversations.

=====================================================
RESPONSE LENGTH
=====================================================

- Normally one sentence.
- Maximum two short sentences when necessary.
- Avoid unnecessary explanations.
- Do not repeat the user's message.
- Avoid unnecessary greetings.
- Answer the actual question.

=====================================================
GENDER
=====================================================

- Never assume someone's gender from a name.
- Use neutral language when uncertain.

=====================================================
FINAL PRIORITY
=====================================================

Before every response:

1. Identify the language of the current message.
2. Check whether the sender explicitly requested another language.
3. Select the correct response language.
4. Generate the reply in that language only.
5. Check that the reply does not randomly contain another language.

The language used in previous messages MUST NOT override
the language required for the current response.
`
};

// =====================================================
// APPLICATION
// =====================================================

const app = express();

app.use(express.json({ limit: '1mb' }));

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
let activityCollection;

let mongoConnected = false;
let aiConnected = false;
let shuttingDown = false;

let botPower = true;
let groupMessaging = false;

let accountAnnouncementRunning = false;
let groupAnnouncementRunning = false;

const accounts = new Map();

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
  if (!config.adminToken) return next();

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
    { _id: `${accountId}:${id}` },
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

function createAccountRecord(id, label, manualTakeover = false) {
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

    manualTakeover: manualTakeover === true,

    reconnectTimer: null,
    reconnectAttempts: 0,
    generation: 0,

    botSentIds: new Map(),
    botSendingJids: new Map()
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
        manualTakeover: account.manualTakeover === true,
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
          manualTakeover: false
        },
        $setOnInsert: {
          createdAt: new Date()
        }
      },
      { upsert: true }
    );
  }

  const all = await accountsCollection.find({}).toArray();

  for (const item of all) {
    createAccountRecord(
      item._id,
      item.label,
      item.manualTakeover === true
    );
  }

  log('SUCCESS', 'Accounts restored', {
    count: all.length
  });
}

// =====================================================
// CHAT DIRECTORY
// =====================================================

async function rememberChat(accountId, jid, name = '') {
  if (!jid || jid === 'status@broadcast') return;

  await chatsCollection.updateOne(
    { _id: `${accountId}:${jid}` },
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
  return chatsCollection.find({ accountId }).toArray();
}

// =====================================================
// PRIVATE CHAT ACTIVITY
// =====================================================

function getPrivateAliases(msg) {
  const key = msg?.key || {};

  const candidates = [
    key.remoteJid,
    key.remoteJidAlt,
    key.participant,
    key.participantAlt,
    msg?.remoteJid,
    msg?.remoteJidAlt
  ];

  return [...new Set(
    candidates
      .filter(Boolean)
      .map(String)
      .filter(value =>
        value.endsWith('@s.whatsapp.net') ||
        value.endsWith('@lid')
      )
  )];
}

async function markAdminActivity(accountId, aliases) {
  const validAliases = [...new Set(
    (Array.isArray(aliases) ? aliases : [aliases])
      .filter(Boolean)
      .map(String)
      .filter(jid =>
        jid.endsWith('@s.whatsapp.net') ||
        jid.endsWith('@lid')
      )
  )];

  if (!validAliases.length) return;

  const now = new Date();

  await activityCollection.bulkWrite(
    validAliases.map(jid => ({
      updateOne: {
        filter: { _id: `${accountId}:${jid}` },
        update: {
          $set: {
            accountId,
            jid,
            lastAdminMessageAt: now,
            updatedAt: now
          },
          $setOnInsert: { createdAt: now }
        },
        upsert: true
      }
    })),
    { ordered: false }
  );
}

async function isPrivateChatCoolingDown(accountId, aliases) {
  const validAliases = [...new Set(
    (Array.isArray(aliases) ? aliases : [aliases])
      .filter(Boolean)
      .map(String)
  )];

  if (!validAliases.length) return false;

  const documents = await activityCollection.find({
    accountId,
    jid: { $in: validAliases }
  }).toArray();

  if (!documents.length) return false;

  const latestActivity = Math.max(
    ...documents.map(document =>
      new Date(document.lastAdminMessageAt || 0).getTime()
    )
  );

  return Date.now() - latestActivity < config.privateChatCooldown;
}

// =====================================================
// BOT MESSAGE IDENTIFICATION
// =====================================================

function rememberBotMessage(account, jid, messageId) {
  if (!messageId) return;

  account.botSentIds.set(String(messageId), {
    jid,
    expiresAt: Date.now() + 2 * 60 * 1000
  });

  for (const [id, data] of account.botSentIds) {
    if (data.expiresAt < Date.now()) {
      account.botSentIds.delete(id);
    }
  }
}

function isBotMessageEcho(account, msg) {
  const id = msg?.key?.id;

  if (!id) return false;

  const stored = account.botSentIds.get(String(id));

  if (!stored) return false;

  if (stored.expiresAt < Date.now()) {
    account.botSentIds.delete(String(id));
    return false;
  }

  return true;
}

// =====================================================
// LANGUAGE DETECTION
// =====================================================

async function detectReplyLanguage(message) {
  if (!aiClient) {
    return 'the same language as the current incoming message';
  }

  try {
    const response = await aiClient.chat.completions.create({

      model: config.geminiModel,

      messages: [
        {
          role: 'system',

          content: `
You are an expert multilingual language detector.

Analyze ONLY the current incoming WhatsApp message.

Do not use conversation history.

Identify the language that should be used to reply.

IMPORTANT RULES:

1. Detect the actual language of the message.
2. English must be identified as English.
3. Kiswahili must be identified as Kiswahili.
4. Sheng must be identified as Sheng.
5. Kiswahili and Sheng may share the response category:
   Kiswahili/Sheng.
6. Identify Gikuyu, Kamba, Dholuo, Somali and other
   African languages where possible.
7. Identify international languages.
8. Detect mixed-language messages and select the dominant language.
9. If the message explicitly requests another response language,
   select that requested language instead.
10. Very short ambiguous messages should use the most likely
    language supported by the actual words.

EXAMPLES:

"Hello, how are you?" = English

"How was your day?" = English

"Habari yako?" = Kiswahili/Sheng

"Niaje bro?" = Kiswahili/Sheng

"Uvoo waku" = Kamba

"Ũhoro waku?" = Gikuyu

"Bonjour" = French

"Wie geht es dir?" = German

"Hola, cómo estás?" = Spanish

"مرحبا" = Arabic

"你好" = Chinese

Return ONLY the language name.

Do not explain your answer.
`
        },

        {
          role: 'user',
          content: String(message)
        }
      ],

      max_tokens: 25,
      temperature: 0
    });

    const language = response.choices?.[0]?.message?.content
      ?.trim()
      .replace(/["'`]/g, '')
      .replace(/[.!]+$/g, '');

    if (!language || language.length > 60) {
      throw new Error('Invalid language detection result');
    }

    log('INFO', 'Message language detected', {
      language
    });

    return language;

  } catch (error) {

    log('WARN', 'Language detection failed', error);

    return 'the same language as the current incoming message';
  }
}

// =====================================================
// LANGUAGE-LOCKED AI REPLIES
// =====================================================

async function generateReply(accountId, chatId, userMessage) {

  if (!aiClient) {
    return '⚠️ The service is temporarily unavailable.';
  }

  const key = `${accountId}:${chatId}`;

  const history = historyCache.get(key) || [];

  try {

    // Detect the language of the current message only.
    const replyLanguage = await detectReplyLanguage(userMessage);

    const languageInstruction = `
=====================================================
MANDATORY LANGUAGE LOCK
=====================================================

REQUIRED RESPONSE LANGUAGE: ${replyLanguage}

This instruction has the highest priority.

You MUST respond entirely in ${replyLanguage}.

The CURRENT incoming message determines the language.

STRICT RESTRICTIONS:

- If required language is English, use English ONLY.
- If required language is Kiswahili/Sheng, use Kiswahili/Sheng.
- Never answer an English message in Kiswahili.
- Never answer an English message in Sheng.
- Never answer a Kiswahili message in English unless requested.
- Never change language because of conversation history.
- Never copy the language of previous assistant messages.
- Never randomly mix languages.
- Do not automatically translate.
- Do not introduce yourself.
- Only mention Manny when asked about your identity.

Conversation history is provided ONLY for understanding
the meaning and context of the conversation.

It MUST NOT influence the language of this response.

If the current incoming message explicitly requests
a different response language, follow that request.

Before sending your response, check that the entire
response follows the required language.

Return only the natural WhatsApp reply.
`;

    const response = await aiClient.chat.completions.create({

      model: config.geminiModel,

      messages: [

        {
          role: 'system',
          content: config.personality
        },

        {
          role: 'system',
          content: languageInstruction
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

    // Save conversation context.
    // Do not save the detected language as a permanent setting.

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
      key,
      history.slice(-config.maxHistory * 2)
    );

    aiConnected = true;

    log('SUCCESS', 'Language-locked reply generated', {
      account: accountId,
      language: replyLanguage
    });

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

function formatBotMessage(message) {
  const content = String(message || '').trim();

  if (/^⚠️\.bot\*/i.test(content)) {
    return content;
  }

  return `⚠️.bot*\n${content}`;
}

async function sendText(account, jid, text, quoted) {
  if (!account.sock || !account.connected) {
    throw new Error(`Account ${account.id} is disconnected`);
  }

  const isGroup = String(jid || '').endsWith('@g.us');

  const outgoingText = isGroup
    ? formatBotMessage(text)
    : String(text || '').trim();

  const options = quoted ? { quoted } : {};

  const count = account.botSendingJids.get(jid) || 0;

  account.botSendingJids.set(jid, count + 1);

  try {

    const result = await account.sock.sendMessage(
      jid,
      { text: outgoingText },
      options
    );

    if (result?.key?.id) {
      rememberBotMessage(account, jid, result.key.id);
    }

    return result;

  } finally {

    const remaining =
      (account.botSendingJids.get(jid) || 1) - 1;

    if (remaining <= 0) {
      account.botSendingJids.delete(jid);
    } else {
      account.botSendingJids.set(jid, remaining);
    }
  }
}

// =====================================================
// PRIVATE ACCOUNT ANNOUNCEMENTS
// =====================================================

function announcementText(enabled) {
  return enabled
    ? '⚠️.bot*\nEnabled'
    : '⚠️.bot*\nOff';
}

async function announceAccount(account, enabled) {
  if (!account.connected || !account.sock) return;

  const chats = await getKnownChats(account.id);

  const notice = announcementText(enabled);

  for (const chat of chats) {

    if (!account.connected || !account.sock) break;

    if (!chat.jid || chat.jid.endsWith('@g.us')) continue;

    try {

      await sendText(account, chat.jid, notice);

      await new Promise(resolve =>
        setTimeout(resolve, 350)
      );

    } catch (error) {

      log('WARN', 'Private announcement failed', {
        account: account.id,
        chat: maskJid(chat.jid),
        error: error.message
      });
    }
  }
}

async function announceAllAccounts(enabled) {
  if (accountAnnouncementRunning) return;

  accountAnnouncementRunning = true;

  try {

    for (const account of accounts.values()) {
      if (account.connected) {
        await announceAccount(account, enabled);
      }
    }

  } finally {

    accountAnnouncementRunning = false;
  }
}

// =====================================================
// GROUP ANNOUNCEMENTS
// =====================================================

function groupMessagingAnnouncementText(enabled) {
  return enabled
    ? '⚠️.bot*\nEnabled'
    : '⚠️.bot*\nOff';
}

async function getAllAccountGroups(account) {
  if (!account.sock || !account.connected) return [];

  const groupJids = new Set();

  try {

    const participatingGroups =
      await account.sock.groupFetchAllParticipating();

    for (const jid of Object.keys(participatingGroups || {})) {
      if (jid.endsWith('@g.us')) {
        groupJids.add(jid);
      }
    }

  } catch (error) {

    log('WARN', 'Could not fetch participating groups', error);
  }

  try {

    const savedChats = await getKnownChats(account.id);

    for (const chat of savedChats) {
      if (chat.jid && chat.jid.endsWith('@g.us')) {
        groupJids.add(chat.jid);
      }
    }

  } catch (error) {

    log('WARN', 'Could not fetch saved groups', error);
  }

  return [...groupJids];
}

async function announceGroupMessagingAccount(account, enabled) {
  if (!account.connected || !account.sock) {
    return {
      account: account.id,
      sent: 0,
      failed: 0
    };
  }

  const groups = await getAllAccountGroups(account);

  const notice = groupMessagingAnnouncementText(enabled);

  let sent = 0;
  let failed = 0;

  for (const groupJid of groups) {

    if (!account.connected || !account.sock) break;

    if (!groupJid.endsWith('@g.us')) continue;

    try {

      await sendText(account, groupJid, notice);

      sent++;

    } catch (error) {

      failed++;

      log('WARN', 'Group notification failed', {
        account: account.id,
        group: maskJid(groupJid),
        error: error.message
      });
    }

    await new Promise(resolve =>
      setTimeout(resolve, config.announcementDelay)
    );
  }

  return {
    account: account.id,
    totalGroups: groups.length,
    sent,
    failed
  };
}

async function announceAllGroups(enabled) {
  if (groupAnnouncementRunning) return;

  groupAnnouncementRunning = true;

  try {

    const results = [];

    for (const account of accounts.values()) {
      if (account.connected) {
        results.push(
          await announceGroupMessagingAccount(account, enabled)
        );
      }
    }

    log('SUCCESS', 'Group announcements processed', results);

  } catch (error) {

    log('ERROR', 'Group announcement process failed', error);

  } finally {

    groupAnnouncementRunning = false;
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
// PROCESS WHATSAPP MESSAGE
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

  // Handle outgoing messages.
  if (msg.key.fromMe) {

    if (isGroup) return;

    if (isBotMessageEcho(account, msg)) return;

    if (account.botSendingJids.has(jid)) return;

    const aliases = getPrivateAliases(msg);

    await markAdminActivity(
      account.id,
      aliases.length ? aliases : [jid]
    );

    return;
  }

  if (!botPower) return;

  if (isGroup && !groupMessaging) return;

  if (!isGroup && account.manualTakeover) return;

  const aliases = isGroup ? [] : getPrivateAliases(msg);

  if (!isGroup) {

    const coolingDown = await isPrivateChatCoolingDown(
      account.id,
      aliases.length ? aliases : [jid]
    );

    if (coolingDown) return;
  }

  const userMessage = extractText(msg.message);

  if (!userMessage) return;

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

  // Recheck settings before sending.
  if (!botPower) return;

  if (isGroup && !groupMessaging) return;

  if (!isGroup && account.manualTakeover) return;

  // Recheck private chat cooldown.
  if (!isGroup) {

    const coolingDown = await isPrivateChatCoolingDown(
      account.id,
      aliases.length ? aliases : [jid]
    );

    if (coolingDown) {

      log('INFO', 'Reply cancelled: admin recently messaged', {
        account: account.id,
        chat: maskJid(jid)
      });

      return;
    }
  }

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

    const { state, saveCreds } =
      await mongoAuthState(accountId);

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

          account.state = 'qr_ready';

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

        log('SUCCESS', 'WhatsApp account connected', {
          account: account.id,
          manualTakeover: account.manualTakeover
        });
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

          await authCollection.deleteMany({ accountId });

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
// WAIT FOR SOCKET BEFORE PAIRING
// =====================================================

async function waitForAccountSocket(account, timeout = 20000) {
  const started = Date.now();

  while (Date.now() - started < timeout) {

    if (account.connected) {
      throw new Error('Account is already connected.');
    }

    if (account.sock) {

      await new Promise(resolve =>
        setTimeout(resolve, 1500)
      );

      if (account.sock) return account.sock;
    }

    if (!account.connecting && !account.reconnectTimer) {
      await connectAccount(account.id);
    }

    await new Promise(resolve =>
      setTimeout(resolve, 300)
    );
  }

  throw new Error(
    'WhatsApp connection is taking too long. Please try again.'
  );
}

// =====================================================
// DISCONNECT ACCOUNT
// =====================================================

async function disconnectAccount(accountId) {
  const account = accounts.get(accountId);

  if (!account) throw new Error('Account not found.');

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

  await authCollection.deleteMany({ accountId });

  await chatsCollection.deleteMany({ accountId });

  await activityCollection.deleteMany({ accountId });

  await accountsCollection.deleteOne({ _id: accountId });

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
    pairingCode: account.pairingCode,
    manualTakeover: account.manualTakeover === true
  };
}

function getDashboardStatus() {
  return {
    botPower,
    groupMessaging,
    aiConnected,
    aiConfigured: !!aiClient,
    mongoConnected,
    privateChatCooldownMinutes: 3,

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
// API: BOT POWER
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

    log('SUCCESS', 'Bot power changed', { enabled });

    announceAllAccounts(enabled).catch(error => {

      log('ERROR', 'Private announcement process failed', error);

    });

    res.json({
      success: true,

      message: enabled ? 'Bot turned ON.' : 'Bot turned OFF.',

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

    const wasEnabled = groupMessaging;

    if (wasEnabled === enabled) {

      return res.json({
        success: true,

        message: enabled
          ? 'Group messaging is already enabled.'
          : 'Group messaging is already disabled.',

        status: getDashboardStatus()
      });
    }

    groupMessaging = enabled;

    await saveSettings();

    log('SUCCESS', 'Group messaging changed', { enabled });

    announceAllGroups(enabled).catch(error => {

      log('ERROR', 'Group announcement failed', error);

    });

    res.json({
      success: true,

      message: enabled
        ? 'Group messaging is ON.'
        : 'Group messaging is OFF.',

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
// API: MANUAL TAKEOVER
// =====================================================

app.post('/api/accounts/:id/takeover', adminAuth, async (req, res) => {

  try {

    const id = String(req.params.id || '');

    if (!validAccountId(id)) {
      return res.status(400).json({
        error: 'Invalid account ID.'
      });
    }

    const account = accounts.get(id);

    if (!account) {
      return res.status(404).json({
        error: 'Account not found.'
      });
    }

    if (!account.connected) {
      return res.status(503).json({
        error: 'Selected WhatsApp account is not connected.'
      });
    }

    const enabled = req.body?.enabled;

    if (typeof enabled !== 'boolean') {
      return res.status(400).json({
        error: 'enabled must be true or false.'
      });
    }

    await accountsCollection.updateOne(
      { _id: account.id },
      {
        $set: {
          manualTakeover: enabled,
          label: account.label,
          updatedAt: new Date()
        }
      },
      { upsert: true }
    );

    account.manualTakeover = enabled;

    return res.json({
      success: true,

      message: enabled
        ? `Manual takeover ON for ${account.label}.`
        : `Manual takeover OFF for ${account.label}.`,

      account: publicAccount(account),

      status: getDashboardStatus()
    });

  } catch (error) {

    log('ERROR', 'Manual takeover update failed', error);

    return res.status(500).json({
      error: 'Could not save Manual Takeover setting.',
      details: error.message
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
      label || `WhatsApp ${accounts.size + 1}`,
      false
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
// API: RECONNECT ACCOUNT
// =====================================================

app.post('/api/accounts/:id/connect', adminAuth, async (req, res) => {

  try {

    const account = accounts.get(req.params.id);

    if (!account) {
      return res.status(404).json({
        error: 'Account not found.'
      });
    }

    if (account.connected) {
      return res.json({
        success: true,
        message: 'Account is already connected.'
      });
    }

    if (account.reconnectTimer) {
      clearTimeout(account.reconnectTimer);
      account.reconnectTimer = null;
    }

    if (!account.connecting) {
      await connectAccount(account.id);
    }

    return res.json({
      success: true,

      message: 'WhatsApp connection started.',

      account: publicAccount(account)
    });

  } catch (error) {

    log('ERROR', 'Account reconnect failed', error);

    return res.status(500).json({
      error: error.message
    });
  }
});

// =====================================================
// API: PAIR ACCOUNT
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

    const phone = String(
      req.body?.phone || ''
    ).replace(/\D/g, '');

    if (!/^\d{10,15}$/.test(phone)) {
      return res.status(400).json({
        error: 'Enter a valid phone number with country code.'
      });
    }

    const socket = await waitForAccountSocket(account);

    if (account.connected || !account.sock) {
      return res.status(409).json({
        error: 'Account connection changed. Refresh and try again.'
      });
    }

    const code = await socket.requestPairingCode(phone);

    account.pairingCode = code;

    return res.json({
      success: true,

      code,

      message: 'Pairing code generated successfully.'
    });

  } catch (error) {

    log('ERROR', 'Pairing code request failed', error);

    return res.status(500).json({
      error: error.message || 'Could not generate pairing code.'
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
// API: MANUAL PRIVATE MESSAGE
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

    const jid = `${phone}@s.whatsapp.net`;

    await sendText(account, jid, String(message));

    await markAdminActivity(account.id, [jid]);

    res.json({
      success: true,

      message: 'Message sent. Three-minute timer started.'
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

    privateChatCooldownMinutes: 3,

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

  res.sendFile(path.join(__dirname, 'index.html'));

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

    activityCollection = db.collection('private_chat_activity');

    await Promise.all([

      authCollection.createIndex({ accountId: 1 }),

      chatsCollection.createIndex({ accountId: 1 }),

      accountsCollection.createIndex({ _id: 1 }),

      activityCollection.createIndex({
        accountId: 1,
        jid: 1
      })

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
