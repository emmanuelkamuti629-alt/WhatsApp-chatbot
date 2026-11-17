
require('dotenv').config();

const express = require('express');
const path = require('path');
const fs = require('fs');
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
// 1. CONFIGURATION
// =====================================================

const config = {
  port: Number(process.env.PORT || 3000),

  mongoUri: process.env.MONGODB_URI,
  mongoDatabase: process.env.MONGODB_DB_NAME || 'whatsapp_bot',
  authId: process.env.WHATSAPP_AUTH_ID || 'main',

  geminiKey: process.env.GEMINI_API_KEY,
  geminiModel: (process.env.GEMINI_MODEL || 'gemini-3.8-flash')
    .replace(/^models\//, ''),

  geminiThinkingLevel:
    (process.env.GEMINI_THINKING_LEVEL || 'LOW').toUpperCase(),

  geminiMaxOutputTokens: Math.max(
    1024,
    Number(process.env.GEMINI_MAX_OUTPUT_TOKENS || 4096)
  ),

  geminiTimeout: 60000,

  botName: process.env.BOT_NAME || 'Smart Assistant',

  personality:
    process.env.BOT_PERSONALITY ||
    'You are a helpful, intelligent, friendly and accurate WhatsApp assistant. Give natural, conversational answers. Understand English, Kiswahili and common Kenyan expressions. Keep simple replies short and useful.',

  maxHistory: Math.max(
    1,
    Number(process.env.MAX_HISTORY_MESSAGES || 10)
  )
};

// =====================================================
// 2. LOGGING SYSTEM
// =====================================================

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
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function errorDetails(error) {
  return {
    name: error?.name,
    message: error?.message,
    code: error?.code,
    status: error?.status,
    stack: error?.stack
  };
}

function maskPhone(phone) {
  const digits = String(phone || '').replace(/\D/g, '');

  if (digits.length <= 4) return '****';

  return `${digits.slice(0, 3)}******${digits.slice(-2)}`;
}

function maskJid(jid) {
  if (!jid) return 'unknown';

  const parts = String(jid).split('@');

  return `${maskPhone(parts[0])}@${parts[1] || 'unknown'}`;
}

// =====================================================
// 3. EXPRESS AND GLOBAL VARIABLES
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
// 4. GEMINI NATIVE API CONFIGURATION
// =====================================================

const GEMINI_BASE_URL =
  'https://generativelanguage.googleapis.com/v1beta/models/';

function getGeminiUrl(action = 'generateContent') {
  return (
    GEMINI_BASE_URL +
    encodeURIComponent(config.geminiModel) +
    ':' +
    action
  );
}

function isGemini3() {
  return config.geminiModel.startsWith('gemini-3');
}

// =====================================================
// 5. GEMINI API REQUEST
// =====================================================

async function geminiRequest(contents, systemInstruction) {

  const generationConfig = {
    maxOutputTokens: config.geminiMaxOutputTokens
  };

  // Gemini 3 supports configurable thinking levels.
  // LOW reduces unnecessary reasoning for normal chat.

  if (isGemini3()) {
    generationConfig.thinkingConfig = {
      thinkingLevel: config.geminiThinkingLevel
    };
  }

  const requestBody = {
    contents,
    generationConfig,
    systemInstruction: {
      parts: [
        {
          text: systemInstruction
        }
      ]
    }
  };

  log(
    'INFO',
    'GEMINI_REQUEST',
    `Sending request to ${config.geminiModel}.`,
    {
      maxOutputTokens: config.geminiMaxOutputTokens,
      thinkingLevel: isGemini3()
        ? config.geminiThinkingLevel
        : 'Not applicable'
    }
  );

  let response;

  try {

    response = await fetch(getGeminiUrl(), {
      method: 'POST',

      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': config.geminiKey
      },

      body: JSON.stringify(requestBody),

      signal: AbortSignal.timeout(config.geminiTimeout)
    });

  } catch (error) {

    log(
      'ERROR',
      'GEMINI_NETWORK',
      'Could not connect to Gemini API.',
      errorDetails(error)
    );

    throw error;
  }

  const rawResponse = await response.text();

  let data;

  try {
    data = JSON.parse(rawResponse);
  } catch {

    log(
      'ERROR',
      'GEMINI_JSON',
      'Gemini returned invalid JSON.',
      {
        status: response.status,
        responsePreview: rawResponse.slice(0, 1500)
      }
    );

    throw new Error(
      `Gemini returned invalid JSON. HTTP ${response.status}`
    );
  }

  if (!response.ok) {

    const providerError = data?.error || {};

    log(
      'ERROR',
      'GEMINI_HTTP',
      'Gemini API rejected the request.',
      {
        httpStatus: response.status,
        status: providerError.status,
        code: providerError.code,
        message: providerError.message,
        details: providerError.details
      }
    );

    const error = new Error(
      providerError.message ||
      `Gemini HTTP error ${response.status}`
    );

    error.status = response.status;
    error.providerError = providerError;

    throw error;
  }

  return data;
}

// =====================================================
// 6. EXTRACT GEMINI RESPONSE
// =====================================================

function extractGeminiText(data) {

  const candidate = data?.candidates?.[0];

  const parts = candidate?.content?.parts || [];

  // Exclude internal thinking parts.
  // Only return the actual answer.

  const answerParts = parts.filter(part =>
    typeof part.text === 'string' &&
    part.text.trim() &&
    part.thought !== true
  );

  const answer = answerParts
    .map(part => part.text)
    .join('\n')
    .trim();

  const diagnostics = {
    candidateCount: data?.candidates?.length || 0,

    finishReason: candidate?.finishReason || 'UNKNOWN',

    promptFeedback: data?.promptFeedback || null,

    promptTokenCount:
      data?.usageMetadata?.promptTokenCount ?? null,

    candidatesTokenCount:
      data?.usageMetadata?.candidatesTokenCount ?? null,

    thoughtsTokenCount:
      data?.usageMetadata?.thoughtsTokenCount ?? null,

    totalTokenCount:
      data?.usageMetadata?.totalTokenCount ?? null,

    partsCount: parts.length,

    thoughtPartsCount:
      parts.filter(part => part.thought === true).length,

    textPartsCount: answerParts.length,

    modelVersion: data?.modelVersion || null
  };

  return {
    answer,
    diagnostics
  };
}

// =====================================================
// 7. GEMINI STARTUP TEST
// =====================================================

async function verifyGemini() {

  log(
    'INFO',
    'GEMINI_TEST',
    'Starting Gemini API verification.'
  );

  if (!config.geminiKey) {

    aiConnected = false;

    log(
      'ERROR',
      'GEMINI_CONFIG',
      'GEMINI_API_KEY is missing from Render environment.'
    );

    return false;
  }

  const start = Date.now();

  try {

    // Test the actual configured model.

    const data = await geminiRequest(
      [
        {
          role: 'user',
          parts: [
            {
              text: 'Reply with exactly these words: GEMINI_OK'
            }
          ]
        }
      ],
      'You are a test assistant. Follow the user instruction exactly.'
    );

    const result = extractGeminiText(data);

    log(
      'INFO',
      'GEMINI_TEST_DETAILS',
      'Gemini test response metadata:',
      result.diagnostics
    );

    if (!result.answer) {

      const reason = result.diagnostics.finishReason;

      if (reason === 'MAX_TOKENS') {
        log(
          'ERROR',
          'GEMINI_EMPTY',
          'Gemini exhausted its output token allowance before producing visible text.'
        );
      } else if (reason === 'SAFETY') {
        log(
          'ERROR',
          'GEMINI_EMPTY',
          'Gemini blocked the test response for safety reasons.'
        );
      } else {
        log(
          'ERROR',
          'GEMINI_EMPTY',
          'Gemini returned no visible answer. Inspect response metadata above.'
        );
      }

      aiConnected = false;

      return false;
    }

    aiConnected = true;

    log(
      'SUCCESS',
      'GEMINI_TEST',
      `Gemini test succeeded in ${Date.now() - start}ms. Response: ${result.answer}`
    );

    return true;

  } catch (error) {

    aiConnected = false;

    log(
      'ERROR',
      'GEMINI_TEST',
      'Gemini verification failed.',
      errorDetails(error)
    );

    return false;
  }
}

// =====================================================
// 8. GEMINI ERROR DIAGNOSIS
// =====================================================

function diagnoseGeminiError(error) {

  const status = Number(error?.status || 0);

  const message = String(error?.message || '').toLowerCase();

  if (status === 400) {
    return 'INVALID_REQUEST: Check model support and request configuration.';
  }

  if (status === 401 || status === 403) {
    return 'AUTHENTICATION_ERROR: Check API key and API permissions.';
  }

  if (status === 404) {
    return `MODEL_NOT_FOUND: Check GEMINI_MODEL. Current model: ${config.geminiModel}`;
  }

  if (status === 429) {
    return 'RATE_LIMIT_OR_QUOTA: Gemini request limit or quota reached.';
  }

  if (status >= 500) {
    return 'GOOGLE_SERVER_ERROR: Gemini service returned a server error.';
  }

  if (
    message.includes('timeout') ||
    error?.name === 'TimeoutError' ||
    error?.name === 'AbortError'
  ) {
    return 'TIMEOUT: Gemini took too long to respond.';
  }

  return 'UNKNOWN_ERROR: Inspect the full Gemini error details.';
}

// =====================================================
// 9. MONGODB AUTHENTICATION STORAGE
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
    throw new Error('MongoDB collection is unavailable.');
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
    throw new Error('MongoDB collection is unavailable.');
  }

  const result = await authCollection.findOne({
    _id: `${config.authId}:${id}`
  });

  return result ? deserialize(result.value) : null;
}

// =====================================================
// 10. WHATSAPP MONGODB AUTH STATE
// =====================================================

async function useMongoDBAuthState() {

  log(
    'INFO',
    'AUTH',
    'Loading WhatsApp credentials from MongoDB.'
  );

  const storedCreds = await readMongoData('creds');

  const creds = storedCreds || initAuthCreds();

  log(
    'SUCCESS',
    'AUTH',
    storedCreds
      ? 'Existing WhatsApp credentials found.'
      : 'New WhatsApp pairing required.'
  );

  const keys = {

    async get(type, ids) {

      const result = {};

      await Promise.all(
        ids.map(async id => {
          result[id] = await readMongoData(
            `${type}-${id}`
          );
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
// 11. GENERATE AI REPLY
// =====================================================

async function generateReply(chatId, userMessage) {

  const started = Date.now();

  const safeChat = maskJid(chatId);

  if (!userMessage || !String(userMessage).trim()) {

    log(
      'WARN',
      'AI_REPLY',
      'Empty message received.'
    );

    return 'Please send a text message.';
  }

  if (!config.geminiKey) {

    log(
      'ERROR',
      'AI_REPLY',
      'Gemini API key is missing.'
    );

    return '⚠️ AI service is not configured. Please try again later.';
  }

  const history = historyCache.get(chatId) || [];

  const contents = [
    ...history,
    {
      role: 'user',
      parts: [
        {
          text: userMessage
        }
      ]
    }
  ];

  log(
    'INFO',
    'AI_REPLY',
    `Processing incoming message for ${safeChat}.`
  );

  try {

    const data = await geminiRequest(
      contents,
      config.personality
    );

    const result = extractGeminiText(data);

    log(
      'INFO',
      'GEMINI_RESPONSE_DETAILS',
      'Response metadata:',
      result.diagnostics
    );

    if (!result.answer) {

      log(
        'ERROR',
        'AI_REPLY',
        'Gemini returned an empty response.',
        {
          finishReason: result.diagnostics.finishReason,
          tokenUsage: {
            thoughts: result.diagnostics.thoughtsTokenCount,
            output: result.diagnostics.candidatesTokenCount,
            total: result.diagnostics.totalTokenCount
          }
        }
      );

      if (
        result.diagnostics.finishReason === 'MAX_TOKENS'
      ) {
        log(
          'ERROR',
          'AI_DIAGNOSIS',
          'Output token allowance was exhausted. Lower thinking level or increase GEMINI_MAX_OUTPUT_TOKENS.'
        );
      }

      if (
        result.diagnostics.finishReason === 'SAFETY'
      ) {
        log(
          'ERROR',
          'AI_DIAGNOSIS',
          'The response was blocked by Gemini safety filters.'
        );
      }

      return '⚠️ I could not generate a reply right now. Please try again.';
    }

    // Save conversation only after a successful AI response.

    const updatedHistory = [
      ...history,
      {
        role: 'user',
        parts: [{ text: userMessage }]
      },
      {
        role: 'model',
        parts: [{ text: result.answer }]
      }
    ];

    historyCache.set(
      chatId,
      updatedHistory.slice(-config.maxHistory * 2)
    );

    aiConnected = true;

    log(
      'SUCCESS',
      'AI_REPLY',
      `Gemini generated a reply in ${Date.now() - started}ms. Length: ${result.answer.length}.`
    );

    return result.answer;

  } catch (error) {

    aiConnected = false;

    log(
      'ERROR',
      'AI_REPLY',
      'Gemini generation failed.',
      errorDetails(error)
    );

    log(
      'ERROR',
      'AI_DIAGNOSIS',
      diagnoseGeminiError(error)
    );

    return '⚠️ The AI service is temporarily unavailable. Please try again shortly.';
  }
}

// =====================================================
// 12. RECONNECT WHATSAPP
// =====================================================

function scheduleReconnect(delay = 5000) {

  if (shuttingDown || reconnectTimer) return;

  log(
    'WARN',
    'WHATSAPP_RECONNECT',
    `Reconnection scheduled in ${delay}ms.`
  );

  reconnectTimer = setTimeout(() => {

    reconnectTimer = null;

    connectToWhatsApp();

  }, delay);
}

// =====================================================
// 13. CONNECT WHATSAPP
// =====================================================

async function connectToWhatsApp() {

  if (
    shuttingDown ||
    isConnecting ||
    isConnected
  ) {
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
        'MongoDB is not connected.'
      );
    }

    const {
      state,
      saveCreds
    } = await useMongoDBAuthState();

    log(
      'INFO',
      'WHATSAPP_SOCKET',
      'Creating WhatsApp socket.'
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

    // SAVE AUTHENTICATION

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
          'Could not save WhatsApp credentials.',
          errorDetails(error)
        );

      }

    });

    // CONNECTION EVENTS

    sock.ev.on('connection.update', async update => {

      const {
        connection,
        lastDisconnect,
        qr
      } = update;

      // QR CODE

      if (qr && !isConnected) {

        try {

          latestQRDataUrl = await QRCode.toDataURL(qr, {
            width: 450,
            margin: 2
          });

          log(
            'SUCCESS',
            'WHATSAPP_QR',
            'WhatsApp QR code generated.'
          );

        } catch (error) {

          log(
            'ERROR',
            'WHATSAPP_QR',
            'QR generation failed.',
            errorDetails(error)
          );

        }
      }

      // CONNECTING

      if (connection === 'connecting') {

        connectionState = 'connecting';

        log(
          'INFO',
          'WHATSAPP_CONNECTION',
          'Connecting to WhatsApp.'
        );

      }

      // CONNECTED

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

      // DISCONNECTED

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
          'WhatsApp disconnected.',
          {
            statusCode,
            disconnectMessage
          }
        );

        sock = null;

        if (
          statusCode === DisconnectReason.loggedOut
        ) {

          log(
            'WARN',
            'WHATSAPP_LOGOUT',
            'WhatsApp logged out. Clearing this auth session.'
          );

          try {

            await authCollection.deleteMany({
              authId: config.authId
            });

            connectionState = 'needs_pairing';

            log(
              'SUCCESS',
              'WHATSAPP_LOGOUT',
              'Old authentication session cleared.'
            );

            scheduleReconnect(3000);

          } catch (error) {

            log(
              'ERROR',
              'WHATSAPP_LOGOUT',
              'Could not clear old authentication.',
              errorDetails(error)
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
            `Reconnection attempt ${reconnectAttempts}. Delay: ${delay}ms.`
          );

          scheduleReconnect(delay);

        }
      }

    });

    // =================================================
    // 14. RECEIVE MESSAGES
    // =================================================

    sock.ev.on('messages.upsert', async event => {

      if (event.type !== 'notify') return;

      log(
        'INFO',
        'WHATSAPP_INCOMING',
        `Received ${event.messages?.length || 0} incoming message event(s).`
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

          if (
            !userMessage ||
            !String(userMessage).trim()
          ) {

            log(
              'WARN',
              'WHATSAPP_INCOMING',
              `Unsupported or empty message from ${maskJid(chatId)}.`
            );

            continue;
          }

          log(
            'SUCCESS',
            'WHATSAPP_INCOMING',
            `Text message received from ${maskJid(chatId)}. Length: ${userMessage.length}.`
          );

          // GENERATE AI RESPONSE

          const reply = await generateReply(
            chatId,
            userMessage.trim()
          );

          // SEND AI RESPONSE

          if (!sock || !isConnected) {

            log(
              'ERROR',
              'WHATSAPP_SEND',
              'Cannot send reply because WhatsApp disconnected.'
            );

            continue;
          }

          log(
            'INFO',
            'WHATSAPP_SEND',
            `Sending reply to ${maskJid(chatId)}.`
          );

          await sock.sendMessage(chatId, {
            text: reply
          });

          log(
            'SUCCESS',
            'WHATSAPP_SEND',
            `Reply sent successfully to ${maskJid(chatId)}.`
          );

        } catch (error) {

          log(
            'ERROR',
            'WHATSAPP_MESSAGE',
            'Message processing failed.',
            errorDetails(error)
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
      'WhatsApp startup failed.',
      errorDetails(error)
    );

    scheduleReconnect(10000);

  }
}

// =====================================================
// 15. MAIN PAGE
// =====================================================

app.get('/', (req, res) => {

  const indexPath = path.join(__dirname, 'index.html');

  if (fs.existsSync(indexPath)) {
    return res.sendFile(indexPath);
  }

  return res.redirect('/qr');

});

// =====================================================
// 16. HEALTH CHECK
// =====================================================

app.get('/health', (req, res) => {

  res.json({

    status: 'ok',

    bot: config.botName,

    uptimeSeconds: Math.floor(process.uptime()),

    aiProvider: 'Google Gemini Native API',

    aiModel: config.geminiModel,

    aiConfigured: !!config.geminiKey,

    aiConnected,

    mongoConnected,

    whatsappReady: isConnected,

    whatsappState: connectionState,

    pairingReady: !!sock && !isConnected,

    qrPending: !!latestQRDataUrl

  });

});

// =====================================================
// 17. STATUS ENDPOINT
// =====================================================

app.get('/status', (req, res) => {

  res.json({

    connected: isConnected,

    state: connectionState,

    mongoConnected,

    aiConfigured: !!config.geminiKey,

    aiConnected,

    qrPending: !!latestQRDataUrl,

    qr: latestQRDataUrl,

    pairingCode

  });

});

// =====================================================
// 18. WHATSAPP LOGIN PAGE
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

  const phone =
    document.getElementById('phone').value.trim();

  const button =
    document.getElementById('getCode');

  const message =
    document.getElementById('message');

  const codeDisplay =
    document.getElementById('code');

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

    document.getElementById('instructions').style.display =
      'block';

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
            ? 'Configured; not yet verified'
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

    console.log(
      'Status check failed:',
      error.message
    );

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
// 19. PAIRING CODE ENDPOINT
// =====================================================

app.get('/request-pairing', async (req, res) => {

  const phone = String(
    req.query.phone || ''
  ).replace(/\D/g, '');

  log(
    'INFO',
    'PAIRING_REQUEST',
    `Pairing requested for ${maskPhone(phone)}.`
  );

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
      error: 'WhatsApp is still starting. Try again shortly.'
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
      'Pairing code generation failed.',
      errorDetails(error)
    );

    return res.status(500).json({
      error: `Could not generate pairing code: ${error.message}`
    });

  }

});

// =====================================================
// 20. SEND MESSAGE API
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
      'Message sending failed.',
      errorDetails(error)
    );

    return res.status(500).json({
      error: error.message
    });

  }

});

// =====================================================
// 21. UNKNOWN ROUTES
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
// 22. GLOBAL ERROR HANDLER
// =====================================================

app.use((error, req, res, next) => {

  log(
    'ERROR',
    'HTTP_ERROR',
    `HTTP error: ${req.method} ${req.path}`,
    errorDetails(error)
  );

  if (res.headersSent) {
    return next(error);
  }

  res.status(500).json({
    error: 'Internal server error.'
  });

});

// =====================================================
// 23. START SERVER
// =====================================================

const server = app.listen(
  config.port,
  '0.0.0.0',
  () => {

    log(
      'SUCCESS',
      'HTTP_SERVER',
      `Server running on port ${config.port}.`
    );

    log(
      'INFO',
      'CONFIG',
      `Bot: ${config.botName}`
    );

    log(
      'INFO',
      'CONFIG',
      `Gemini model: ${config.geminiModel}`
    );

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

    log(
      'INFO',
      'CONFIG',
      `Gemini output allowance: ${config.geminiMaxOutputTokens}`
    );

    log(
      'INFO',
      'CONFIG',
      `Gemini thinking level: ${config.geminiThinkingLevel}`
    );

  }
);

// =====================================================
// 24. START MONGODB AND BOT
// =====================================================

async function startBot() {

  log(
    'INFO',
    'STARTUP',
    '========== BOT STARTUP BEGIN =========='
  );

  try {

    // MONGODB CONFIGURATION

    if (!config.mongoUri) {

      throw new Error(
        'MONGODB_URI is missing from Render environment.'
      );

    }

    if (!config.geminiKey) {

      log(
        'ERROR',
        'STARTUP',
        'GEMINI_API_KEY is missing.'
      );

    }

    // CONNECT TO MONGODB

    log(
      'INFO',
      'MONGODB_CONNECT',
      'Connecting to MongoDB...'
    );

    await mongoClient.connect();

    const db = mongoClient.db(
      config.mongoDatabase
    );

    authCollection = db.collection(
      'whatsapp_auth'
    );

    await authCollection.createIndex({
      authId: 1
    });

    // Verify database access.

    await authCollection.findOne({
      _id: `${config.authId}:creds`
    });

    mongoConnected = true;

    log(
      'SUCCESS',
      'MONGODB_CONNECT',
      `MongoDB connected. Database: ${config.mongoDatabase}.`
    );

    // TEST GEMINI

    await verifyGemini();

    // START WHATSAPP

    await connectToWhatsApp();

    log(
      'SUCCESS',
      'STARTUP',
      'Startup sequence completed.'
    );

  } catch(error) {

    mongoConnected = false;

    log(
      'ERROR',
      'STARTUP',
      'Startup failed.',
      errorDetails(error)
    );

    log(
      'ERROR',
      'STARTUP',
      'Check MongoDB configuration and Render environment variables.'
    );

  }

}

startBot();

// =====================================================
// 25. GRACEFUL SHUTDOWN
// =====================================================

async function shutdown(signal) {

  if (shuttingDown) return;

  shuttingDown = true;

  log(
    'WARN',
    'SHUTDOWN',
    `Received ${signal}. Shutting down.`
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
          'WhatsApp socket closing error.',
          errorDetails(error)
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

    setTimeout(() => {
      process.exit(0);
    }, 8000).unref();

  } catch(error) {

    log(
      'ERROR',
      'SHUTDOWN',
      'Shutdown failed.',
      errorDetails(error)
    );

    process.exit(1);

  }

}

// =====================================================
// 26. PROCESS ERROR HANDLERS
// =====================================================

process.on('SIGTERM', () => {
  shutdown('SIGTERM');
});

process.on('SIGINT', () => {
  shutdown('SIGINT');
});

process.on('unhandledRejection', reason => {

  log(
    'ERROR',
    'UNHANDLED_REJECTION',
    'Unhandled promise rejection.',
    reason instanceof Error
      ? errorDetails(reason)
      : reason
  );

});

process.on('uncaughtException', error => {

  log(
    'ERROR',
    'UNCAUGHT_EXCEPTION',
    'Uncaught exception.',
    errorDetails(error)
  );

  process.exit(1);

});
