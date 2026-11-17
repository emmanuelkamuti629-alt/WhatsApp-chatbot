
require('dotenv').config();

const express = require('express');
const pino = require('pino');
const QRCode = require('qrcode');
const NodeCache = require('node-cache');
const { MongoClient } = require('mongodb');

const {
  default: makeWASocket,
  DisconnectReason,
  initAuthCreds,
  BufferJSON,
  proto
} = require('@whiskeysockets/baileys');

// ======================================================
// CONFIGURATION
// ======================================================

const app = express();

app.use(express.json({ limit: '2mb' }));

const PORT = process.env.PORT || 10000;

const MONGODB_URI = process.env.MONGODB_URI;
const MONGODB_DB_NAME =
  process.env.MONGODB_DB_NAME || 'whatsapp_bot';

const WHATSAPP_AUTH_ID =
  process.env.WHATSAPP_AUTH_ID || 'main';

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

const GEMINI_MODEL =
  process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite';

const GEMINI_FALLBACK_MODEL =
  process.env.GEMINI_FALLBACK_MODEL || 'gemini-3.8-flash';

const GEMINI_TIMEOUT_MS =
  Number(process.env.GEMINI_TIMEOUT_MS) || 120000;

const GEMINI_MAX_OUTPUT_TOKENS =
  Number(process.env.GEMINI_MAX_OUTPUT_TOKENS) || 2048;

const BOT_SYSTEM_PROMPT =
  process.env.BOT_SYSTEM_PROMPT ||
  'You are a helpful, intelligent WhatsApp AI assistant. Answer naturally, clearly and politely. Keep replies suitable for WhatsApp.';

const logger = pino({ level: 'silent' });

const seenMessages = new NodeCache({
  stdTTL: 3600,
  checkperiod: 600
});

// ======================================================
// GLOBAL VARIABLES
// ======================================================

const mongoClient = new MongoClient(MONGODB_URI || '');

let authCollection = null;

let mongoConnected = false;

let whatsappSocket = null;

let whatsappConnected = false;

let whatsappState = 'disconnected';

let qrCodeData = null;

let startingWhatsApp = false;

let resettingAuth = false;

let reconnectTimer = null;

let pairingInProgress = false;

// ======================================================
// LOGGING
// ======================================================

function logInfo(event, message, extra = {}) {
  console.log(JSON.stringify({
    level: 'INFO',
    event,
    message,
    ...extra,
    time: new Date().toISOString()
  }));
}

function logWarn(event, message, extra = {}) {
  console.warn(JSON.stringify({
    level: 'WARN',
    event,
    message,
    ...extra,
    time: new Date().toISOString()
  }));
}

function logError(event, message, err) {
  console.error(JSON.stringify({
    level: 'ERROR',
    event,
    message,
    error: err?.message || String(err),
    time: new Date().toISOString()
  }));
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ======================================================
// MONGODB CONNECTION
// ======================================================

async function connectMongoDB() {
  if (!MONGODB_URI) {
    throw new Error('MONGODB_URI is missing in environment variables.');
  }

  await mongoClient.connect();

  const db = mongoClient.db(MONGODB_DB_NAME);

  authCollection = db.collection('whatsapp_auth');

  mongoConnected = true;

  logInfo(
    'MONGODB_CONNECTED',
    'MongoDB connected successfully.'
  );
}

// ======================================================
// MONGODB WHATSAPP AUTHENTICATION
// ======================================================

function deserializeAuthValue(value) {
  if (value === null || value === undefined) {
    return value;
  }

  if (typeof value === 'string') {
    return JSON.parse(value, BufferJSON.reviver);
  }

  return JSON.parse(
    JSON.stringify(value),
    BufferJSON.reviver
  );
}

async function useMongoDBAuthState() {
  if (!authCollection) {
    throw new Error('MongoDB authentication collection is unavailable.');
  }

  const credsId = `${WHATSAPP_AUTH_ID}:creds`;

  const credsDocument = await authCollection.findOne({
    _id: credsId
  });

  let creds;

  if (credsDocument) {
    const storedCreds =
      credsDocument.data ?? credsDocument.creds;

    creds = deserializeAuthValue(storedCreds);
  } else {
    creds = initAuthCreds();
  }

  // Save WhatsApp credentials.

  const saveCreds = async () => {
    await authCollection.updateOne(
      { _id: credsId },
      {
        $set: {
          data: JSON.stringify(
            creds,
            BufferJSON.replacer
          ),
          updatedAt: new Date()
        }
      },
      { upsert: true }
    );
  };

  // Save and retrieve encryption keys.

  const keys = {
    get: async (type, ids) => {
      const result = {};

      if (!ids || ids.length === 0) {
        return result;
      }

      const prefix = `${WHATSAPP_AUTH_ID}:${type}:`;

      const documentIds = ids.map(
        id => `${prefix}${id}`
      );

      const documents = await authCollection
        .find({
          _id: { $in: documentIds }
        })
        .toArray();

      for (const document of documents) {
        const id = document._id.substring(prefix.length);

        const storedValue =
          document.data ?? document.value;

        if (storedValue === undefined) {
          continue;
        }

        let value = deserializeAuthValue(storedValue);

        if (type === 'app-state-sync-key') {
          value =
            proto.Message.AppStateSyncKeyData.fromObject(value);
        }

        result[id] = value;
      }

      return result;
    },

    set: async data => {
      const operations = [];

      for (const [category, entries] of Object.entries(data)) {
        if (!entries) continue;

        for (const [id, value] of Object.entries(entries)) {
          const documentId =
            `${WHATSAPP_AUTH_ID}:${category}:${id}`;

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
                    data: JSON.stringify(
                      value,
                      BufferJSON.replacer
                    ),
                    updatedAt: new Date()
                  }
                },
                upsert: true
              }
            });
          }
        }
      }

      if (operations.length > 0) {
        await authCollection.bulkWrite(
          operations,
          { ordered: false }
        );
      }
    }
  };

  return {
    state: {
      creds,
      keys
    },
    saveCreds
  };
}

// ======================================================
// GEMINI AI
// ======================================================

async function callGemini(model, prompt) {
  if (!GEMINI_API_KEY) {
    throw new Error('GEMINI_API_KEY is missing.');
  }

  const endpoint =
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`;

  const controller = new AbortController();

  const timeout = setTimeout(
    () => controller.abort(),
    GEMINI_TIMEOUT_MS
  );

  try {
    const response = await fetch(endpoint, {
      method: 'POST',

      headers: {
        'Content-Type': 'application/json'
      },

      signal: controller.signal,

      body: JSON.stringify({
        systemInstruction: {
          parts: [
            {
              text: BOT_SYSTEM_PROMPT
            }
          ]
        },

        contents: [
          {
            role: 'user',
            parts: [
              {
                text: prompt
              }
            ]
          }
        ],

        generationConfig: {
          maxOutputTokens: GEMINI_MAX_OUTPUT_TOKENS
        }
      })
    });

    const responseText = await response.text();

    let data;

    try {
      data = JSON.parse(responseText);
    } catch {
      throw new Error(
        `Gemini returned an invalid response. HTTP ${response.status}`
      );
    }

    if (!response.ok) {
      throw new Error(
        `Gemini HTTP ${response.status}: ${
          data?.error?.message || responseText
        }`
      );
    }

    const answer = data?.candidates?.[0]?.content?.parts
      ?.map(part => part.text || '')
      .join('')
      .trim();

    if (!answer) {
      throw new Error(
        `Gemini model ${model} returned an empty response.`
      );
    }

    return answer;

  } finally {
    clearTimeout(timeout);
  }
}

async function askGemini(prompt) {
  const models = [
    GEMINI_MODEL,
    GEMINI_FALLBACK_MODEL
  ].filter(
    (model, index, array) =>
      model && array.indexOf(model) === index
  );

  let lastError;

  for (const model of models) {
    try {
      logInfo(
        'GEMINI_REQUEST',
        `Sending request to ${model}.`
      );

      const answer = await callGemini(model, prompt);

      logInfo(
        'GEMINI_SUCCESS',
        `Gemini responded using ${model}.`
      );

      return answer;

    } catch (err) {
      lastError = err;

      logError(
        'GEMINI_MODEL_FAILED',
        `Model ${model} failed.`,
        err
      );
    }
  }

  throw lastError || new Error('All Gemini models failed.');
}

// ======================================================
// WHATSAPP MESSAGE HANDLING
// ======================================================

function extractMessageText(message) {
  if (!message) return '';

  let content = message;

  // Unwrap common WhatsApp message wrappers.

  for (let i = 0; i < 5; i++) {
    if (content.ephemeralMessage?.message) {
      content = content.ephemeralMessage.message;
    } else if (content.viewOnceMessage?.message) {
      content = content.viewOnceMessage.message;
    } else if (content.viewOnceMessageV2?.message) {
      content = content.viewOnceMessageV2.message;
    } else {
      break;
    }
  }

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

async function handleIncomingMessage(socket, message) {
  try {
    if (!message || !message.message) return;

    if (message.key?.fromMe) return;

    const jid = message.key?.remoteJid;

    if (!jid || jid === 'status@broadcast') {
      return;
    }

    if (
      message.key?.id &&
      seenMessages.has(message.key.id)
    ) {
      return;
    }

    if (message.key?.id) {
      seenMessages.set(message.key.id, true);
    }

    const incomingText = extractMessageText(message.message);

    if (!incomingText) {
      return;
    }

    logInfo(
      'WHATSAPP_MESSAGE',
      'Incoming WhatsApp message received.',
      {
        sender: jid,
        messageLength: incomingText.length
      }
    );

    const reply = await askGemini(incomingText);

    if (!reply) return;

    // Do not send from an outdated socket.

    if (socket !== whatsappSocket || !whatsappConnected) {
      return;
    }

    await socket.sendMessage(
      jid,
      { text: reply },
      { quoted: message }
    );

    logInfo(
      'WHATSAPP_REPLY_SENT',
      'AI reply sent successfully.',
      { recipient: jid }
    );

  } catch (err) {
    logError(
      'WHATSAPP_MESSAGE_ERROR',
      'Could not process incoming message.',
      err
    );
  }
}

// ======================================================
// START WHATSAPP
// ======================================================

async function startWhatsApp() {
  if (startingWhatsApp) {
    return;
  }

  if (!authCollection) {
    logWarn(
      'WHATSAPP_START',
      'Waiting for MongoDB authentication storage.'
    );

    return;
  }

  startingWhatsApp = true;

  try {
    logInfo(
      'WHATSAPP_START',
      'Starting WhatsApp socket.'
    );

    whatsappState = 'connecting';

    const {
      state,
      saveCreds
    } = await useMongoDBAuthState();

    const socket = makeWASocket({
      auth: state,

      logger,

      printQRInTerminal: false,

      browser: [
        'Manny AI WhatsApp Bot',
        'Chrome',
        '120.0.0'
      ],

      markOnlineOnConnect: false,

      syncFullHistory: false,

      connectTimeoutMs: 60000,

      defaultQueryTimeoutMs: 60000,

      keepAliveIntervalMs: 25000
    });

    whatsappSocket = socket;

    // Save credentials whenever Baileys updates them.

    socket.ev.on('creds.update', async () => {
      try {
        await saveCreds();
      } catch (err) {
        logError(
          'AUTH_SAVE_ERROR',
          'Could not save WhatsApp credentials.',
          err
        );
      }
    });

    // WhatsApp connection updates.

    socket.ev.on(
      'connection.update',
      async update => {
        if (socket !== whatsappSocket) {
          return;
        }

        const {
          connection,
          lastDisconnect,
          qr
        } = update;

        if (qr) {
          qrCodeData = qr;

          whatsappConnected = false;

          whatsappState = 'waiting_for_scan';

          logInfo(
            'WHATSAPP_QR',
            'New WhatsApp QR code generated.'
          );
        }

        if (connection === 'connecting') {
          whatsappState = 'connecting';

          logInfo(
            'WHATSAPP_CONNECTING',
            'Connecting to WhatsApp.'
          );
        }

        if (connection === 'open') {
          whatsappConnected = true;

          whatsappState = 'connected';

          qrCodeData = null;

          logInfo(
            'WHATSAPP_CONNECTED',
            'WhatsApp connected successfully.'
          );
        }

        if (connection === 'close') {
          whatsappConnected = false;

          whatsappState = 'disconnected';

          qrCodeData = null;

          const statusCode =
            lastDisconnect?.error?.output?.statusCode;

          logWarn(
            'WHATSAPP_CLOSED',
            'WhatsApp connection closed.',
            { statusCode }
          );

          // ============================================
          // FIX FOR 401 LOGOUT / INVALID AUTH SESSION
          // ============================================

          if (
            statusCode === DisconnectReason.loggedOut
          ) {
            if (resettingAuth) {
              return;
            }

            resettingAuth = true;

            whatsappSocket = null;

            try {
              logWarn(
                'WHATSAPP_LOGOUT',
                'Invalid WhatsApp session detected. Resetting authentication.'
              );

              const escapedPrefix = escapeRegex(
                `${WHATSAPP_AUTH_ID}:`
              );

              // Delete only this bot's saved credentials.

              const result = await authCollection.deleteMany({
                _id: {
                  $regex: `^${escapedPrefix}`
                }
              });

              logInfo(
                'WHATSAPP_AUTH_RESET',
                'Old WhatsApp credentials cleared.',
                {
                  deletedCount: result.deletedCount
                }
              );

              await sleep(2000);

              // Start a fresh WhatsApp session.

              await startWhatsApp();

            } catch (err) {
              logError(
                'WHATSAPP_AUTH_RESET_ERROR',
                'Could not reset WhatsApp authentication.',
                err
              );

            } finally {
              resettingAuth = false;
            }

            return;
          }

          // ============================================
          // AUTOMATIC RECONNECTION
          // ============================================

          whatsappSocket = null;

          if (!reconnectTimer) {
            reconnectTimer = setTimeout(async () => {
              reconnectTimer = null;

              if (!whatsappSocket && !startingWhatsApp) {
                logInfo(
                  'WHATSAPP_RECONNECT',
                  'Attempting WhatsApp reconnection.'
                );

                await startWhatsApp();
              }

            }, 5000);
          }
        }
      }
    );

    // Listen for incoming WhatsApp messages.

    socket.ev.on(
      'messages.upsert',
      async ({ messages, type }) => {
        if (type !== 'notify') {
          return;
        }

        for (const message of messages) {
          await handleIncomingMessage(
            socket,
            message
          );
        }
      }
    );

    logInfo(
      'WHATSAPP_SOCKET_CREATED',
      'WhatsApp socket created successfully.'
    );

  } catch (err) {
    whatsappSocket = null;

    whatsappConnected = false;

    whatsappState = 'error';

    logError(
      'WHATSAPP_START_ERROR',
      'Could not start WhatsApp.',
      err
    );

  } finally {
    startingWhatsApp = false;
  }
}

// ======================================================
// HOMEPAGE
// ======================================================

app.get('/', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">

<title>Manny AI WhatsApp Bot</title>

<style>
* {
  box-sizing: border-box;
}

body {
  margin: 0;
  padding: 20px;
  background: #0b141a;
  color: white;
  font-family: Arial, sans-serif;
}

.container {
  max-width: 520px;
  margin: 35px auto;
}

.card {
  background: #17252d;
  padding: 24px;
  border-radius: 16px;
  margin-bottom: 18px;
  border: 1px solid #29404b;
}

h1 {
  text-align: center;
  color: #25d366;
  margin-bottom: 8px;
}

.subtitle {
  text-align: center;
  color: #b6c5cc;
  margin-bottom: 25px;
}

.status {
  display: flex;
  justify-content: space-between;
  padding: 12px 0;
  border-bottom: 1px solid #30434d;
}

.status:last-child {
  border-bottom: none;
}

.status span:last-child {
  color: #25d366;
  font-weight: bold;
}

input {
  width: 100%;
  padding: 14px;
  margin: 10px 0;
  border: 1px solid #3d5662;
  border-radius: 9px;
  background: #0b141a;
  color: white;
  font-size: 16px;
}

button {
  width: 100%;
  padding: 14px;
  border: none;
  border-radius: 9px;
  background: #25d366;
  color: #062b17;
  font-weight: bold;
  font-size: 16px;
  cursor: pointer;
  margin-top: 10px;
}

button:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.code {
  font-size: 28px;
  letter-spacing: 5px;
  text-align: center;
  color: #25d366;
  font-weight: bold;
  padding: 18px;
  background: #0b141a;
  border-radius: 10px;
  margin-top: 15px;
}

#qrImage {
  width: 100%;
  max-width: 280px;
  display: none;
  margin: 20px auto;
  background: white;
  padding: 10px;
  border-radius: 12px;
}

.message {
  color: #b6c5cc;
  font-size: 14px;
  line-height: 1.6;
}

#result {
  margin-top: 15px;
  text-align: center;
  overflow-wrap: anywhere;
}

footer {
  text-align: center;
  color: #82939c;
  font-size: 12px;
  padding: 20px;
}
</style>
</head>

<body>

<div class="container">

  <h1>Manny AI WhatsApp Bot</h1>

  <p class="subtitle">
    Connect your WhatsApp account and activate your AI assistant.
  </p>

  <div class="card">

    <h3>Connection Status</h3>

    <div class="status">
      <span>WhatsApp</span>
      <span id="waStatus">Checking...</span>
    </div>

    <div class="status">
      <span>MongoDB</span>
      <span id="mongoStatus">Checking...</span>
    </div>

    <div class="status">
      <span>Gemini AI</span>
      <span id="geminiStatus">Checking...</span>
    </div>

  </div>

  <div class="card">

    <h3>Connect with Phone Number</h3>

    <p class="message">
      Enter the WhatsApp number you want to link, including
      the country code. Example: 2547XXXXXXXX.
      Do not include the plus sign.
    </p>

    <input
      type="tel"
      id="phone"
      placeholder="2547XXXXXXXX"
      autocomplete="tel"
    >

    <button id="pairButton" onclick="requestPairing()">
      Generate Pairing Code
    </button>

    <div id="result"></div>

  </div>

  <div class="card">

    <h3>Connect Using QR Code</h3>

    <p class="message">
      Open WhatsApp, go to Linked Devices, choose Link a Device,
      then scan the QR code below.
    </p>

    <img id="qrImage" alt="WhatsApp QR Code">

    <p class="message" id="qrMessage">
      Waiting for QR code...
    </p>

  </div>

  <footer>
    Manny AI WhatsApp Bot
  </footer>

</div>

<script>

async function refreshStatus() {
  try {
    const response = await fetch('/status');

    const data = await response.json();

    document.getElementById('waStatus').textContent =
      data.whatsappConnected
        ? 'Connected'
        : data.whatsappState;

    document.getElementById('mongoStatus').textContent =
      data.mongoConnected ? 'Connected' : 'Disconnected';

    document.getElementById('geminiStatus').textContent =
      data.geminiConfigured ? 'Configured' : 'Missing API Key';

    const qrImage = document.getElementById('qrImage');

    const qrMessage = document.getElementById('qrMessage');

    if (data.qrReady && !data.whatsappConnected) {
      qrImage.src = '/qr?t=' + Date.now();

      qrImage.style.display = 'block';

      qrMessage.textContent = 'Scan this QR code using WhatsApp.';
    } else {
      qrImage.style.display = 'none';

      qrMessage.textContent = data.whatsappConnected
        ? 'WhatsApp is already connected.'
        : 'Waiting for QR code...';
    }

  } catch (error) {
    console.error(error);
  }
}

async function requestPairing() {
  const phone = document.getElementById('phone').value.trim();

  const result = document.getElementById('result');

  const button = document.getElementById('pairButton');

  if (!phone) {
    result.textContent = 'Enter your WhatsApp number first.';
    return;
  }

  button.disabled = true;

  button.textContent = 'Generating code...';

  result.textContent = 'Please wait...';

  try {
    const response = await fetch('/request-pairing', {
      method: 'POST',

      headers: {
        'Content-Type': 'application/json'
      },

      body: JSON.stringify({
        phone: phone
      })
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || 'Pairing failed.');
    }

    result.innerHTML = '';

    const heading = document.createElement('p');
    heading.textContent = 'Your WhatsApp pairing code:';

    const code = document.createElement('div');
    code.className = 'code';
    code.textContent = data.code;

    const copyButton = document.createElement('button');
    copyButton.textContent = 'Copy Pairing Code';

    copyButton.onclick = async function() {
      await navigator.clipboard.writeText(data.code);
      copyButton.textContent = 'Copied!';
    };

    result.appendChild(heading);
    result.appendChild(code);
    result.appendChild(copyButton);

  } catch (error) {
    result.textContent = error.message;

  } finally {
    button.disabled = false;
    button.textContent = 'Generate Pairing Code';
  }
}

refreshStatus();

setInterval(refreshStatus, 5000);

</script>

</body>
</html>`);
});

// ======================================================
// HEALTH CHECK
// ======================================================

app.get('/health', (req, res) => {
  res.json({
    success: true,
    service: 'Manny AI WhatsApp Bot',
    whatsappConnected,
    mongoConnected,
    geminiConfigured: Boolean(GEMINI_API_KEY),
    uptime: process.uptime()
  });
});

// ======================================================
// STATUS
// ======================================================

app.get('/status', (req, res) => {
  res.json({
    success: true,

    whatsappConnected,

    whatsappState,

    qrReady: Boolean(qrCodeData),

    pairingInProgress,

    mongoConnected,

    geminiConfigured: Boolean(GEMINI_API_KEY),

    geminiModel: GEMINI_MODEL,

    geminiFallbackModel: GEMINI_FALLBACK_MODEL,

    uptime: process.uptime()
  });
});

// ======================================================
// QR CODE
// ======================================================

app.get('/qr', async (req, res) => {
  try {
    if (!qrCodeData) {
      return res.status(404).send(
        'QR code is not available. Wait for a new QR code.'
      );
    }

    const image = await QRCode.toBuffer(qrCodeData, {
      type: 'png',
      width: 300,
      margin: 2
    });

    res.setHeader('Content-Type', 'image/png');

    res.setHeader('Cache-Control', 'no-store');

    res.send(image);

  } catch (err) {
    logError(
      'QR_ERROR',
      'Could not generate QR image.',
      err
    );

    res.status(500).send('Could not generate QR code.');
  }
});

// ======================================================
// PHONE NUMBER PAIRING
// ======================================================

function normalizePhone(phone) {
  return String(phone || '')
    .replace(/\D/g, '');
}

app.post('/request-pairing', async (req, res) => {
  if (pairingInProgress) {
    return res.status(409).json({
      success: false,
      error: 'A pairing request is already in progress.'
    });
  }

  const phone = normalizePhone(
    req.body?.phone || req.body?.number
  );

  if (!/^\d{8,15}$/.test(phone)) {
    return res.status(400).json({
      success: false,
      error: 'Enter a valid phone number with country code. Example: 2547XXXXXXXX.'
    });
  }

  if (whatsappConnected) {
    return res.status(409).json({
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

  try {
    const socket = whatsappSocket;

    // Allow the socket time to initialize.

    await sleep(3000);

    if (!socket || whatsappSocket !== socket) {
      throw new Error(
        'WhatsApp connection restarted. Please try again.'
      );
    }

    if (whatsappConnected) {
      throw new Error(
        'WhatsApp is already connected.'
      );
    }

    logInfo(
      'PAIRING_REQUEST',
      'Generating WhatsApp pairing code.'
    );

    const code = await socket.requestPairingCode(phone);

    logInfo(
      'PAIRING_CODE_GENERATED',
      'WhatsApp pairing code generated successfully.'
    );

    res.json({
      success: true,
      phone,
      code
    });

  } catch (err) {
    logError(
      'PAIRING_ERROR',
      'Could not generate pairing code.',
      err
    );

    res.status(500).json({
      success: false,
      error: err.message || 'Pairing failed.'
    });

  } finally {
    pairingInProgress = false;
  }
});

// ======================================================
// SEND WHATSAPP MESSAGE
// ======================================================

function normalizeJid(value) {
  const raw = String(value || '').trim();

  if (raw.includes('@')) {
    if (!/^\d{5,20}@(s\.whatsapp\.net|g\.us)$/.test(raw)) {
      throw new Error('Invalid WhatsApp recipient JID.');
    }

    return raw;
  }

  const phone = normalizePhone(raw);

  if (!/^\d{8,15}$/.test(phone)) {
    throw new Error('Invalid recipient phone number.');
  }

  return `${phone}@s.whatsapp.net`;
}

app.post('/send', async (req, res) => {
  try {
    if (!whatsappConnected || !whatsappSocket) {
      return res.status(503).json({
        success: false,
        error: 'WhatsApp is not connected.'
      });
    }

    const recipient = normalizeJid(
      req.body?.to ||
      req.body?.phone ||
      req.body?.number
    );

    const message = String(
      req.body?.message || ''
    ).trim();

    if (!message) {
      return res.status(400).json({
        success: false,
        error: 'Message cannot be empty.'
      });
    }

    await whatsappSocket.sendMessage(
      recipient,
      { text: message }
    );

    logInfo(
      'MESSAGE_SENT',
      'WhatsApp message sent successfully.',
      { recipient }
    );

    res.json({
      success: true,
      message: 'Message sent successfully.'
    });

  } catch (err) {
    logError(
      'SEND_ERROR',
      'Could not send WhatsApp message.',
      err
    );

    res.status(500).json({
      success: false,
      error: err.message || 'Could not send message.'
    });
  }
});

// ======================================================
// START SERVER
// ======================================================

app.listen(PORT, '0.0.0.0', () => {
  logInfo(
    'SERVER_STARTED',
    `Server running on port ${PORT}.`
  );

  logInfo(
    'GEMINI_CONFIGURATION',
    'Gemini configuration loaded.',
    {
      apiKeyPresent: Boolean(GEMINI_API_KEY),
      primaryModel: GEMINI_MODEL,
      fallbackModel: GEMINI_FALLBACK_MODEL
    }
  );

  // Connect MongoDB and then start WhatsApp.

  connectMongoDB()
    .then(async () => {
      await startWhatsApp();
    })
    .catch(err => {
      mongoConnected = false;

      logError(
        'STARTUP_ERROR',
        'Could not initialize MongoDB or WhatsApp.',
        err
      );
    });
});

// ======================================================
// PROCESS ERROR HANDLING
// ======================================================

process.on('unhandledRejection', reason => {
  logError(
    'UNHANDLED_REJECTION',
    'Unhandled promise rejection.',
    reason
  );
});

process.on('uncaughtException', err => {
  logError(
    'UNCAUGHT_EXCEPTION',
    'Uncaught application exception.',
    err
  );
});
