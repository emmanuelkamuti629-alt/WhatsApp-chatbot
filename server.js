
require('dotenv').config();

const express = require('express');
const path = require('path');
const QRCode = require('qrcode');
const pino = require('pino');
const NodeCache = require('node-cache');
const OpenAI = require('openai');
const { MongoClient } = require('mongodb');

const baileys = require('@whiskeysockets/baileys');

const makeWASocket = baileys.default;

const {
  DisconnectReason,
  BufferJSON,
  initAuthCreds,
  proto,
  makeCacheableSignalKeyStore,
  fetchLatestBaileysVersion
} = baileys;

// =====================================================
// 1. CONFIGURATION
// =====================================================

const config = {
  port: process.env.PORT || 3000,

  mongoUri: process.env.MONGODB_URI,
  mongoDb: process.env.MONGODB_DB || 'whatsapp_bot',

  geminiKey: process.env.GEMINI_API_KEY,

  // Use GEMINI_MODEL, not the old OPENAI_MODEL.
  model: process.env.GEMINI_MODEL || 'gemini-3.8-flash',

  maxTokens: Number(process.env.OPENAI_MAX_TOKENS || 1000),

  temperature: Number(process.env.OPENAI_TEMPERATURE || 0.7),

  botName: process.env.BOT_NAME || 'Smart Assistant',

  personality:
    process.env.BOT_PERSONALITY ||
    'You are a helpful, friendly, intelligent and accurate WhatsApp assistant. Answer naturally, clearly and politely.',

  maxHistory: Number(process.env.MAX_HISTORY_MESSAGES || 10)
};

// =====================================================
// 2. LOGGER
// =====================================================

const logger = pino({
  level: process.env.LOG_LEVEL || 'info'
});

// =====================================================
// 3. GEMINI AI CONFIGURATION
// =====================================================

const ai = new OpenAI({
  apiKey: config.geminiKey || 'missing-key',

  baseURL:
    'https://generativelanguage.googleapis.com/v1beta/openai/',

  timeout: 60000,

  maxRetries: 2
});

const historyCache = new NodeCache({
  stdTTL: 3600,
  checkperiod: 600
});

// =====================================================
// 4. MONGODB
// =====================================================

const mongoClient = new MongoClient(
  config.mongoUri || 'mongodb://127.0.0.1:27017',
  {
    serverSelectionTimeoutMS: 15000,
    connectTimeoutMS: 15000,
    maxPoolSize: 10
  }
);

let db;
let authCollection;

let mongoReady = false;

// =====================================================
// 5. GLOBAL WHATSAPP VARIABLES
// =====================================================

let sock = null;
let authState = null;

let isConnected = false;
let isConnecting = false;
let pairingReady = false;
let pairingInProgress = false;

let pairingCode = null;
let latestQRDataUrl = null;

let reconnectTimer = null;
let reconnectAttempts = 0;

let lastConnectionError = null;
let lastConnectedAt = null;

let serverStarted = false;

// =====================================================
// 6. CONNECT TO MONGODB
// =====================================================

async function connectMongo() {

  if (!config.mongoUri) {
    throw new Error('MONGODB_URI is missing in Render.');
  }

  console.log('Connecting to MongoDB Atlas...');

  await mongoClient.connect();

  db = mongoClient.db(config.mongoDb);

  authCollection = db.collection('baileys_auth');

  await authCollection.createIndex({
    updatedAt: 1
  });

  mongoReady = true;

  console.log('MONGODB CONNECTED SUCCESSFULLY');

}

// =====================================================
// 7. MONGODB AUTHENTICATION STORAGE
// =====================================================

async function useMongoAuthState(collection) {

  // Read saved data.

  async function readData(id) {

    const doc = await collection.findOne({
      _id: id
    });

    if (!doc || !doc.value) {
      return null;
    }

    return JSON.parse(
      doc.value,
      BufferJSON.reviver
    );

  }

  // Write saved data.

  async function writeData(id, value) {

    const serialized = JSON.stringify(
      value,
      BufferJSON.replacer
    );

    await collection.updateOne(
      { _id: id },

      {
        $set: {
          value: serialized,
          updatedAt: new Date()
        }
      },

      { upsert: true }
    );

  }

  // Delete saved data.

  async function removeData(id) {

    await collection.deleteOne({
      _id: id
    });

  }

  // Restore WhatsApp credentials.

  const creds =
    (await readData('creds')) || initAuthCreds();

  // Signal encryption key storage.

  const keys = {

    get: async (type, ids) => {

      const result = {};

      if (!ids.length) return result;

      const documents = await collection.find({
        _id: {
          $in: ids.map(id => `${type}-${id}`)
        }
      }).toArray();

      const stored = new Map(
        documents.map(doc => [
          doc._id,
          doc.value
        ])
      );

      for (const id of ids) {

        const value = stored.get(`${type}-${id}`);

        let data = value
          ? JSON.parse(value, BufferJSON.reviver)
          : null;

        if (
          type === 'app-state-sync-key' &&
          data
        ) {

          data =
            proto.Message.AppStateSyncKeyData.fromObject(
              data
            );

        }

        result[id] = data;

      }

      return result;

    },

    set: async data => {

      const operations = [];

      for (const category in data) {

        for (const id in data[category]) {

          const value = data[category][id];

          const key = `${category}-${id}`;

          if (value) {

            operations.push({
              updateOne: {

                filter: {
                  _id: key
                },

                update: {
                  $set: {
                    value: JSON.stringify(
                      value,
                      BufferJSON.replacer
                    ),

                    updatedAt: new Date()
                  }
                },

                upsert: true

              }
            });

          } else {

            operations.push({
              deleteOne: {
                filter: {
                  _id: key
                }
              }
            });

          }

        }

      }

      if (operations.length) {

        await collection.bulkWrite(
          operations,
          { ordered: false }
        );

      }

    }

  };

  // Save updated credentials.

  async function saveCreds() {

    await writeData('creds', creds);

  }

  return {
    state: {
      creds,
      keys
    },

    saveCreds
  };

}

// =====================================================
// 8. PHONE NUMBER VALIDATION
// =====================================================

function normalizePhoneNumber(input) {

  let phone = String(input || '')
    .replace(/\D/g, '');

  if (
    phone.startsWith('0') &&
    phone.length === 10
  ) {

    phone = '254' + phone.substring(1);

  }

  if (/^254[17]\d{8}$/.test(phone)) {
    return phone;
  }

  if (/^[1-9]\d{7,14}$/.test(phone)) {
    return phone;
  }

  return null;

}

// =====================================================
// 9. GEMINI RESPONSE GENERATOR
// =====================================================

async function generateReply(chatId, userMessage) {

  if (!userMessage) return null;

  if (!config.geminiKey) {

    console.error('GEMINI_API_KEY IS MISSING');

    return "⚠️ I'm having trouble thinking right now. Please try again.";

  }

  let history = historyCache.get(chatId) || [];

  history.push({
    role: 'user',
    content: userMessage
  });

  const messages = [
    {
      role: 'system',
      content: config.personality
    },

    ...history
  ];

  try {

    console.log('GEMINI REQUEST STARTED');

    console.log('MODEL:', config.model);

    const response = await ai.chat.completions.create({

      model: config.model,

      messages,

      max_tokens: config.maxTokens,

      temperature: config.temperature

    });

    const reply =
      response.choices?.[0]?.message?.content;

    if (!reply || typeof reply !== 'string') {

      throw new Error('Gemini returned an empty response.');

    }

    history.push({
      role: 'assistant',
      content: reply
    });

    historyCache.set(
      chatId,
      history.slice(-config.maxHistory * 2)
    );

    console.log('GEMINI RESPONSE SUCCESSFUL');

    return reply;

  } catch (error) {

    console.error('GEMINI API ERROR:', {
      message: error.message,
      status: error.status,
      code: error.code,
      model: config.model
    });

    // Remove failed user message from history.

    history.pop();

    historyCache.set(
      chatId,
      history.slice(-config.maxHistory * 2)
    );

    // ORIGINAL FALLBACK MESSAGE.

    return "⚠️ I'm having trouble thinking right now. Please try again.";

  }

}

// =====================================================
// 10. EXPRESS SERVER
// =====================================================

const app = express();

app.use(express.json({
  limit: '1mb'
}));

app.use(express.static(__dirname));

app.get('/', (req, res) => {

  res.sendFile(
    path.join(__dirname, 'index.html')
  );

});

// =====================================================
// 11. HEALTH CHECK
// =====================================================

app.get('/health', (req, res) => {

  res.set('Cache-Control', 'no-store');

  res.json({

    status: 'ok',

    bot: config.botName,

    aiProvider: 'Google Gemini',

    aiModel: config.model,

    aiConfigured: !!config.geminiKey,

    mongodbReady: mongoReady,

    whatsappReady: isConnected,

    pairingReady,

    qrPending: !!latestQRDataUrl,

    lastConnectedAt,

    lastConnectionError

  });

});

app.get('/status', (req, res) => {

  res.set('Cache-Control', 'no-store');

  res.json({

    connected: isConnected,

    mongodb: mongoReady,

    pairingReady,

    bot: config.botName,

    ai: 'Google Gemini',

    model: config.model

  });

});

// =====================================================
// 12. WHATSAPP LOGIN PAGE
// =====================================================

app.get('/qr', (req, res) => {

  if (isConnected) {

    return res.send(`

      <!DOCTYPE html>

      <html>

      <head>

        <title>WhatsApp Connected</title>

        <meta name="viewport"
          content="width=device-width, initial-scale=1">

      </head>

      <body style="
        margin:0;
        min-height:100vh;
        display:flex;
        align-items:center;
        justify-content:center;
        background:#f0f2f5;
        font-family:Arial;
      ">

        <div style="
          background:white;
          padding:30px;
          border-radius:15px;
          text-align:center;
        ">

          <h2 style="color:#25d366">
            ✅ WhatsApp Connected!
          </h2>

          <p>Your chatbot is online.</p>

          <p>AI: Google Gemini</p>

          <p>Database: MongoDB Atlas</p>

          <p>You can close this page.</p>

        </div>

      </body>

      </html>

    `);

  }

  let contentHtml = '';

  if (pairingCode) {

    contentHtml = `

      <h2 style="color:#075e54">
        Your Pairing Code
      </h2>

      <div style="
        font-size:clamp(35px,10vw,70px);
        font-weight:900;
        color:#128c7e;
        letter-spacing:5px;
        margin:25px 0;
      ">
        ${pairingCode}
      </div>

      <div style="
        background:white;
        padding:20px;
        border-radius:12px;
        text-align:left;
        line-height:2;
      ">

        1. Open WhatsApp.<br>

        2. Go to Linked Devices.<br>

        3. Tap Link a Device.<br>

        4. Choose Link with phone number instead.<br>

        5. Enter the code above.

      </div>

    `;

  } else if (latestQRDataUrl) {

    contentHtml = `

      <h2 style="color:#075e54">
        Scan with WhatsApp
      </h2>

      <p>Linked Devices → Link a Device</p>

      <img
        src="${latestQRDataUrl}"
        style="
          width:75vw;
          max-width:400px;
          height:auto;
          border:10px solid white;
          border-radius:15px;
        "
      >

    `;

  } else {

    contentHtml = `

      <h2 style="color:#667781">
        ⏳ Starting WhatsApp...
      </h2>

      <p>Please wait while your session is restored.</p>

      <p>MongoDB: ${
        mongoReady ? 'Connected' : 'Connecting'
      }</p>

    `;

  }

  const showInput = !pairingCode && !isConnected;

  res.send(`

    <!DOCTYPE html>

    <html>

    <head>

      <title>WhatsApp Login</title>

      <meta name="viewport"
        content="width=device-width, initial-scale=1">

      <meta http-equiv="refresh" content="20">

    </head>

    <body style="
      margin:0;
      padding:20px;
      min-height:100vh;
      box-sizing:border-box;
      display:flex;
      align-items:center;
      justify-content:center;
      background:#f0f2f5;
      font-family:Arial;
    ">

      <div style="
        width:100%;
        max-width:500px;
        text-align:center;
      ">

        ${contentHtml}

        ${showInput ? `

          <div style="
            margin-top:30px;
            padding:25px;
            background:white;
            border-radius:15px;
            box-sizing:border-box;
          ">

            <h2 style="color:#075e54">
              Login with Phone Number
            </h2>

            <p style="color:#667781">
              Enter your WhatsApp number with country code.
            </p>

            <input
              id="phone"
              type="tel"
              placeholder="254712345678"
              style="
                width:100%;
                box-sizing:border-box;
                padding:15px;
                border:2px solid #ccc;
                border-radius:8px;
                font-size:18px;
                margin-bottom:15px;
              "
            >

            <button
              id="getCode"
              onclick="getPairingCode()"
              style="
                width:100%;
                padding:16px;
                background:#25d366;
                color:white;
                border:0;
                border-radius:8px;
                font-size:18px;
                font-weight:bold;
              "
            >
              Get Pairing Code
            </button>

            <p id="message"></p>

          </div>

          <script>

            async function getPairingCode() {

              const phone =
                document.getElementById('phone').value.trim();

              const button =
                document.getElementById('getCode');

              const message =
                document.getElementById('message');

              if (!phone) {

                alert('Enter your WhatsApp number');

                return;

              }

              button.disabled = true;

              button.innerText = 'Generating...';

              try {

                const response = await fetch(
                  '/request-pairing?phone=' +
                  encodeURIComponent(phone)
                );

                const data = await response.json();

                if (!response.ok) {

                  throw new Error(
                    data.error || 'Pairing failed'
                  );

                }

                window.location.reload();

              } catch (error) {

                message.innerText = error.message;

                button.disabled = false;

                button.innerText = 'Get Pairing Code';

              }

            }

          </script>

        ` : ''}

      </div>

      <script>

        async function checkStatus() {

          try {

            const response = await fetch(
              '/status',
              { cache: 'no-store' }
            );

            const data = await response.json();

            if (data.connected) {

              window.location.reload();

            }

          } catch (error) {

            console.log('Status check failed');

          }

        }

        setInterval(checkStatus, 5000);

      </script>

    </body>

    </html>

  `);

});

// =====================================================
// 13. PAIRING CODE ENDPOINT
// =====================================================

app.get('/request-pairing', async (req, res) => {

  const phone = normalizePhoneNumber(req.query.phone);

  if (!phone) {

    return res.status(400).json({

      error: 'Invalid phone number. Include country code.'

    });

  }

  if (!mongoReady || !sock || !authState) {

    return res.status(503).json({

      error: 'WhatsApp or MongoDB is not ready.'

    });

  }

  if (isConnected) {

    return res.status(409).json({

      error: 'WhatsApp is already connected.'

    });

  }

  if (authState.creds.registered) {

    return res.status(409).json({

      error: 'A saved WhatsApp session already exists. Check connection status.'

    });

  }

  if (!pairingReady) {

    return res.status(503).json({

      error: 'WhatsApp is initializing. Please wait a few seconds.'

    });

  }

  if (pairingInProgress) {

    return res.status(409).json({

      error: 'Pairing request already in progress.'

    });

  }

  pairingInProgress = true;

  try {

    console.log('REQUESTING PAIRING CODE');

    const code = await sock.requestPairingCode(phone);

    pairingCode =
      code.match(/.{1,4}/g)?.join('-') || code;

    latestQRDataUrl = null;

    res.json({

      success: true,

      code: pairingCode

    });

  } catch (error) {

    console.error('PAIRING ERROR:', error.message);

    res.status(500).json({

      error: error.message || 'Failed to generate pairing code.'

    });

  } finally {

    pairingInProgress = false;

  }

});

// =====================================================
// 14. SEND MESSAGE ENDPOINT
// =====================================================

app.post('/send', async (req, res) => {

  const { to, message } = req.body;

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

  const phone = normalizePhoneNumber(to);

  if (!phone) {

    return res.status(400).json({

      error: 'Invalid phone number.'

    });

  }

  try {

    await sock.sendMessage(

      `${phone}@s.whatsapp.net`,

      { text: String(message) }

    );

    res.json({

      success: true

    });

  } catch (error) {

    console.error('SEND ERROR:', error.message);

    res.status(500).json({

      error: error.message

    });

  }

});

// =====================================================
// 15. CONNECT WHATSAPP
// =====================================================

async function connectToWhatsApp() {

  if (isConnecting || isConnected) return;

  if (!mongoReady || !authCollection) {

    console.log('Waiting for MongoDB...');

    return;

  }

  isConnecting = true;

  try {

    console.log('RESTORING WHATSAPP SESSION FROM MONGODB');

    const mongoAuth = await useMongoAuthState(
      authCollection
    );

    authState = mongoAuth.state;

    // Wrap key store in cache for better performance.

    const cachedKeys = makeCacheableSignalKeyStore(
      authState.keys,
      logger
    );

    // Get latest WhatsApp Web version.

    let version;

    try {

      const latest = await fetchLatestBaileysVersion();

      version = latest.version;

      console.log(
        'WHATSAPP WEB VERSION:',
        version.join('.')
      );

    } catch (error) {

      console.error(
        'VERSION FETCH FAILED:',
        error.message
      );

      console.log('Using Baileys default version.');

    }

    const currentSock = makeWASocket({

      ...(version ? { version } : {}),

      auth: {

        creds: authState.creds,

        keys: cachedKeys

      },

      logger,

      printQRInTerminal: false,

      browser: [
        'Ubuntu',
        'Chrome',
        '20.0.04'
      ],

      markOnlineOnConnect: false,

      syncFullHistory: false

    });

    sock = currentSock;

    isConnecting = false;

    // =================================================
    // SAVE CREDENTIALS
    // =================================================

    currentSock.ev.on(
      'creds.update',
      async () => {

        try {

          await mongoAuth.saveCreds();

          console.log('WHATSAPP CREDENTIALS SAVED');

        } catch (error) {

          console.error(
            'CREDENTIAL SAVE ERROR:',
            error.message
          );

        }

      }
    );

    // =================================================
    // CONNECTION EVENTS
    // =================================================

    currentSock.ev.on(
      'connection.update',
      async update => {

        const {
          connection,
          lastDisconnect,
          qr
        } = update;

        if (sock !== currentSock) return;

        // QR CODE.

        if (qr && !authState.creds.registered) {

          pairingReady = true;

          try {

            latestQRDataUrl = await QRCode.toDataURL(
              qr,
              {
                width: 500,
                margin: 1
              }
            );

            console.log('WHATSAPP QR GENERATED');

          } catch (error) {

            console.error('QR ERROR:', error.message);

          }

        }

        // CONNECTING.

        if (connection === 'connecting') {

          console.log('WHATSAPP CONNECTING...');

        }

        // OPEN.

        if (connection === 'open') {

          isConnected = true;

          isConnecting = false;

          pairingReady = false;

          pairingCode = null;

          latestQRDataUrl = null;

          reconnectAttempts = 0;

          lastConnectionError = null;

          lastConnectedAt = new Date().toISOString();

          if (reconnectTimer) {

            clearTimeout(reconnectTimer);

            reconnectTimer = null;

          }

          console.log('================================');

          console.log('WHATSAPP CONNECTED SUCCESSFULLY');

          console.log('MONGODB SESSION ACTIVE');

          console.log('GEMINI AI:', config.model);

          console.log('================================');

        }

        // CLOSE.

        if (connection === 'close') {

          isConnected = false;

          isConnecting = false;

          pairingReady = false;

          pairingCode = null;

          latestQRDataUrl = null;

          sock = null;

          const statusCode =
            lastDisconnect?.error?.output?.statusCode;

          lastConnectionError =
            lastDisconnect?.error?.message ||
            String(statusCode || 'Unknown disconnect');

          const loggedOut =
            statusCode === DisconnectReason.loggedOut;

          const replaced =
            statusCode === 440;

          console.error('WHATSAPP DISCONNECTED');

          console.error('STATUS CODE:', statusCode);

          console.error('REASON:', lastConnectionError);

          if (!loggedOut && !replaced) {

            reconnectAttempts++;

            const delay = Math.min(
              3000 * Math.pow(2, reconnectAttempts - 1),
              30000
            );

            console.log(
              `RECONNECTING IN ${delay / 1000} SECONDS`
            );

            if (reconnectTimer) {

              clearTimeout(reconnectTimer);

            }

            reconnectTimer = setTimeout(() => {

              connectToWhatsApp().catch(error => {

                console.error(
                  'RECONNECT ERROR:',
                  error.message
                );

              });

            }, delay);

          } else if (loggedOut) {

            console.error(
              'WHATSAPP LOGGED OUT. NEW PAIRING REQUIRED.'
            );

          } else {

            console.error(
              'ANOTHER WHATSAPP CONNECTION REPLACED THIS SESSION.'
            );

          }

        }

      }
    );

    // =================================================
    // RECEIVE MESSAGES
    // =================================================

    currentSock.ev.on(
      'messages.upsert',
      async event => {

        // Ignore historical message synchronization.

        if (event.type !== 'notify') return;

        for (const msg of event.messages) {

          try {

            if (!msg.message) continue;

            if (msg.key.fromMe) continue;

            const chatId = msg.key.remoteJid;

            if (!chatId) continue;

            if (
              chatId === 'status@broadcast' ||
              chatId.endsWith('@newsletter')
            ) {

              continue;

            }

            const userMessage =

              msg.message.conversation ||

              msg.message.extendedTextMessage?.text ||

              msg.message.imageMessage?.caption ||

              msg.message.videoMessage?.caption ||

              msg.message.documentMessage?.caption;

            if (!userMessage || !userMessage.trim()) {

              continue;

            }

            console.log('INCOMING MESSAGE:', chatId);

            console.log('MESSAGE:', userMessage);

            const reply = await generateReply(
              chatId,
              userMessage.trim()
            );

            if (
              reply &&
              sock === currentSock &&
              isConnected
            ) {

              await currentSock.sendMessage(
                chatId,
                { text: reply }
              );

              console.log('REPLY SENT:', chatId);

            }

          } catch (error) {

            console.error(
              'MESSAGE PROCESSING ERROR:',
              error.message
            );

          }

        }

      }
    );

  } catch (error) {

    isConnecting = false;

    isConnected = false;

    lastConnectionError = error.message;

    console.error('WHATSAPP START ERROR:', error);

    if (reconnectTimer) {

      clearTimeout(reconnectTimer);

    }

    reconnectTimer = setTimeout(() => {

      connectToWhatsApp().catch(err => {

        console.error('RETRY ERROR:', err.message);

      });

    }, 5000);

  }

}

// =====================================================
// 16. DATABASE STARTUP RETRY
// =====================================================

let databaseRetrying = false;

async function retryMongoConnection() {

  if (databaseRetrying || mongoReady) return;

  databaseRetrying = true;

  try {

    console.log('RETRYING MONGODB CONNECTION...');

    await connectMongo();

    databaseRetrying = false;

    await connectToWhatsApp();

  } catch (error) {

    databaseRetrying = false;

    console.error(
      'MONGODB CONNECTION ERROR:',
      error.message
    );

    setTimeout(
      retryMongoConnection,
      15000
    );

  }

}

// =====================================================
// 17. START SERVER
// =====================================================

async function startApplication() {

  if (serverStarted) return;

  serverStarted = true;

  app.listen(
    config.port,
    '0.0.0.0',
    () => {

      console.log('================================');

      console.log('WHATSAPP CHATBOT SERVER STARTED');

      console.log('PORT:', config.port);

      console.log('AI MODEL:', config.model);

      console.log('================================');

    }
  );

  if (!config.geminiKey) {

    console.error('WARNING: GEMINI_API_KEY IS MISSING');

  }

  try {

    await connectMongo();

    await connectToWhatsApp();

  } catch (error) {

    console.error(
      'INITIAL STARTUP ERROR:',
      error.message
    );

    setTimeout(
      retryMongoConnection,
      10000
    );

  }

}

// =====================================================
// 18. GRACEFUL SHUTDOWN
// =====================================================

async function shutdown() {

  console.log('SHUTTING DOWN SERVER...');

  if (reconnectTimer) {

    clearTimeout(reconnectTimer);

    reconnectTimer = null;

  }

  try {

    if (sock) {

      sock.end(undefined);

      sock = null;

    }

    await mongoClient.close();

  } catch (error) {

    console.error(
      'SHUTDOWN ERROR:',
      error.message
    );

  }

  process.exit(0);

}

process.on('SIGTERM', shutdown);

process.on('SIGINT', shutdown);

// =====================================================
// 19. RUN
// =====================================================

startApplication().catch(error => {

  console.error('FATAL SERVER ERROR:', error);

});
