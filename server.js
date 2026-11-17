require('dotenv').config();

const express = require('express');
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

// ======================================================
// CONFIGURATION
// ======================================================
const config = {
  port: Number(process.env.PORT || 3000),
  botName: process.env.BOT_NAME || 'Smart Assistant',
  geminiKey: process.env.GEMINI_API_KEY,
  geminiModel: process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite',
  geminiFallbackModel: process.env.GEMINI_FALLBACK_MODEL || 'gemini-3.8-flash',
  geminiTimeoutMs: Number(process.env.GEMINI_TIMEOUT_MS || 60000),
  geminiMaxTokens: Number(process.env.GEMINI_MAX_OUTPUT_TOKENS || 4096),
  geminiTemperature: Number(process.env.GEMINI_TEMPERATURE || 0.7),
  geminiMaxRetries: Number(process.env.GEMINI_MAX_RETRIES || 3),
  mongodbUri: process.env.MONGODB_URI,
  mongodbDatabase: process.env.MONGODB_DB_NAME || 'whatsapp_bot',
  authId: process.env.WHATSAPP_AUTH_ID || 'main',
  systemPrompt: process.env.SYSTEM_PROMPT ||
    'You are a helpful WhatsApp AI assistant. Give clear, friendly and accurate answers.'
};

// ======================================================
// LOGGER AND GLOBAL STATE
// ======================================================
const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  timestamp: pino.stdTimeFunctions.isoTime
});

function info(step, message, data = {}) {
  logger.info({ step, ...data }, message);
}

function success(step, message, data = {}) {
  logger.info({ step, status: 'SUCCESS', ...data }, message);
}

function warn(step, message, data = {}) {
  logger.warn({ step, ...data }, message);
}

function error(step, message, err) {
  logger.error({
    step,
    message,
    error: err?.message || String(err),
    name: err?.name,
    code: err?.code,
    status: err?.status,
    stack: err?.stack
  }, message);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

const app = express();

app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));

const messageCache = new NodeCache({
  stdTTL: 3600,
  checkperiod: 600
});

let mongoClient = null;
let db = null;
let authCollection = null;
let whatsappSocket = null;
let whatsappConnected = false;
let currentQR = null;
let pairingInProgress = false;
let reconnectTimer = null;
let startingWhatsApp = false;
let geminiStatus = 'NOT_TESTED';
let geminiLastError = null;
let activeGeminiModel = null;

// ======================================================
// MONGODB CONNECTION AND BAILEYS AUTH STORAGE
// ======================================================
function serialize(value) {
  return JSON.stringify(value, BufferJSON.replacer);
}

function deserialize(value) {
  if (!value) return null;
  return JSON.parse(value, BufferJSON.reviver);
}

async function connectMongoDB() {
  if (!config.mongodbUri) {
    throw new Error('MONGODB_URI environment variable is missing.');
  }

  info('MONGODB_CONNECT', 'Connecting to MongoDB...');

  mongoClient = new MongoClient(config.mongodbUri, {
    serverSelectionTimeoutMS: 30000,
    connectTimeoutMS: 30000,
    socketTimeoutMS: 60000
  });

  await mongoClient.connect();

  db = mongoClient.db(config.mongodbDatabase);
  authCollection = db.collection('whatsapp_auth');

  success('MONGODB_CONNECT', 'MongoDB connected.', {
    database: config.mongodbDatabase
  });
}

async function useMongoAuthState() {
  info('AUTH', 'Loading WhatsApp credentials from MongoDB.');

  const credsId = `${config.authId}:creds`;
  const credsDocument = await authCollection.findOne({ _id: credsId });

  let creds;

  if (credsDocument?.data) {
    creds = deserialize(credsDocument.data);
    success('AUTH', 'Existing WhatsApp credentials found.');
  } else {
    creds = initAuthCreds();
    success('AUTH', 'New WhatsApp credentials initialized.');
  }

  const saveCreds = async () => {
    await authCollection.updateOne(
      { _id: credsId },
      {
        $set: {
          data: serialize(creds),
          updatedAt: new Date()
        }
      },
      { upsert: true }
    );

    success('WHATSAPP_AUTH_SAVE', 'WhatsApp credentials saved to MongoDB.');
  };

  const keys = {
    get: async (type, ids) => {
      const result = {};

      if (!ids.length) return result;

      const prefix = `${config.authId}:key:${type}:`;

      const documents = await authCollection.find({
        _id: {
          $in: ids.map(id => `${prefix}${id}`)
        }
      }).toArray();

      for (const document of documents) {
        const id = document._id.substring(prefix.length);
        result[id] = deserialize(document.data);
      }

      return result;
    },

    set: async data => {
      const operations = [];

      for (const [type, entries] of Object.entries(data)) {
        for (const [id, value] of Object.entries(entries)) {
          const documentId = `${config.authId}:key:${type}:${id}`;

          if (value === null || value === undefined) {
            operations.push({
              deleteOne: {
                filter: { _id: documentId }
              }
            });
          } else {
            operations.push({
              updateOne: {
                filter: { _id: documentId },
                update: {
                  $set: {
                    data: serialize(value),
                    updatedAt: new Date()
                  }
                },
                upsert: true
              }
            });
          }
        }
      }

      if (operations.length) {
        await authCollection.bulkWrite(operations);
      }
    }
  };

  return {
    state: { creds, keys },
    saveCreds
  };
}

// ======================================================
// GEMINI API WITH RETRIES AND MODEL FALLBACK
// ======================================================
function getGeminiModels() {
  return [
    ...new Set([
      config.geminiModel,
      config.geminiFallbackModel
    ].filter(Boolean))
  ];
}

function isRetryableStatus(status) {
  return [429, 500, 502, 503, 504].includes(status);
}

async function requestGeminiModel(model, contents) {
  if (!config.geminiKey) {
    throw new Error('GEMINI_API_KEY is missing.');
  }

  const endpoint =
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;

  let lastError;

  const maxAttempts = Math.max(1, config.geminiMaxRetries);

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const controller = new AbortController();

    const timeout = setTimeout(
      () => controller.abort(),
      config.geminiTimeoutMs
    );

    const startedAt = Date.now();

    try {
      info('GEMINI_REQUEST', 'Sending Gemini request.', {
        model,
        attempt,
        maxAttempts
      });

      const response = await fetch(endpoint, {
        method: 'POST',

        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': config.geminiKey
        },

        body: JSON.stringify({
          systemInstruction: {
            parts: [
              { text: config.systemPrompt }
            ]
          },

          contents,

          generationConfig: {
            temperature: config.geminiTemperature,
            maxOutputTokens: config.geminiMaxTokens
          }
        }),

        signal: controller.signal
      });

      const responseText = await response.text();

      let result;

      try {
        result = JSON.parse(responseText);
      } catch {
        const parseError = new Error(
          `Invalid Gemini response. HTTP ${response.status}: ${responseText.substring(0, 300)}`
        );

        parseError.status = response.status;
        parseError.retryable = isRetryableStatus(response.status);

        throw parseError;
      }

      if (!response.ok) {
        const apiError = new Error(
          `Gemini API HTTP ${response.status}: ${result?.error?.message || responseText.substring(0, 300)}`
        );

        apiError.status = response.status;
        apiError.retryable = isRetryableStatus(response.status);

        throw apiError;
      }

      const answer = result?.candidates?.[0]?.content?.parts
        ?.map(part => part.text || '')
        .join('')
        .trim();

      if (!answer) {
        throw new Error(
          `Gemini returned no text. Finish reason: ${result?.candidates?.[0]?.finishReason || 'UNKNOWN'}`
        );
      }

      success('GEMINI_REQUEST', 'Gemini response received.', {
        model,
        durationMs: Date.now() - startedAt
      });

      return answer;

    } catch (err) {
      lastError = err;

      if (err.name === 'AbortError') {
        lastError = new Error(
          `Gemini request timed out after ${config.geminiTimeoutMs}ms.`
        );

        lastError.retryable = true;
      }

      const retryable =
        lastError.retryable === true ||
        (
          lastError.retryable === undefined &&
          ['TypeError', 'TimeoutError'].includes(lastError.name)
        );

      error('GEMINI_REQUEST', 'Gemini request failed.', lastError);

      if (!retryable || attempt === maxAttempts) {
        throw lastError;
      }

      const delay = Math.min(
        1000 * (2 ** (attempt - 1)),
        10000
      );

      warn('GEMINI_RETRY', 'Retrying Gemini request.', {
        model,
        attempt,
        nextAttempt: attempt + 1,
        delayMs: delay
      });

      await sleep(delay);

    } finally {
      clearTimeout(timeout);
    }
  }

  throw lastError || new Error('Gemini request failed.');
}

async function askGemini(prompt, history = []) {
  if (!config.geminiKey) {
    throw new Error('GEMINI_API_KEY is missing.');
  }

  const contents = [];

  for (const item of history) {
    if (
      item &&
      ['user', 'model'].includes(item.role) &&
      typeof item.text === 'string'
    ) {
      contents.push({
        role: item.role,
        parts: [{ text: item.text }]
      });
    }
  }

  contents.push({
    role: 'user',
    parts: [{ text: prompt }]
  });

  let lastError;

  const models = getGeminiModels();

  for (let index = 0; index < models.length; index++) {
    const model = models[index];

    try {
      info('GEMINI_MODEL', 'Trying Gemini model.', {
        model,
        fallback: index > 0
      });

      const answer = await requestGeminiModel(model, contents);

      activeGeminiModel = model;
      geminiStatus = 'CONNECTED';
      geminiLastError = null;

      if (index > 0) {
        success(
          'GEMINI_FALLBACK',
          'Backup Gemini model connected successfully.',
          { model }
        );
      }

      return answer;

    } catch (err) {
      lastError = err;

      const canFallback =
        err.retryable === true ||
        [404, 429, 500, 502, 503, 504].includes(err.status);

      if (!canFallback || index === models.length - 1) {
        break;
      }

      warn(
        'GEMINI_FALLBACK',
        'Primary model unavailable. Trying backup model.',
        {
          failedModel: model,
          nextModel: models[index + 1],
          error: err.message
        }
      );
    }
  }

  geminiStatus = 'ERROR';
  geminiLastError = lastError?.message || 'Unknown Gemini error';

  throw lastError || new Error('All Gemini models failed.');
}

async function testGemini() {
  info('GEMINI_TEST', 'Starting Gemini API verification.');

  try {
    const response = await askGemini(
      'Reply with exactly: Gemini connection successful.'
    );

    success('GEMINI_TEST', 'Gemini verification successful.', {
      response: response.substring(0, 150),
      activeModel: activeGeminiModel
    });

    return true;

  } catch (err) {
    geminiLastError = err.message;
    geminiStatus = 'ERROR';

    error('GEMINI_TEST', 'Gemini verification failed.', err);

    return false;
  }
}

// ======================================================
// WHATSAPP MESSAGE HANDLING
// ======================================================
function extractMessageText(message) {
  if (!message) return '';

  const content =
    message.ephemeralMessage?.message ||
    message.viewOnceMessage?.message ||
    message.viewOnceMessageV2?.message ||
    message.documentWithCaptionMessage?.message ||
    message;

  return (
    content.conversation ||
    content.extendedTextMessage?.text ||
    content.imageMessage?.caption ||
    content.videoMessage?.caption ||
    content.documentMessage?.caption ||
    content.buttonsResponseMessage?.selectedDisplayText ||
    content.listResponseMessage?.title ||
    content.templateButtonReplyMessage?.selectedDisplayText ||
    ''
  ).trim();
}

async function generateReply(chatId, userMessage) {
  const history = messageCache.get(chatId) || [];

  const reply = await askGemini(userMessage, history);

  const updatedHistory = [
    ...history,
    { role: 'user', text: userMessage },
    { role: 'model', text: reply }
  ];

  messageCache.set(chatId, updatedHistory.slice(-20));

  return reply;
}

// ======================================================
// WHATSAPP CONNECTION
// ======================================================
async function startWhatsApp() {
  if (startingWhatsApp || whatsappConnected) {
    warn(
      'WHATSAPP_START',
      'WhatsApp is already starting or connected.'
    );

    return;
  }

  startingWhatsApp = true;

  try {
    info('WHATSAPP_START', 'Starting WhatsApp connection.');

    const { state, saveCreds } = await useMongoAuthState();

    info('WHATSAPP_SOCKET', 'Creating WhatsApp socket.');

    const socket = makeWASocket({
      auth: state,
      logger: pino({ level: 'silent' }),
      printQRInTerminal: false,
      browser: [config.botName, 'Chrome', '1.0.0'],
      connectTimeoutMs: 60000,
      defaultQueryTimeoutMs: 60000,
      keepAliveIntervalMs: 25000,
      markOnlineOnConnect: true,
      syncFullHistory: false
    });

    whatsappSocket = socket;

    socket.ev.on('creds.update', async () => {
      try {
        await saveCreds();
      } catch (err) {
        error(
          'WHATSAPP_AUTH_SAVE',
          'Could not save WhatsApp credentials.',
          err
        );
      }
    });

    socket.ev.on('connection.update', async update => {
      const {
        connection,
        lastDisconnect,
        qr
      } = update;

      if (qr) {
        currentQR = qr;

        info(
          'WHATSAPP_QR',
          'New WhatsApp QR code generated.'
        );
      }

      if (connection === 'connecting') {
        info(
          'WHATSAPP_CONNECTION',
          'Connecting to WhatsApp...'
        );
      }

      if (connection === 'open') {
        whatsappConnected = true;
        currentQR = null;
        pairingInProgress = false;

        success(
          'WHATSAPP_CONNECTION',
          'WhatsApp connected successfully. Bot is online.'
        );
      }

      if (connection === 'close') {
        whatsappConnected = false;
        currentQR = null;
        pairingInProgress = false;

        if (whatsappSocket === socket) {
          whatsappSocket = null;
        }

        const statusCode =
          lastDisconnect?.error?.output?.statusCode;

        warn(
          'WHATSAPP_CONNECTION',
          'WhatsApp connection closed.',
          { statusCode }
        );

        if (statusCode === DisconnectReason.loggedOut) {
          error(
            'WHATSAPP_LOGOUT',
            'WhatsApp logged out. A new pairing is required.',
            lastDisconnect?.error
          );

          return;
        }

        if (!reconnectTimer) {
          reconnectTimer = setTimeout(() => {
            reconnectTimer = null;

            startWhatsApp().catch(err => {
              error(
                'WHATSAPP_RECONNECT',
                'WhatsApp reconnection failed.',
                err
              );
            });

          }, 5000);
        }
      }
    });

    socket.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return;

      for (const message of messages) {
        try {
          if (!message.message || message.key.fromMe) {
            continue;
          }

          const chatId = message.key.remoteJid;

          if (
            !chatId ||
            chatId === 'status@broadcast' ||
            chatId.endsWith('@g.us') ||
            chatId.endsWith('@newsletter')
          ) {
            continue;
          }

          const text = extractMessageText(message.message);

          if (!text) continue;

          info('WHATSAPP_INCOMING', 'New message received.', {
            chatId,
            messageLength: text.length
          });

          if (!whatsappConnected) continue;

          const reply = await generateReply(chatId, text);

          await socket.sendMessage(chatId, {
            text: reply
          });

          success(
            'WHATSAPP_REPLY',
            'AI reply sent successfully.',
            { chatId }
          );

        } catch (err) {
          error(
            'WHATSAPP_MESSAGE',
            'Could not process incoming message.',
            err
          );
        }
      }
    });

    success(
      'WHATSAPP_SOCKET',
      'WhatsApp socket created and event handlers registered.'
    );

  } catch (err) {
    error(
      'WHATSAPP_START',
      'WhatsApp startup failed.',
      err
    );

    throw err;

  } finally {
    startingWhatsApp = false;
  }
}

// ======================================================
// HOME PAGE
// ======================================================
app.get('/', (req, res) => {
  res.send(`<!doctype html>
<html>
<head>
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${config.botName}</title>
</head>

<body style="font-family:Arial,sans-serif;text-align:center;padding:28px;background:#f5f7fb">

<h2>${config.botName}</h2>

<p>WhatsApp AI Assistant</p>

<p>WhatsApp: <b>${whatsappConnected ? 'ONLINE' : 'OFFLINE'}</b></p>

<p>Gemini: <b>${geminiStatus}</b></p>

<p>Active model: ${activeGeminiModel || 'Not selected'}</p>

<p>
<a href="/health">Health check</a> ·
<a href="/status">Bot status</a> ·
<a href="/qr">Connect WhatsApp</a>
</p>

</body>
</html>`);
});

// ======================================================
// WHATSAPP QR AND PHONE NUMBER PAIRING PAGE
// ======================================================
app.get('/qr', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');

  res.send(`<!doctype html>
<html lang="en">

<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">

<title>Connect WhatsApp</title>

<style>

* {
  box-sizing: border-box;
}

body {
  margin: 0;
  padding: 22px 14px;
  background: #f4f7fb;
  color: #172033;
  font-family: Arial, sans-serif;
}

.wrap {
  max-width: 520px;
  margin: 0 auto;
}

.card {
  background: #fff;
  border: 1px solid #e4e9f1;
  border-radius: 18px;
  padding: 22px;
  margin: 15px 0;
  box-shadow: 0 5px 20px rgba(20,40,80,.05);
}

h1 {
  font-size: 25px;
  text-align: center;
  margin: 8px 0;
}

.sub {
  text-align: center;
  color: #687386;
  font-size: 14px;
  line-height: 1.5;
}

h2 {
  font-size: 19px;
  margin: 0 0 12px;
}

.qr {
  display: block;
  width: 280px;
  max-width: 100%;
  margin: 16px auto;
  min-height: 30px;
}

.status {
  text-align: center;
  color: #566176;
  font-size: 14px;
  min-height: 22px;
}

input {
  width: 100%;
  padding: 14px;
  border: 1px solid #ccd5e2;
  border-radius: 10px;
  font-size: 17px;
  margin: 8px 0 12px;
}

button {
  width: 100%;
  padding: 14px;
  border: 0;
  border-radius: 10px;
  background: #087f5b;
  color: #fff;
  font-size: 16px;
  font-weight: bold;
  cursor: pointer;
}

button:disabled {
  opacity: .55;
  cursor: wait;
}

.code {
  font-size: 30px;
  font-weight: bold;
  letter-spacing: 5px;
  text-align: center;
  padding: 18px 8px;
  color: #075c43;
  background: #e9f8f1;
  border-radius: 12px;
  margin-top: 14px;
  word-break: break-word;
}

.note {
  font-size: 13px;
  color: #687386;
  line-height: 1.6;
}

.hidden {
  display: none;
}

.divider {
  text-align: center;
  color: #929bad;
  margin: 8px;
  font-size: 13px;
}

</style>
</head>

<body>

<main class="wrap">

<h1>Connect your WhatsApp</h1>

<p class="sub">
Choose either QR scanning or phone-number pairing.
</p>

<div class="card">

<h2>Option 1: Pair with phone number</h2>

<p class="note">
Enter the WhatsApp number you want to connect, including the country code.
Kenya example: <b>254712345678</b>.
You may also enter a Kenyan number beginning with 07 or 01.
</p>

<input
  id="phone"
  type="tel"
  inputmode="numeric"
  autocomplete="tel"
  placeholder="2547XXXXXXXX"
  maxlength="18"
>

<button
  id="pairBtn"
  type="button"
  onclick="getPairingCode()"
>
Get Pairing Code
</button>

<p id="pairMessage" class="status" aria-live="polite"></p>

<div id="codeBox" class="hidden">

<p class="sub">Enter this code in WhatsApp:</p>

<div id="pairCode" class="code"></div>

</div>

<p class="note">
On WhatsApp: Linked devices → Link a device →
Link with phone number instead.
Enter the code shown above.
</p>

</div>

<div class="divider">OR</div>

<div class="card">

<h2>Option 2: Scan QR code</h2>

<p class="sub">
Open WhatsApp → Linked devices → Link a device,
then scan this code.
</p>

<img
  id="qrImage"
  class="qr"
  alt="WhatsApp QR code"
  style="display:none"
>

<p id="qrMessage" class="status">
Waiting for WhatsApp QR code...
</p>

</div>

<div class="card">

<p id="connectionStatus" class="status">
Checking connection status...
</p>

</div>

</main>

<script>

const phoneInput = document.getElementById('phone');

const pairBtn = document.getElementById('pairBtn');

const pairMessage = document.getElementById('pairMessage');

const codeBox = document.getElementById('codeBox');

const pairCode = document.getElementById('pairCode');

const qrImage = document.getElementById('qrImage');

const qrMessage = document.getElementById('qrMessage');

const connectionStatus = document.getElementById('connectionStatus');

async function getPairingCode() {

  const phone = phoneInput.value.trim();

  if (!phone) {
    pairMessage.textContent =
      'Enter your WhatsApp phone number first.';
    return;
  }

  pairBtn.disabled = true;
  pairBtn.textContent = 'Requesting code...';

  pairMessage.textContent = 'Contacting WhatsApp...';

  codeBox.classList.add('hidden');

  try {

    const response = await fetch('/request-pairing', {
      method: 'POST',

      headers: {
        'Content-Type': 'application/json'
      },

      body: JSON.stringify({ phone })
    });

    const data = await response.json();

    if (!response.ok || !data.success) {
      throw new Error(
        data.error || 'Could not generate pairing code.'
      );
    }

    pairCode.textContent = data.pairingCode;

    codeBox.classList.remove('hidden');

    pairMessage.textContent =
      'Pairing code generated. Use it in WhatsApp now.';

  } catch (err) {

    pairMessage.textContent = err.message;

  } finally {

    pairBtn.disabled = false;
    pairBtn.textContent = 'Get Pairing Code';

  }
}

async function refreshPageStatus() {

  try {

    const response = await fetch('/status', {
      cache: 'no-store'
    });

    const data = await response.json();

    if (data.whatsappConnected) {

      connectionStatus.textContent =
        'WhatsApp is connected. Your bot is online.';

      pairBtn.disabled = true;
      pairBtn.textContent = 'WhatsApp Connected';

      qrImage.style.display = 'none';

      qrMessage.textContent =
        'WhatsApp is already connected.';

      return;
    }

    connectionStatus.textContent =
      'WhatsApp: Waiting for pairing · Gemini: ' +
      (data.geminiStatus || 'checking');

  } catch (e) {

    connectionStatus.textContent =
      'Could not read connection status. Refresh this page.';

  }
}

async function refreshQR() {

  try {

    const response = await fetch('/qr-data', {
      cache: 'no-store'
    });

    const data = await response.json();

    if (data.connected) {

      qrImage.style.display = 'none';

      qrMessage.textContent =
        'WhatsApp is already connected.';

      return;
    }

    if (data.qr) {

      qrImage.src = data.qr;

      qrImage.style.display = 'block';

      qrMessage.textContent =
        'QR code ready. Scan it with WhatsApp.';

    } else if (!qrImage.src) {

      qrImage.style.display = 'none';

      qrMessage.textContent =
        'Waiting for WhatsApp QR code...';

    }

  } catch (e) {

    qrMessage.textContent =
      'Waiting for QR code...';

  }
}

refreshPageStatus();

refreshQR();

setInterval(refreshPageStatus, 4000);

setInterval(refreshQR, 4000);

</script>

</body>
</html>`);
});

// ======================================================
// QR CODE DATA ENDPOINT
// ======================================================
app.get('/qr-data', async (req, res) => {

  res.setHeader('Cache-Control', 'no-store');

  if (whatsappConnected) {
    return res.json({
      success: true,
      connected: true,
      qr: null
    });
  }

  if (!currentQR) {
    return res.json({
      success: true,
      connected: false,
      qr: null
    });
  }

  try {

    const image = await QRCode.toDataURL(currentQR, {
      width: 320,
      margin: 1
    });

    return res.json({
      success: true,
      connected: false,
      qr: image
    });

  } catch (err) {

    error(
      'QR_DATA',
      'Could not convert QR code to image.',
      err
    );

    return res.status(500).json({
      success: false,
      error: 'Could not generate QR image.'
    });

  }
});

// ======================================================
// HEALTH AND STATUS
// ======================================================
app.get('/health', (req, res) => {

  const ready =
    Boolean(db) &&
    whatsappConnected &&
    geminiStatus === 'CONNECTED';

  res.status(ready ? 200 : 503).json({

    success: ready,

    bot: config.botName,

    whatsapp: whatsappConnected
      ? 'CONNECTED'
      : 'DISCONNECTED',

    gemini: geminiStatus,

    activeGeminiModel,

    mongodb: db
      ? 'CONNECTED'
      : 'DISCONNECTED',

    geminiError: geminiLastError

  });

});

app.get('/status', (req, res) => {

  res.json({

    bot: config.botName,

    whatsappConnected,

    geminiStatus,

    geminiModel: config.geminiModel,

    geminiFallbackModel: config.geminiFallbackModel,

    activeGeminiModel,

    geminiLastError,

    mongodbConnected: Boolean(db),

    pairingInProgress,

    qrAvailable: Boolean(currentQR)

  });

});

// ======================================================
// PHONE-NUMBER PAIRING CODE
// ======================================================
function normalizePairingPhone(value) {

  let phone = String(value || '').replace(/\D/g, '');

  if (phone.startsWith('00')) {
    phone = phone.slice(2);
  }

  // Accept Kenyan local mobile format.
  if (/^0[17]\d{8}$/.test(phone)) {
    phone = `254${phone.slice(1)}`;
  }

  return phone;
}

app.post('/request-pairing', async (req, res) => {

  if (pairingInProgress) {
    return res.status(409).json({
      success: false,
      error: 'A pairing request is already in progress. Please wait.'
    });
  }

  try {

    const phone = normalizePairingPhone(
      req.body.phone ||
      req.body.phoneNumber ||
      req.body.number
    );

    if (!phone || phone.length < 10 || phone.length > 15) {

      return res.status(400).json({
        success: false,
        error: 'Enter a valid phone number with country code. Example: 254712345678.'
      });

    }

    if (whatsappConnected) {

      return res.status(400).json({
        success: false,
        error: 'WhatsApp is already connected.'
      });

    }

    if (!whatsappSocket) {

      return res.status(503).json({
        success: false,
        error: 'WhatsApp socket is not ready. Wait a few seconds and try again.'
      });

    }

    pairingInProgress = true;

    info(
      'WHATSAPP_PAIRING',
      'Requesting WhatsApp pairing code.',
      { phoneEnding: phone.slice(-4) }
    );

    const code = await whatsappSocket.requestPairingCode(phone);

    success(
      'WHATSAPP_PAIRING',
      'WhatsApp pairing code generated.'
    );

    return res.json({
      success: true,
      pairingCode: code
    });

  } catch (err) {

    error(
      'WHATSAPP_PAIRING',
      'Could not generate pairing code.',
      err
    );

    return res.status(500).json({
      success: false,
      error: err.message ||
        'Could not generate pairing code. Check the number and try again.'
    });

  } finally {

    pairingInProgress = false;

  }

});

// ======================================================
// SEND WHATSAPP MESSAGE
// ======================================================
app.post('/send', async (req, res) => {

  try {

    if (!whatsappConnected || !whatsappSocket) {

      return res.status(503).json({
        success: false,
        error: 'WhatsApp is not connected.'
      });

    }

    const phone = String(req.body.phone || '')
      .replace(/\D/g, '');

    const message = String(req.body.message || '')
      .trim();

    if (!phone || !message) {

      return res.status(400).json({
        success: false,
        error: 'Phone number and message are required.'
      });

    }

    const jid = `${phone}@s.whatsapp.net`;

    await whatsappSocket.sendMessage(jid, {
      text: message
    });

    success(
      'WHATSAPP_SEND',
      'Message sent successfully.',
      { jid }
    );

    return res.json({
      success: true,
      message: 'Message sent successfully.'
    });

  } catch (err) {

    error(
      'WHATSAPP_SEND',
      'Message sending failed.',
      err
    );

    return res.status(500).json({
      success: false,
      error: err.message
    });

  }

});

// ======================================================
// START SERVER
// ======================================================
async function startServer() {

  info('STARTUP', 'BOT STARTUP BEGIN');

  info('CONFIG', `Bot: ${config.botName}`);

  info('CONFIG', `Gemini primary model: ${config.geminiModel}`);

  info('CONFIG', `Gemini fallback model: ${config.geminiFallbackModel}`);

  info(
    'CONFIG',
    'Gemini API key present: ' + Boolean(config.geminiKey)
  );

  info(
    'CONFIG',
    'MongoDB URI present: ' + Boolean(config.mongodbUri)
  );

  info(
    'CONFIG',
    `Gemini timeout: ${config.geminiTimeoutMs}ms`
  );

  info(
    'CONFIG',
    `Gemini retries: ${config.geminiMaxRetries}`
  );

  await connectMongoDB();

  app.listen(config.port, '0.0.0.0', () => {

    success(
      'HTTP_SERVER',
      'Server running.',
      { port: config.port }
    );

  });

  // Gemini verification runs independently.
  testGemini().catch(err => {
    error(
      'GEMINI_TEST',
      'Background Gemini test failed.',
      err
    );
  });

  await startWhatsApp();

  success(
    'STARTUP',
    'Startup sequence completed.'
  );

}

// ======================================================
// GRACEFUL SHUTDOWN AND PROCESS ERRORS
// ======================================================
async function shutdown(signal) {

  warn(
    'SHUTDOWN',
    `Received ${signal}. Shutting down...`
  );

  try {

    if (reconnectTimer) {

      clearTimeout(reconnectTimer);

      reconnectTimer = null;

    }

    if (whatsappSocket) {

      whatsappSocket.end(undefined);

      whatsappSocket = null;

    }

    if (mongoClient) {
      await mongoClient.close();
    }

    success(
      'SHUTDOWN',
      'Shutdown completed.'
    );

  } catch (err) {

    error(
      'SHUTDOWN',
      'Shutdown error.',
      err
    );

  }

  process.exit(0);

}

process.on('SIGTERM', () => shutdown('SIGTERM'));

process.on('SIGINT', () => shutdown('SIGINT'));

process.on('unhandledRejection', reason => {

  error(
    'UNHANDLED_REJECTION',
    'Unhandled promise rejection.',
    reason instanceof Error
      ? reason
      : new Error(String(reason))
  );

});

process.on('uncaughtException', err => {

  error(
    'UNCAUGHT_EXCEPTION',
    'Uncaught exception.',
    err
  );

  process.exit(1);

});

startServer().catch(err => {

  error(
    'STARTUP_FATAL',
    'Bot startup failed.',
    err
  );

  process.exit(1);

});
