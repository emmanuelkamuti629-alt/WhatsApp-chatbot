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
  port: process.env.PORT || 3000,

  botName: process.env.BOT_NAME || 'Smart Assistant',

  geminiKey: process.env.GEMINI_API_KEY,

  // Primary Gemini model
  geminiModel: process.env.GEMINI_MODEL || 'gemini-2.5-flash',

  // Backup Gemini model
  geminiFallbackModel:
    process.env.GEMINI_FALLBACK_MODEL || 'gemini-2.5-flash-lite',

  geminiTimeoutMs: Number(
    process.env.GEMINI_TIMEOUT_MS || 60000
  ),

  geminiMaxTokens: Number(
    process.env.GEMINI_MAX_OUTPUT_TOKENS || 4096
  ),

  geminiTemperature: Number(
    process.env.GEMINI_TEMPERATURE || 0.7
  ),

  // Three attempts per model
  geminiMaxRetries: Number(
    process.env.GEMINI_MAX_RETRIES || 3
  ),

  mongodbUri: process.env.MONGODB_URI,

  mongodbDatabase:
    process.env.MONGODB_DB_NAME || 'whatsapp_bot',

  authId: process.env.WHATSAPP_AUTH_ID || 'main',

  systemPrompt:
    process.env.SYSTEM_PROMPT ||
    'You are a helpful WhatsApp AI assistant. Give clear, friendly and accurate answers.'
};

// ======================================================
// LOGGER
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
    error: err?.message,
    name: err?.name,
    code: err?.code,
    status: err?.status,
    stack: err?.stack
  }, message);
}

// ======================================================
// GLOBAL VARIABLES
// ======================================================

const app = express();

app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));

const messageCache = new NodeCache({
  stdTTL: 3600,
  checkperiod: 600
});

let mongoClient;
let db;
let authCollection;

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
// HELPER FUNCTIONS
// ======================================================

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

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

// ======================================================
// MONGODB CONNECTION
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

// ======================================================
// WHATSAPP MONGODB AUTHENTICATION
// ======================================================

async function useMongoAuthState() {
  info('AUTH', 'Loading WhatsApp credentials from MongoDB.');

  const credsId = `${config.authId}:creds`;

  const credsDocument = await authCollection.findOne({
    _id: credsId
  });

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

    success(
      'WHATSAPP_AUTH_SAVE',
      'WhatsApp credentials saved to MongoDB.'
    );
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

    set: async (data) => {
      const operations = [];

      for (const [type, entries] of Object.entries(data)) {
        for (const [id, value] of Object.entries(entries)) {
          const documentId =
            `${config.authId}:key:${type}:${id}`;

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
    state: {
      creds,
      keys
    },
    saveCreds
  };
}

// ======================================================
// GEMINI API REQUEST WITH AUTOMATIC RETRIES
// ======================================================

async function requestGeminiModel(model, contents) {
  const endpoint =
    `https://generativelanguage.googleapis.com/v1beta/models/` +
    `${encodeURIComponent(model)}:generateContent`;

  let lastError;

  for (
    let attempt = 1;
    attempt <= config.geminiMaxRetries;
    attempt++
  ) {
    const controller = new AbortController();

    const timeout = setTimeout(() => {
      controller.abort();
    }, config.geminiTimeoutMs);

    const startedAt = Date.now();

    try {
      info('GEMINI_REQUEST', 'Sending Gemini request.', {
        model,
        attempt,
        maxAttempts: config.geminiMaxRetries
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
        throw new Error(
          `Invalid Gemini response. HTTP ${response.status}: ` +
          responseText.substring(0, 400)
        );
      }

      if (!response.ok) {
        const apiMessage =
          result?.error?.message ||
          responseText.substring(0, 400);

        const apiError = new Error(
          `Gemini API HTTP ${response.status}: ${apiMessage}`
        );

        apiError.status = response.status;

        apiError.retryable =
          isRetryableStatus(response.status);

        throw apiError;
      }

      const candidate = result?.candidates?.[0];

      const answer = candidate?.content?.parts
        ?.map(part => part.text || '')
        .join('')
        .trim();

      if (!answer) {
        const finishReason = candidate?.finishReason;

        throw new Error(
          `Gemini returned no text. Finish reason: ${finishReason || 'UNKNOWN'}`
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
        lastError.retryable === undefined &&
        (
          lastError.name === 'TypeError' ||
          lastError.name === 'TimeoutError'
        );

      error(
        'GEMINI_REQUEST',
        'Gemini request failed.',
        lastError
      );

      if (!retryable || attempt === config.geminiMaxRetries) {
        throw lastError;
      }

      const delay = Math.min(
        1000 * Math.pow(2, attempt - 1),
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

// ======================================================
// GEMINI API WITH AUTOMATIC MODEL FALLBACK
// ======================================================

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

  const models = getGeminiModels();

  let lastError;

  for (let index = 0; index < models.length; index++) {
    const model = models[index];

    try {
      info('GEMINI_MODEL', 'Trying Gemini model.', {
        model,
        fallback: index > 0
      });

      const answer = await requestGeminiModel(
        model,
        contents
      );

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

// ======================================================
// GEMINI CONNECTION TEST
// ======================================================

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

    error(
      'GEMINI_TEST',
      'Gemini verification failed.',
      err
    );

    return false;
  }
}

// ======================================================
// WHATSAPP MESSAGE TEXT EXTRACTION
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

// ======================================================
// AI REPLY GENERATION
// ======================================================

async function generateReply(chatId, userMessage) {
  const history = messageCache.get(chatId) || [];

  const reply = await askGemini(
    userMessage,
    history
  );

  const updatedHistory = [
    ...history,

    {
      role: 'user',
      text: userMessage
    },

    {
      role: 'model',
      text: reply
    }
  ];

  // Keep the last 20 messages.
  messageCache.set(
    chatId,
    updatedHistory.slice(-20)
  );

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

    const { state, saveCreds } =
      await useMongoAuthState();

    info('WHATSAPP_SOCKET', 'Creating WhatsApp socket.');

    const socket = makeWASocket({
      auth: state,

      logger: pino({ level: 'silent' }),

      printQRInTerminal: false,

      browser: [
        config.botName,
        'Chrome',
        '1.0.0'
      ],

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

    socket.ev.on('connection.update', async (update) => {
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
          if (!message.message) continue;

          if (message.key.fromMe) continue;

          const chatId = message.key.remoteJid;

          if (!chatId) continue;

          if (
            chatId === 'status@broadcast' ||
            chatId.endsWith('@g.us') ||
            chatId.endsWith('@newsletter')
          ) {
            continue;
          }

          const text = extractMessageText(message.message);

          if (!text) continue;

          info(
            'WHATSAPP_INCOMING',
            'New message received.',
            {
              chatId,
              messageLength: text.length
            }
          );

          if (!whatsappConnected) {
            warn(
              'WHATSAPP_MESSAGE',
              'Message received while WhatsApp is disconnected.'
            );

            continue;
          }

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
// HTTP ROUTES
// ======================================================

app.get('/', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
      <head>
        <title>${config.botName}</title>
        <meta name="viewport" content="width=device-width, initial-scale=1">
      </head>

      <body style="font-family:Arial;text-align:center;padding:30px">

        <h2>${config.botName}</h2>

        <p>WhatsApp AI Assistant</p>

        <p>WhatsApp: ${whatsappConnected ? 'ONLINE' : 'OFFLINE'}</p>

        <p>Gemini: ${geminiStatus}</p>

        <p>Active model: ${activeGeminiModel || 'Not selected'}</p>

        <p><a href="/health">Health check</a></p>

        <p><a href="/status">Bot status</a></p>

        <p><a href="/qr">Link Device (QR & Phone)</a></p>

        <p><a href="/reset-auth" style="color: red;">Reset WhatsApp Session</a></p>

      </body>
    </html>
  `);
});

// ======================================================
// HEALTH CHECK
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

// ======================================================
// BOT STATUS
// ======================================================

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
// WHATSAPP QR CODE & PHONE PAIRING
// ======================================================

app.get('/qr', async (req, res) => {
  try {
    // If already connected, show a success message
    if (whatsappConnected) {
      return res.send(`
        <!DOCTYPE html>
        <html>
          <head>
            <meta name="viewport" content="width=device-width, initial-scale=1">
            <title>WhatsApp Connected</title>
          </head>
          <body style="text-align:center;font-family:Arial;padding:20px">
            <h2>WhatsApp is already connected.</h2>
            <p>You can close this page.</p>
            <a href="/">Go to Dashboard</a>
          </body>
        </html>
      `);
    }

    // Generate QR image if available
    let qrImageHtml = '';
    if (currentQR) {
      const image = await QRCode.toDataURL(currentQR);
      qrImageHtml = `
        <h2 style="margin-top: 0;">Scan with WhatsApp</h2>
        <img src="${image}" style="width:300px;max-width:90%; border: 1px solid #ddd; padding: 10px; border-radius: 8px;">
        <p style="color: #666; font-size: 14px;">Open WhatsApp → Linked devices → Link a device.</p>
        <p style="color: #666; font-size: 14px;">Refresh this page if the QR code expires.</p>
      `;
    } else {
      qrImageHtml = `
        <h2 style="margin-top: 0; color: #ff9800;">Waiting for QR Code...</h2>
        <p style="color: #666;">The QR code is not available yet. Please wait a few seconds and refresh.</p>
      `;
    }

    res.send(`
      <!DOCTYPE html>
      <html>
        <head>
          <meta name="viewport" content="width=device-width, initial-scale=1">
          <title>Link WhatsApp Device</title>
          <style>
            body {
              font-family: Arial, sans-serif;
              text-align: center;
              padding: 20px;
              background-color: #f9f9f9;
              color: #333;
            }
            .container {
              max-width: 500px;
              margin: 0 auto;
              background: white;
              padding: 30px;
              border-radius: 10px;
              box-shadow: 0 4px 6px rgba(0,0,0,0.1);
            }
            .divider {
              display: flex;
              align-items: center;
              text-align: center;
              margin: 30px 0;
              color: #999;
            }
            .divider::before, .divider::after {
              content: '';
              flex: 1;
              border-bottom: 1px solid #ddd;
            }
            .divider:not(:empty)::before {
              margin-right: .25em;
            }
            .divider:not(:empty)::after {
              margin-left: .25em;
            }
            input[type="tel"] {
              width: 100%;
              padding: 12px;
              margin: 10px 0;
              border: 1px solid #ccc;
              border-radius: 5px;
              box-sizing: border-box;
              font-size: 16px;
            }
            button {
              width: 100%;
              padding: 12px;
              background-color: #25D366;
              color: white;
              border: none;
              border-radius: 5px;
              font-size: 16px;
              cursor: pointer;
              font-weight: bold;
              margin-top: 10px;
            }
            button:hover {
              background-color: #1DA851;
            }
            button:disabled {
              background-color: #ccc;
              cursor: not-allowed;
            }
            #pairing-result {
              margin-top: 20px;
              font-weight: bold;
              font-size: 18px;
              word-break: break-all;
            }
            .error { color: #d9534f; }
            .success { color: #5cb85c; }
          </style>
        </head>
        <body>
          <div class="container">
            
            ${qrImageHtml}

            <div class="divider">OR</div>

            <h3>Link with Phone Number</h3>
            <form id="pairingForm">
              <input 
                type="tel" 
                id="phoneInput" 
                placeholder="Enter phone number (e.g., 1234567890)" 
                required 
              />
              <button type="submit" id="pairBtn">Get Pairing Code</button>
            </form>

            <div id="pairing-result"></div>

          </div>

          <script>
            document.getElementById('pairingForm').addEventListener('submit', async (e) => {
              e.preventDefault();
              
              const phoneInput = document.getElementById('phoneInput').value;
              const btn = document.getElementById('pairBtn');
              const resultDiv = document.getElementById('pairing-result');
              
              // Clean phone number (remove non-digits)
              const phone = phoneInput.replace(/\\D/g, '');
              
              if (phone.length < 10) {
                resultDiv.innerHTML = '<span class="error">Please enter a valid phone number including country code.</span>';
                return;
              }

              // Update UI
              btn.disabled = true;
              btn.innerText = 'Requesting...';
              resultDiv.innerHTML = '<span style="color: #666;">Please wait...</span>';

              try {
                const response = await fetch('/request-pairing', {
                  method: 'POST',
                  headers: {
                    'Content-Type': 'application/json'
                  },
                  body: JSON.stringify({ phone })
                });

                const data = await response.json();

                if (data.success) {
                  resultDiv.innerHTML = \`
                    <p class="success">Your Pairing Code:</p>
                    <h2 style="letter-spacing: 2px; font-size: 32px; margin: 10px 0;">\${data.pairingCode}</h2>
                    <p style="font-size: 14px; color: #666; font-weight: normal;">
                      Enter this code on your phone: <br>
                      WhatsApp → Linked Devices → Link with phone number.
                    </p>
                  \`;
                } else {
                  resultDiv.innerHTML = \`<span class="error">\${data.error}</span>\`;
                }
              } catch (err) {
                resultDiv.innerHTML = '<span class="error">Network error. Please try again.</span>';
              } finally {
                btn.disabled = false;
                btn.innerText = 'Get Pairing Code';
              }
            });
          </script>
        </body>
      </html>
    `);

  } catch (err) {
    error('QR_ROUTE', 'Could not generate QR code page.', err);
    res.status(500).send('Could not generate QR code page.');
  }
});

// ======================================================
// RESET WHATSAPP SESSION (NEW)
// ======================================================

app.get('/reset-auth', async (req, res) => {
  try {
    info('RESET_AUTH', 'User requested WhatsApp session reset.');

    if (!authCollection) {
      return res.status(500).send('Database not connected.');
    }

    // 1. Delete all credentials from MongoDB
    await authCollection.deleteMany({});
    
    // 2. Clear local memory and QR code
    currentQR = null;
    whatsappConnected = false;
    pairingInProgress = false;

    // 3. Force close the existing socket if it exists
    if (whatsappSocket) {
      try {
        whatsappSocket.end(undefined);
      } catch (e) {
        // Ignore errors when force-closing
      }
      whatsappSocket = null;
    }

    // 4. Clear any pending reconnect timers
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }

    success('RESET_AUTH', 'WhatsApp session cleared. Restarting connection.');

    // 5. Restart the WhatsApp connection to generate a fresh QR code
    setTimeout(() => {
      startWhatsApp().catch(err => {
        error('RESET_AUTH', 'Failed to restart WhatsApp after reset.', err);
      });
    }, 1000);

    res.send(`
      <!DOCTYPE html>
      <html>
        <head>
          <meta name="viewport" content="width=device-width, initial-scale=1">
          <title>Session Reset</title>
        </head>
        <body style="text-align:center;font-family:Arial;padding:20px">
          <h2>WhatsApp Session Reset Successful</h2>
          <p>The old credentials have been deleted. The bot is now generating a fresh QR code.</p>
          <p>Please wait 5-10 seconds, then go to the link page.</p>
          <a href="/qr" style="display:inline-block; margin-top:20px; padding:10px 20px; background:#25D366; color:white; text-decoration:none; border-radius:5px;">Go to QR / Pairing Page</a>
        </body>
      </html>
    `);

  } catch (err) {
    error('RESET_AUTH', 'Failed to reset WhatsApp session.', err);
    res.status(500).send('Failed to reset session: ' + err.message);
  }
});

// ======================================================
// WHATSAPP PAIRING CODE
// ======================================================

app.post('/request-pairing', async (req, res) => {
  try {
    const phone = String(req.body.phone || '')
      .replace(/\D/g, '');

    if (!phone || phone.length < 10 || phone.length > 15) {
      return res.status(400).json({
        success: false,
        error: 'Provide a valid phone number including country code.'
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
        error: 'WhatsApp socket is not ready. Try again shortly.'
      });
    }

    if (pairingInProgress) {
      return res.status(409).json({
        success: false,
        error: 'A pairing request is already in progress.'
      });
    }

    pairingInProgress = true;

    info(
      'WHATSAPP_PAIRING',
      'Requesting WhatsApp pairing code.'
    );

    const code = await whatsappSocket.requestPairingCode(phone);

    success(
      'WHATSAPP_PAIRING',
      'WhatsApp pairing code generated.'
    );

    res.json({
      success: true,
      pairingCode: code
    });

  } catch (err) {
    error(
      'WHATSAPP_PAIRING',
      'Could not generate pairing code.',
      err
    );

    res.status(500).json({
      success: false,
      error: err.message
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

    const message = String(req.body.message || '').trim();

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

    res.json({
      success: true,
      message: 'Message sent successfully.'
    });

  } catch (err) {
    error(
      'WHATSAPP_SEND',
      'Message sending failed.',
      err
    );

    res.status(500).json({
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
    success('HTTP_SERVER', 'Server running.', {
      port: config.port
    });
  });

  // Gemini verification runs independently.
  testGemini().catch(err => {
    error(
      'GEMINI_TEST',
      'Background Gemini test failed.',
      err
    );
  });

  // WhatsApp starts even if Gemini is unavailable.
  await startWhatsApp();

  success(
    'STARTUP',
    'Startup sequence completed.'
  );
}

// ======================================================
// GRACEFUL SHUTDOWN
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

    success('SHUTDOWN', 'Shutdown completed.');

  } catch (err) {
    error(
      'SHUTDOWN',
      'Shutdown error.',
      err
    );
  }

  process.exit(0);
}

// ======================================================
// PROCESS ERROR HANDLERS
// ======================================================

process.on('SIGTERM', () => shutdown('SIGTERM'));

process.on('SIGINT', () => shutdown('SIGINT'));

process.on('unhandledRejection', (reason) => {
  error(
    'UNHANDLED_REJECTION',
    'Unhandled promise rejection.',
    reason instanceof Error
      ? reason
      : new Error(String(reason))
  );
});

process.on('uncaughtException', (err) => {
  error(
    'UNCAUGHT_EXCEPTION',
    'Uncaught exception.',
    err
  );

  process.exit(1);
});

// ======================================================
// RUN
// ======================================================

startServer().catch(err => {
  error(
    'STARTUP_FATAL',
    'Bot startup failed.',
    err
  );

  process.exit(1);
});
