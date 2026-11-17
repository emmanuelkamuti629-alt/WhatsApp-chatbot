
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
  geminiModel: process.env.GEMINI_MODEL || 'gemini-2.5-flash',

  // Increased timeout: 120 seconds
  geminiTimeoutMs: Number(process.env.GEMINI_TIMEOUT_MS || 120000),

  geminiMaxTokens: Number(
    process.env.GEMINI_MAX_OUTPUT_TOKENS || 4096
  ),

  geminiTemperature: Number(
    process.env.GEMINI_TEMPERATURE || 0.7
  ),

  mongodbUri: process.env.MONGODB_URI,
  mongodbDatabase: process.env.MONGODB_DB_NAME || 'whatsapp_bot',

  authId: process.env.WHATSAPP_AUTH_ID || 'main',

  systemPrompt:
    process.env.SYSTEM_PROMPT ||
    'You are a helpful WhatsApp assistant. Give clear, friendly and accurate answers.'
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
    stack: err?.stack
  });
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

// ======================================================
// MONGODB AUTHENTICATION STORAGE
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

      const documents = await authCollection.find({
        _id: {
          $in: ids.map(
            id => `${config.authId}:key:${type}:${id}`
          )
        }
      }).toArray();

      for (const document of documents) {
        const prefix = `${config.authId}:key:${type}:`;
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
// GEMINI API
// ======================================================

async function askGemini(prompt, history = []) {
  if (!config.geminiKey) {
    throw new Error('GEMINI_API_KEY is missing.');
  }

  const endpoint =
    `https://generativelanguage.googleapis.com/v1beta/models/` +
    `${encodeURIComponent(config.geminiModel)}:generateContent`;

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

  const controller = new AbortController();

  const timeout = setTimeout(() => {
    controller.abort();
  }, config.geminiTimeoutMs);

  info('GEMINI_REQUEST', 'Sending request to Gemini.', {
    model: config.geminiModel,
    timeoutMs: config.geminiTimeoutMs,
    maxOutputTokens: config.geminiMaxTokens
  });

  const startedAt = Date.now();

  try {
    const response = await fetch(endpoint, {
      method: 'POST',

      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': config.geminiKey
      },

      body: JSON.stringify({
        systemInstruction: {
          parts: [{ text: config.systemPrompt }]
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
        `Gemini returned an invalid response. HTTP ${response.status}: ` +
        responseText.substring(0, 500)
      );
    }

    if (!response.ok) {
      const apiMessage =
        result?.error?.message ||
        responseText.substring(0, 500);

      throw new Error(
        `Gemini API HTTP ${response.status}: ${apiMessage}`
      );
    }

    const answer = result?.candidates?.[0]?.content?.parts
      ?.map(part => part.text || '')
      .join('')
      .trim();

    if (!answer) {
      throw new Error(
        'Gemini returned no text. Check the model response and finish reason.'
      );
    }

    geminiStatus = 'CONNECTED';
    geminiLastError = null;

    success('GEMINI_REQUEST', 'Gemini response received.', {
      durationMs: Date.now() - startedAt
    });

    return answer;

  } catch (err) {
    if (err.name === 'AbortError') {
      geminiStatus = 'TIMEOUT';

      throw new Error(
        `Gemini request timed out after ${config.geminiTimeoutMs}ms.`
      );
    }

    if (
      err.name === 'TimeoutError' ||
      err.code === 23
    ) {
      geminiStatus = 'TIMEOUT';
    } else {
      geminiStatus = 'ERROR';
    }

    geminiLastError = err.message;

    error('GEMINI_NETWORK', 'Gemini request failed.', err);

    throw err;

  } finally {
    clearTimeout(timeout);
  }
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
      response: response.substring(0, 150)
    });

    return true;

  } catch (err) {
    geminiLastError = err.message;

    error('GEMINI_TEST', 'Gemini verification failed.', err);

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

  const reply = await askGemini(userMessage, history);

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

  // Keep the most recent 20 conversation messages.
  messageCache.set(chatId, updatedHistory.slice(-20));

  return reply;
}

// ======================================================
// WHATSAPP CONNECTION
// ======================================================

async function startWhatsApp() {
  if (startingWhatsApp) {
    warn('WHATSAPP_START', 'WhatsApp startup already in progress.');
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

        info('WHATSAPP_QR', 'New WhatsApp QR code generated.');
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

          if (chatId === 'status@broadcast') continue;

          const text = extractMessageText(message.message);

          if (!text) continue;

          info('WHATSAPP_INCOMING', 'New message received.', {
            chatId,
            messageLength: text.length
          });

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
    error('WHATSAPP_START', 'WhatsApp startup failed.', err);

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
        <p><a href="/health">Health check</a></p>
        <p><a href="/status">Bot status</a></p>
        <p><a href="/qr">WhatsApp QR code</a></p>
      </body>
    </html>
  `);
});

app.get('/health', (req, res) => {
  const ready =
    Boolean(db) &&
    whatsappConnected &&
    geminiStatus === 'CONNECTED';

  res.status(ready ? 200 : 503).json({
    success: ready,
    bot: config.botName,
    whatsapp: whatsappConnected ? 'CONNECTED' : 'DISCONNECTED',
    gemini: geminiStatus,
    mongodb: db ? 'CONNECTED' : 'DISCONNECTED',
    geminiError: geminiLastError
  });
});

app.get('/status', (req, res) => {
  res.json({
    bot: config.botName,
    whatsappConnected,
    geminiStatus,
    geminiModel: config.geminiModel,
    mongodbConnected: Boolean(db),
    pairingInProgress,
    qrAvailable: Boolean(currentQR)
  });
});

app.get('/qr', async (req, res) => {
  try {
    if (whatsappConnected) {
      return res.send('WhatsApp is already connected.');
    }

    if (!currentQR) {
      return res.status(404).send(
        'QR code is not available yet. Wait for WhatsApp to generate one.'
      );
    }

    const image = await QRCode.toDataURL(currentQR);

    res.send(`
      <html>
        <head>
          <meta name="viewport" content="width=device-width, initial-scale=1">
          <title>WhatsApp QR Code</title>
        </head>
        <body style="text-align:center;font-family:Arial">
          <h2>Scan with WhatsApp</h2>
          <img src="${image}" style="width:300px;max-width:90%">
          <p>Open WhatsApp → Linked devices → Link a device.</p>
          <p>Refresh this page if the QR code expires.</p>
        </body>
      </html>
    `);

  } catch (err) {
    error('QR_ROUTE', 'Could not generate QR code.', err);

    res.status(500).send('Could not generate QR code.');
  }
});

app.post('/request-pairing', async (req, res) => {
  try {
    const phone = String(req.body.phone || '')
      .replace(/\D/g, '');

    if (!phone || phone.length < 10) {
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

    info('WHATSAPP_PAIRING', 'Requesting WhatsApp pairing code.');

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

    success('WHATSAPP_SEND', 'Message sent successfully.', {
      jid
    });

    res.json({
      success: true,
      message: 'Message sent successfully.'
    });

  } catch (err) {
    error('WHATSAPP_SEND', 'Message sending failed.', err);

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
  info('CONFIG', `Gemini model: ${config.geminiModel}`);

  info('CONFIG', 'Gemini API key present: ' +
    Boolean(config.geminiKey));

  info('CONFIG', 'MongoDB URI present: ' +
    Boolean(config.mongodbUri));

  info('CONFIG', 'Gemini timeout: ' +
    `${config.geminiTimeoutMs}ms`);

  info('CONFIG', 'Gemini output allowance: ' +
    config.geminiMaxTokens);

  await connectMongoDB();

  app.listen(config.port, '0.0.0.0', () => {
    success('HTTP_SERVER', 'Server running.', {
      port: config.port
    });
  });

  // Gemini verification runs in the background.
  // A slow Gemini response will not prevent WhatsApp from starting.
  testGemini().catch(err => {
    error('GEMINI_TEST', 'Background Gemini test failed.', err);
  });

  // WhatsApp starts independently of the Gemini test.
  await startWhatsApp();

  success('STARTUP', 'Startup sequence completed.');
}

// ======================================================
// GRACEFUL SHUTDOWN
// ======================================================

async function shutdown(signal) {
  warn('SHUTDOWN', `Received ${signal}. Shutting down...`);

  try {
    if (whatsappSocket) {
      whatsappSocket.end(undefined);
    }

    if (mongoClient) {
      await mongoClient.close();
    }

    success('SHUTDOWN', 'Shutdown completed.');

  } catch (err) {
    error('SHUTDOWN', 'Shutdown error.', err);
  }

  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

process.on('unhandledRejection', (reason) => {
  error(
    'UNHANDLED_REJECTION',
    'Unhandled promise rejection.',
    reason instanceof Error ? reason : new Error(String(reason))
  );
});

process.on('uncaughtException', (err) => {
  error('UNCAUGHT_EXCEPTION', 'Uncaught exception.', err);
  process.exit(1);
});

// ======================================================
// RUN
// ======================================================

startServer().catch(err => {
  error('STARTUP_FATAL', 'Bot startup failed.', err);
  process.exit(1);
});
