
require('dotenv').config();

const express = require('express');
const path = require('path');
const fs = require('fs');

const {
  default: makeWASocket,
  DisconnectReason,
  initAuthCreds,
  BufferJSON,
  proto
} = require('@whiskeysockets/baileys');

const { MongoClient } = require('mongodb');
const QRCode = require('qrcode');
const OpenAI = require('openai');
const pino = require('pino');

// =====================================================
// CONFIGURATION
// =====================================================

const config = {
  port: process.env.PORT || 3000,

  mongoURI: process.env.MONGODB_URI,
  database: process.env.MONGODB_DB_NAME || 'whatsapp_bot',

  geminiKey: process.env.GEMINI_API_KEY,
  geminiModel: process.env.GEMINI_MODEL || 'gemini-3.8-flash',

  botName: process.env.BOT_NAME || 'Smart Assistant',

  personality:
    process.env.BOT_PERSONALITY ||
    'You are a helpful, friendly and intelligent WhatsApp assistant. Answer naturally, accurately and conversationally.',

  maxHistory: Number(process.env.MAX_HISTORY_MESSAGES || 10)
};

// =====================================================
// EXPRESS SERVER
// =====================================================

const app = express();

app.use(express.json());
app.use(express.static(path.join(__dirname)));

let sock = null;
let authState = null;

let isConnected = false;
let isConnecting = false;
let mongoConnected = false;

let latestQRDataUrl = null;
let pairingCode = null;
let reconnectTimer = null;

let authCollection;
let historyCollection;
let mongoClient;

const logger = pino({
  level: process.env.LOG_LEVEL || 'silent'
});

// =====================================================
// GEMINI AI CONFIGURATION
// =====================================================

const ai = config.geminiKey
  ? new OpenAI({
      apiKey: config.geminiKey,
      baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai/'
    })
  : null;

// =====================================================
// MONGODB AUTHENTICATION STORAGE
// =====================================================

async function useMongoDBAuthState(collection) {

  async function writeData(data, id) {
    const serialized = JSON.parse(
      JSON.stringify(data, BufferJSON.replacer)
    );

    await collection.updateOne(
      { _id: id },
      { $set: { data: serialized } },
      { upsert: true }
    );
  }

  async function readData(id) {
    try {
      const document = await collection.findOne({ _id: id });

      if (!document || document.data === undefined) {
        return null;
      }

      return JSON.parse(
        JSON.stringify(document.data),
        BufferJSON.reviver
      );

    } catch (error) {
      console.error('Mongo read error:', error.message);
      return null;
    }
  }

  async function removeData(id) {
    await collection.deleteOne({ _id: id });
  }

  const creds = (await readData('creds')) || initAuthCreds();

  const state = {
    creds,

    keys: {
      get: async (type, ids) => {

        const data = {};

        await Promise.all(
          ids.map(async (id) => {

            let value = await readData(`${type}-${id}`);

            if (type === 'app-state-sync-key' && value) {
              value = proto.Message.AppStateSyncKeyData.fromObject(value);
            }

            data[id] = value;
          })
        );

        return data;
      },

      set: async (data) => {

        const tasks = [];

        for (const category of Object.keys(data)) {

          for (const id of Object.keys(data[category])) {

            const value = data[category][id];
            const key = `${category}-${id}`;

            if (value) {
              tasks.push(writeData(value, key));
            } else {
              tasks.push(removeData(key));
            }
          }
        }

        await Promise.all(tasks);
      }
    }
  };

  return {
    state,

    saveCreds: async () => {
      await writeData(creds, 'creds');
    }
  };
}

// =====================================================
// GEMINI RESPONSE GENERATOR
// =====================================================

async function generateReply(chatId, userMessage) {

  if (!userMessage || !ai) {
    if (!ai) {
      console.error('GEMINI_API_KEY is missing.');
    }

    return "⚠️ I'm having trouble thinking right now. Please try again.";
  }

  try {

    // Restore conversation history from MongoDB
    const saved = await historyCollection.findOne({
      _id: chatId
    });

    const history = saved?.messages || [];

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

    const response = await ai.chat.completions.create({

      model: config.geminiModel,

      messages,

      max_tokens: 700,

      temperature: 0.7
    });

    const reply =
      response.choices?.[0]?.message?.content?.trim();

    if (!reply) {
      throw new Error('Gemini returned an empty response.');
    }

    // Store conversation in MongoDB
    const updatedHistory = [
      ...history,
      { role: 'user', content: userMessage },
      { role: 'assistant', content: reply }
    ].slice(-config.maxHistory * 2);

    await historyCollection.updateOne(
      { _id: chatId },
      {
        $set: {
          messages: updatedHistory,
          updatedAt: new Date()
        }
      },
      { upsert: true }
    );

    return reply;

  } catch (error) {

    console.error(
      'Gemini AI Error:',
      error.status || '',
      error.message
    );

    return "⚠️ I'm having trouble thinking right now. Please try again.";
  }
}

// =====================================================
// WHATSAPP CONNECTION
// =====================================================

async function connectToWhatsApp() {

  if (isConnecting || isConnected) {
    return;
  }

  if (!mongoConnected) {
    console.log('Waiting for MongoDB...');
    scheduleReconnect();
    return;
  }

  isConnecting = true;

  try {

    console.log('Restoring WhatsApp authentication...');

    const auth = await useMongoDBAuthState(authCollection);

    authState = auth.state;

    sock = makeWASocket({

      auth: auth.state,

      logger,

      browser: ['Ubuntu', 'Chrome', '20.0.04'],

      markOnlineOnConnect: false,

      syncFullHistory: false,

      connectTimeoutMs: 60000,

      defaultQueryTimeoutMs: 60000,

      keepAliveIntervalMs: 25000

    });

    isConnecting = false;

    // Save updated WhatsApp credentials
    sock.ev.on('creds.update', async () => {

      try {
        await auth.saveCreds();
        console.log('WhatsApp credentials saved to MongoDB.');
      } catch (error) {
        console.error('Credential save error:', error.message);
      }

    });

    // Connection status
    sock.ev.on('connection.update', async (update) => {

      const { connection, lastDisconnect, qr } = update;

      if (qr && !authState.creds.registered) {

        try {

          pairingCode = null;

          latestQRDataUrl = await QRCode.toDataURL(qr, {
            width: 500,
            margin: 2
          });

          console.log('New WhatsApp QR code generated.');

        } catch (error) {
          console.error('QR generation error:', error.message);
        }
      }

      if (connection === 'connecting') {

        isConnected = false;

        console.log('Connecting to WhatsApp...');

      }

      if (connection === 'open') {

        isConnected = true;

        latestQRDataUrl = null;
        pairingCode = null;

        console.log('================================');
        console.log('WHATSAPP BOT IS ONLINE!');
        console.log('================================');

      }

      if (connection === 'close') {

        isConnected = false;
        latestQRDataUrl = null;

        sock = null;

        const statusCode =
          lastDisconnect?.error?.output?.statusCode;

        console.log('WhatsApp disconnected:', statusCode);

        if (statusCode === DisconnectReason.loggedOut) {

          pairingCode = null;

          console.error(
            'WhatsApp logged out. A new pairing is required.'
          );

          return;
        }

        if (statusCode === DisconnectReason.restartRequired) {
          console.log('WhatsApp requires a fresh socket. Reconnecting...');
        }

        scheduleReconnect();

      }

    });

    // =================================================
    // RECEIVE WHATSAPP MESSAGES
    // =================================================

    sock.ev.on('messages.upsert', async (event) => {

      if (event.type !== 'notify') return;

      for (const msg of event.messages) {

        if (!msg.message || msg.key.fromMe) continue;

        const chatId = msg.key.remoteJid;

        if (!chatId || chatId === 'status@broadcast') continue;

        // Ignore broadcast and newsletter messages
        if (
          chatId.endsWith('@broadcast') ||
          chatId.endsWith('@newsletter')
        ) continue;

        let messageContent = msg.message;

        // Unwrap ephemeral messages
        while (
          messageContent?.ephemeralMessage?.message
        ) {
          messageContent = messageContent.ephemeralMessage.message;
        }

        // Extract message text
        const userText =
          messageContent.conversation ||
          messageContent.extendedTextMessage?.text ||
          messageContent.imageMessage?.caption ||
          messageContent.videoMessage?.caption ||
          messageContent.documentMessage?.caption ||
          messageContent.buttonsResponseMessage?.selectedDisplayText ||
          messageContent.listResponseMessage?.title;

        if (!userText || !userText.trim()) continue;

        console.log(
          `Incoming message from ${chatId}: ${userText.slice(0, 80)}`
        );

        try {

          const reply = await generateReply(chatId, userText);

          if (reply && sock && isConnected) {

            await sock.sendMessage(chatId, {
              text: reply
            });

            console.log('AI reply sent successfully.');

          }

        } catch (error) {

          console.error('Message processing error:', error.message);

          if (sock && isConnected) {

            try {

              await sock.sendMessage(chatId, {
                text: "⚠️ I'm having trouble thinking right now. Please try again."
              });

            } catch (sendError) {
              console.error('Reply delivery error:', sendError.message);
            }

          }
        }
      }
    });

  } catch (error) {

    isConnecting = false;

    console.error('WhatsApp startup error:', error.message);

    scheduleReconnect();
  }
}

// =====================================================
// AUTOMATIC RECONNECTION
// =====================================================

function scheduleReconnect() {

  if (reconnectTimer) return;

  console.log('WhatsApp will reconnect automatically...');

  reconnectTimer = setTimeout(async () => {

    reconnectTimer = null;

    if (!isConnected && mongoConnected) {
      await connectToWhatsApp();
    }

  }, 5000);
}

// =====================================================
// PAIRING CODE
// =====================================================

app.get('/request-pairing', async (req, res) => {

  let phone = String(req.query.phone || '').replace(/\D/g, '');

  if (!phone || phone.length < 8 || phone.length > 15) {

    return res.status(400).json({
      success: false,
      error: 'Enter a valid phone number with country code.'
    });

  }

  if (!sock || !authState || isConnected) {

    return res.status(503).json({
      success: false,
      error: 'WhatsApp is not ready for pairing. Please wait.'
    });

  }

  if (authState.creds.registered) {

    return res.status(409).json({
      success: false,
      error: 'A WhatsApp session is already registered.'
    });

  }

  try {

    pairingCode = null;
    latestQRDataUrl = null;

    const code = await sock.requestPairingCode(phone);

    pairingCode = code.match(/.{1,4}/g)?.join('-') || code;

    console.log('WhatsApp pairing code generated.');

    res.json({
      success: true,
      code: pairingCode
    });

  } catch (error) {

    console.error('Pairing code error:', error.message);

    res.status(500).json({
      success: false,
      error: 'Could not generate pairing code. Please try again.'
    });

  }

});

// =====================================================
// QR LOGIN PAGE
// =====================================================

app.get('/qr', (req, res) => {

  let content = '';

  if (isConnected) {

    content = `
      <h2 style="color:#128c7e">✅ WhatsApp Connected!</h2>
      <p>Your bot is online and ready to receive messages.</p>
    `;

  } else if (pairingCode) {

    content = `
      <h2>Your WhatsApp Pairing Code</h2>

      <div class="code">${pairingCode}</div>

      <p>Open WhatsApp on your phone:</p>

      <ol>
        <li>Go to Linked Devices.</li>
        <li>Tap Link a Device.</li>
        <li>Choose Link with phone number instead.</li>
        <li>Enter the code displayed above.</li>
      </ol>
    `;

  } else if (latestQRDataUrl) {

    content = `
      <h2>Scan QR Code</h2>

      <img src="${latestQRDataUrl}" width="280" />

      <p>Scan using WhatsApp Linked Devices.</p>
    `;

  } else {

    content = `
      <h2>⏳ Starting WhatsApp...</h2>
      <p>Please wait while your session is restored.</p>
    `;

  }

  let loginForm = '';

  if (!isConnected && !pairingCode && !latestQRDataUrl) {

    loginForm = `
      <div class="login">

        <h2>Login with Phone Number</h2>

        <p>Enter your WhatsApp number with country code.</p>

        <input
          id="phone"
          type="tel"
          placeholder="254712345678"
        />

        <button onclick="getCode()">
          Get Pairing Code
        </button>

        <p id="error"></p>

      </div>

      <script>

        async function getCode() {

          const phone = document.getElementById('phone').value;
          const button = document.querySelector('button');
          const error = document.getElementById('error');

          if (!phone) {
            error.innerText = 'Enter your phone number.';
            return;
          }

          button.disabled = true;
          button.innerText = 'Generating...';

          try {

            const response = await fetch(
              '/request-pairing?phone=' + encodeURIComponent(phone)
            );

            const result = await response.json();

            if (!response.ok) {
              throw new Error(result.error || 'Request failed');
            }

            location.reload();

          } catch (e) {

            error.innerText = e.message;

            button.disabled = false;
            button.innerText = 'Get Pairing Code';

          }

        }

      </script>
    `;

  }

  res.send(`
    <!DOCTYPE html>

    <html>

    <head>

      <title>WhatsApp AI Bot</title>

      <meta name="viewport" content="width=device-width, initial-scale=1">

      <meta http-equiv="refresh" content="20">

      <style>

        * {
          box-sizing: border-box;
        }

        body {
          margin: 0;
          padding: 20px;
          min-height: 100vh;
          background: #f0f2f5;
          font-family: Arial, sans-serif;
          display: flex;
          justify-content: center;
          align-items: center;
          text-align: center;
          color: #333;
        }

        .container {
          width: 100%;
          max-width: 650px;
        }

        .login {
          background: white;
          padding: 30px;
          border-radius: 20px;
          margin-top: 35px;
        }

        h2 {
          color: #075e54;
        }

        input {
          width: 100%;
          padding: 18px;
          border: 2px solid #ccc;
          border-radius: 10px;
          font-size: 18px;
          margin: 15px 0;
        }

        button {
          width: 100%;
          padding: 18px;
          background: #25d366;
          color: white;
          border: none;
          border-radius: 10px;
          font-size: 18px;
          font-weight: bold;
        }

        button:disabled {
          opacity: 0.6;
        }

        .code {
          font-size: clamp(35px, 10vw, 65px);
          font-weight: bold;
          letter-spacing: 5px;
          color: #128c7e;
          margin: 25px 0;
        }

        img {
          max-width: 100%;
          height: auto;
        }

        #error {
          color: red;
        }

      </style>

    </head>

    <body>

      <div class="container">

        ${content}

        ${loginForm}

      </div>

    </body>

    </html>
  `);

});

// =====================================================
// HEALTH CHECK FOR UPTIMEROBOT
// =====================================================

app.get('/health', (req, res) => {

  res.json({

    status: 'ok',

    bot: config.botName,

    aiProvider: 'Google Gemini',

    aiModel: config.geminiModel,

    aiConfigured: !!ai,

    mongoConnected,

    whatsappReady: isConnected,

    pairingReady: !!sock && !isConnected,

    qrPending: !!latestQRDataUrl

  });

});

// =====================================================
// SEND MESSAGE API
// =====================================================

app.post('/send', async (req, res) => {

  const { to, message } = req.body;

  if (!to || !message) {

    return res.status(400).json({
      error: 'Phone number and message are required.'
    });

  }

  if (!sock || !isConnected) {

    return res.status(503).json({
      error: 'WhatsApp is not connected.'
    });

  }

  try {

    const recipient = String(to).includes('@')
      ? String(to)
      : `${String(to).replace(/\D/g, '')}@s.whatsapp.net`;

    await sock.sendMessage(recipient, {
      text: String(message)
    });

    res.json({
      success: true
    });

  } catch (error) {

    res.status(500).json({
      error: error.message
    });

  }

});

// =====================================================
// START SERVER
// =====================================================

const server = app.listen(config.port, '0.0.0.0', () => {

  console.log('================================');
  console.log('WHATSAPP AI BOT SERVER STARTED');
  console.log(`Port: ${config.port}`);
  console.log('================================');

});

// =====================================================
// CONNECT TO MONGODB AND RESTORE SESSION
// =====================================================

async function initialize() {

  if (!config.mongoURI) {

    console.error('MONGODB_URI is missing from environment variables.');

    return;

  }

  if (!config.geminiKey) {

    console.error('GEMINI_API_KEY is missing.');

  }

  try {

    mongoClient = new MongoClient(config.mongoURI, {
      serverSelectionTimeoutMS: 15000,
      connectTimeoutMS: 15000,
      retryWrites: true
    });

    await mongoClient.connect();

    const db = mongoClient.db(config.database);

    authCollection = db.collection('whatsapp_auth');

    historyCollection = db.collection('chat_history');

    mongoConnected = true;

    console.log('MongoDB connected successfully.');

    // Restore WhatsApp session from MongoDB
    await connectToWhatsApp();

  } catch (error) {

    mongoConnected = false;

    console.error('MongoDB connection error:', error.message);

    setTimeout(initialize, 10000);

  }

}

// =====================================================
// GRACEFUL SHUTDOWN
// =====================================================

async function shutdown(signal) {

  console.log(`${signal} received. Shutting down...`);

  clearTimeout(reconnectTimer);

  try {

    if (sock) {
      sock.end(undefined);
    }

    if (mongoClient) {
      await mongoClient.close();
    }

    server.close(() => {
      process.exit(0);
    });

  } catch (error) {

    console.error('Shutdown error:', error.message);

    process.exit(1);

  }

}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// Start initialization
initialize();
