
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

  botName: process.env.BOT_NAME || 'Smart Assistant',

  personality:
    process.env.BOT_PERSONALITY ||
    'You are a helpful, intelligent, friendly and accurate WhatsApp assistant. Give natural, conversational answers. Understand English, Kiswahili and common Kenyan expressions. Keep simple replies short and useful.',

  maxHistory: Math.max(1, Number(process.env.MAX_HISTORY_MESSAGES || 10)),
  maxTokens: Number(process.env.OPENAI_MAX_TOKENS || 500),
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
// GEMINI DIAGNOSTICS
// =====================================================

async function verifyGemini() {
  if (!config.geminiKey) {
    aiConnected = false;

    log(
      'ERROR',
      'GEMINI_CONFIG',
      'GEMINI_API_KEY is missing. AI replies cannot work.'
    );

    return false;
  }

  if (!aiClient) {
    aiConnected = false;

    log(
      'ERROR',
      'GEMINI_CONFIG',
      'Gemini client was not created.'
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
      if (model?.id) {
        modelIds.push(model.id);
      }
    }

    log(
      'SUCCESS',
      'GEMINI_MODELS',
      `Gemini API key accepted. ${modelIds.length} model(s) returned.`
    );

    const matchingModel = modelIds.find(id =>
      id === config.geminiModel ||
      id.endsWith(`/${config.geminiModel}`)
    );

    if (matchingModel) {
      log(
        'SUCCESS',
        'GEMINI_MODEL',
        `Configured model found: ${matchingModel}`
      );
    } else {
      log(
        'WARN',
        'GEMINI_MODEL',
        `Configured model "${config.geminiModel}" was not found in the model list.`
      );

      log(
        'INFO',
        'GEMINI_MODEL',
        'Models returned by Gemini:',
        modelIds
      );
    }

    log(
      'INFO',
      'GEMINI_TEST',
      `Sending test request to ${config.geminiModel}`
    );

    const test = await aiClient.chat.completions.create({
      model: config.geminiModel,
      messages: [
        {
          role: 'user',
          content: 'Reply with exactly: GEMINI_OK'
        }
      ],
      max_tokens: 20,
      temperature: 0
    });

    const testText =
      test.choices?.[0]?.message?.content;

    if (!testText) {
      throw new Error(
        'Gemini test completed but returned an empty message'
      );
    }

    aiConnected = true;

    log(
      'SUCCESS',
      'GEMINI_TEST',
      `Gemini test request succeeded. Response: ${String(testText).slice(0, 80)}`
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

  const message = String(
    error?.message || ''
  ).toLowerCase();

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
// AI REPLY GENERATION
// =====================================================

async function generateReply(chatId, userMessage) {
  const started = Date.now();

  const shortChat = maskJid(chatId);

  if (!userMessage || !String(userMessage).trim()) {
    log(
      'WARN',
      'AI_REPLY',
      `Empty message ignored for ${shortChat}`
    );

    return 'Please send a text message.';
  }

  if (!aiClient) {
    log(
      'ERROR',
      'AI_REPLY',
      'Gemini client is not configured. Check GEMINI_API_KEY.'
    );

    return '⚠️ The AI service is not configured yet. Please contact the bot administrator.';
  }

  const history = historyCache.get(chatId) || [];

  const messages = [
    {
      role: 'system',
      content: config.personality
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

    const reply =
      response.choices?.[0]?.message?.content?.trim();

    if (!reply) {
      log(
        'ERROR',
        'AI_REPLY',
        'Gemini returned an empty response.',
        {
          finishReason: response.choices?.[0]?.finish_reason,
          responseId: response.id,
          model: response.model
        }
      );

      throw new Error('Gemini returned an empty response');
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

    log(
      'ERROR',
      'AI_DIAGNOSIS',
      classifyGeminiError(error)
    );

    return '⚠️ Sorry, the AI service is temporarily unavailable. Please try again shortly.';
  }
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
      'Connection attempt skipped: already connected, connecting or shutting down.'
    );

    return;
  }

  isConnecting = true;
  connectionState = 'connecting';

  log(
    'INFO',
    'WHATSAPP_START',
    'Starting WhatsApp connection.'
  );

  try {
    if (!mongoConnected || !authCollection) {
      throw new Error(
        'MongoDB is not connected; cannot load WhatsApp authentication.'
      );
    }

    const {
      state,
      saveCreds
    } = await useMongoDBAuthState();

    log(
      'INFO',
      'WHATSAPP_SOCKET',
      'Creating Baileys WhatsApp socket.'
    );

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

    // SAVE WHATSAPP CREDENTIALS

    sock.ev.on('creds.update', async () => {
      try {
        await saveCreds();

        log(
          'SUCCESS',
          'WHATSAPP_AUTH_SAVE',
          'WhatsApp credentials saved to MongoDB.'
        );

      } catch (error) {
        log(
          'ERROR',
          'WHATSAPP_AUTH_SAVE',
          'Failed to save WhatsApp credentials:',
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

          log(
            'SUCCESS',
            'WHATSAPP_QR',
            'New WhatsApp QR code generated.'
          );

        } catch (error) {
          log(
            'ERROR',
            'WHATSAPP_QR',
            'QR generation failed:',
            getErrorDetails(error)
          );
        }
      }

      if (connection === 'connecting') {
        connectionState = 'connecting';

        log(
          'INFO',
          'WHATSAPP_CONNECTION',
          'Baileys is connecting to WhatsApp.'
        );
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
          'WhatsApp connected successfully. Bot is online.'
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

        const disconnectMessage =
          lastDisconnect?.error?.message;

        log(
          'ERROR',
          'WHATSAPP_CONNECTION',
          'WhatsApp connection closed.',
          {
            statusCode,
            disconnectMessage
          }
        );

        sock = null;

        if (statusCode === DisconnectReason.loggedOut) {
          log(
            'WARN',
            'WHATSAPP_LOGOUT',
            'WhatsApp reports logged out. Clearing this authId session.'
          );

          try {
            await authCollection.deleteMany({
              authId: config.authId
            });

            connectionState = 'needs_pairing';

            log(
              'SUCCESS',
              'WHATSAPP_LOGOUT',
              'Old WhatsApp session data cleared from MongoDB.'
            );

            scheduleReconnect(3000);

          } catch (error) {
            log(
              'ERROR',
              'WHATSAPP_LOGOUT',
              'Could not clear old WhatsApp session:',
              getErrorDetails(error)
            );

            scheduleReconnect(10000);
          }

        } else {
          reconnectAttempts++;

          connectionState = 'reconnecting';

          const delay = Math.min(
            3000 * reconnectAttempts,
            30000
          );

          log(
            'WARN',
            'WHATSAPP_RECONNECT',
            `Connection lost. Attempt ${reconnectAttempts}; retry delay ${delay}ms.`
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
        `WhatsApp notified ${event.messages?.length || 0} incoming message(s).`
      );

      for (const msg of event.messages || []) {
        try {
          if (!msg.message || msg.key.fromMe) continue;

          const chatId = msg.key.remoteJid;

          if (
            !chatId ||
            chatId === 'status@broadcast' ||
            chatId.endsWith('@newsletter')
          ) {
            log(
              'INFO',
              'WHATSAPP_INCOMING',
              'Ignored status, newsletter or invalid chat message.'
            );

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

          if (!userMessage || !userMessage.trim()) {
            log(
              'WARN',
              'WHATSAPP_INCOMING',
              `Message from ${maskJid(chatId)} had no supported text or caption.`
            );

            continue;
          }

          // Do not log private message contents.

          log(
            'SUCCESS',
            'WHATSAPP_INCOMING',
            `Received text message from ${maskJid(chatId)}. Length: ${userMessage.length}`
          );

          // GENERATE AI REPLY

          const reply = await generateReply(
            chatId,
            userMessage.trim()
          );

          // SEND REPLY

          if (sock && isConnected) {
            log(
              'INFO',
              'WHATSAPP_SEND',
              `Sending AI reply to ${maskJid(chatId)}.`
            );

            await sock.sendMessage(chatId, {
              text: reply
            });

            log(
              'SUCCESS',
              'WHATSAPP_SEND',
              `Reply sent successfully to ${maskJid(chatId)}.`
            );

          } else {
            log(
              'ERROR',
              'WHATSAPP_SEND',
              'Reply generated but WhatsApp disconnected before it could be sent.'
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
      'WhatsApp socket created and event handlers registered.'
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

    pairingCode
  });
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
        <h3>Your AI bot is online.</h3>
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

    button:disabled {
      opacity:.6;
    }

    #code {
      font-size:32px;
      font-weight:bold;
      color:#128c7e;
      letter-spacing:4px;
      margin-top:20px;
      word-break:break-word;
    }

    #message {
      line-height:1.6;
      margin-top:15px;
    }

    .status {
      font-size:15px;
      color:#667781;
    }
  </style>
</head>

<body>

  <h1>WhatsApp Bot Login</h1>

  <p class="status" id="status">
    Checking WhatsApp connection...
  </p>

  <p class="status" id="mongo">
    MongoDB: Checking...
  </p>

  <p class="status" id="ai">
    Gemini: Checking...
  </p>

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

    message.innerText =
      'Enter a valid number with country code, without +.';

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

    if (!response.ok) {
      throw new Error(data.error || 'Pairing failed');
    }

    codeDisplay.innerText = data.code;

    message.style.color = 'green';

    message.innerText =
      'Pairing code generated successfully!';

    document.getElementById('instructions').style.display = 'block';

  } catch(error) {

    message.style.color = 'red';
    message.innerText = error.message;

  } finally {

    button.disabled = false;
    button.innerText = 'Get Pairing Code';

  }
}

// AUTOMATIC STATUS UPDATE

async function updateStatus() {

  try {

    const response = await fetch('/status');

    const data = await response.json();

    document.getElementById('status').innerText =
      data.connected
        ? 'WhatsApp Connected!'
        : 'WhatsApp: ' + data.state;

    document.getElementById('mongo').innerText =
      'MongoDB: ' +
      (data.mongoConnected ? 'Connected' : 'Disconnected');

    document.getElementById('ai').innerText =
      'Gemini: ' +
      (
        data.aiConnected
          ? 'Working'
          : data.aiConfigured
            ? 'Configured; test not confirmed'
            : 'API key missing'
      );

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

  log(
    'INFO',
    'PAIRING_REQUEST',
    `Pairing requested for ${maskPhone(phone)}.`
  );

  if (!/^\d{10,15}$/.test(phone)) {

    log(
      'WARN',
      'PAIRING_REQUEST',
      'Rejected invalid phone number format.'
    );

    return res.status(400).json({
      error: 'Enter a valid number with country code, without +.'
    });
  }

  if (isConnected) {

    log(
      'WARN',
      'PAIRING_REQUEST',
      'WhatsApp is already connected.'
    );

    return res.status(409).json({
      error: 'WhatsApp is already connected.'
    });
  }

  if (!sock) {

    log(
      'WARN',
      'PAIRING_REQUEST',
      'WhatsApp socket is not ready.'
    );

    return res.status(503).json({
      error: 'WhatsApp is still starting. Wait a few seconds and try again.'
    });
  }

  try {

    const code = await sock.requestPairingCode(phone);

    pairingCode = code.match(/.{1,4}/g).join('-');

    log(
      'SUCCESS',
      'PAIRING_REQUEST',
      `Pairing code generated for ${maskPhone(phone)}.`
    );

    return res.json({
      success: true,
      code: pairingCode
    });

  } catch(error) {

    log(
      'ERROR',
      'PAIRING_REQUEST',
      'Pairing code generation failed:',
      getErrorDetails(error)
    );

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

    log(
      'WARN',
      'SEND_API',
      'WhatsApp is not connected.'
    );

    return res.status(503).json({
      error: 'WhatsApp is not connected.'
    });
  }

  if (!to || !message) {

    log(
      'WARN',
      'SEND_API',
      'Phone number or message is missing.'
    );

    return res.status(400).json({
      error: 'Phone number and message are required.'
    });
  }

  const phone = String(to).replace(/\D/g, '');

  if (!/^\d{10,15}$/.test(phone)) {

    log(
      'WARN',
      'SEND_API',
      'Invalid destination number.'
    );

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

    log(
      'SUCCESS',
      'SEND_API',
      `Message sent to ${maskPhone(phone)}.`
    );

    return res.json({
      success: true,
      message: 'Message sent successfully.'
    });

  } catch(error) {

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

  log(
    'WARN',
    'HTTP_404',
    `Unknown route: ${req.method} ${req.path}`
  );

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

  if (res.headersSent) {
    return next(error);
  }

  res.status(500).json({
    error: 'Internal server error.'
  });

});

// =====================================================
// START HTTP SERVER
// =====================================================

const server = app.listen(config.port, '0.0.0.0', () => {

  log(
    'SUCCESS',
    'HTTP_SERVER',
    `Server listening on port ${config.port}.`
  );

  log('INFO', 'CONFIG', `Bot name: ${config.botName}`);

  log('INFO', 'CONFIG', `Gemini model: ${config.geminiModel}`);

  log(
    'INFO',
    'CONFIG',
    `Gemini API key present: ${!!config.geminiKey}`
  );

  log(
    'INFO',
    'CONFIG',
    `MongoDB URI present: ${!!config.mongoUri}`
  );

});

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

    if (!config.geminiKey) {

      log(
        'ERROR',
        'STARTUP',
        'GEMINI_API_KEY is missing. AI replies will not work.'
      );

    }

    // CONNECT MONGODB

    log(
      'INFO',
      'MONGODB_CONNECT',
      'Connecting to MongoDB...'
    );

    await mongoClient.connect();

    const db = mongoClient.db(config.mongoDatabase);

    authCollection = db.collection('whatsapp_auth');

    await authCollection.createIndex({
      authId: 1
    });

    await authCollection.findOne({
      _id: `${config.authId}:creds`
    });

    mongoConnected = true;

    log(
      'SUCCESS',
      'MONGODB_CONNECT',
      `MongoDB connected. Database: ${config.mongoDatabase}; collection: whatsapp_auth.`
    );

    // TEST GEMINI

    await verifyGemini();

    // CONNECT WHATSAPP

    await connectToWhatsApp();

    log(
      'INFO',
      'STARTUP',
      'Startup sequence completed. WhatsApp connection may still be in progress.'
    );

  } catch(error) {

    mongoConnected = false;

    log(
      'ERROR',
      'STARTUP',
      'Fatal startup error:',
      getErrorDetails(error)
    );

    log(
      'ERROR',
      'STARTUP',
      'Server remains available for health and log inspection, but services may not work.'
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
    `Received ${signal}. Starting graceful shutdown.`
  );

  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
  }

  try {

    if (sock) {
      try {
        sock.end(undefined);
      } catch(error) {
        log(
          'WARN',
          'SHUTDOWN',
          'Error closing WhatsApp socket:',
          getErrorDetails(error)
        );
      }
    }

    if (mongoConnected) {

      await mongoClient.close();

      log(
        'SUCCESS',
        'SHUTDOWN',
        'MongoDB connection closed.'
      );

    }

    server.close(() => {

      log(
        'SUCCESS',
        'SHUTDOWN',
        'HTTP server closed.'
      );

      process.exit(0);

    });

    setTimeout(() => process.exit(0), 8000).unref();

  } catch(error) {

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
    reason instanceof Error
      ? getErrorDetails(reason)
      : reason
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
