
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
  port: process.env.PORT || 3000,

  mongoUri: process.env.MONGODB_URI,
  mongoDatabase: process.env.MONGODB_DB_NAME || 'whatsapp_bot',
  authId: process.env.WHATSAPP_AUTH_ID || 'main',

  geminiKey: process.env.GEMINI_API_KEY,
  geminiModel: process.env.GEMINI_MODEL || 'gemini-3.8-flash',

  botName: process.env.BOT_NAME || 'Smart Assistant',

  personality:
    process.env.BOT_PERSONALITY ||
    'You are a helpful, intelligent, friendly and accurate WhatsApp assistant. Give natural, conversational answers. Understand English, Kiswahili and common Kenyan expressions. Keep simple replies short and useful.',

  maxHistory: Number(process.env.MAX_HISTORY_MESSAGES || 10),

  maxTokens: Number(process.env.OPENAI_MAX_TOKENS || 500),

  temperature: Number(process.env.OPENAI_TEMPERATURE || 0.7)
};

// =====================================================
// GLOBAL VARIABLES
// =====================================================

const app = express();

app.use(express.json({ limit: '1mb' }));

const historyCache = new NodeCache({
  stdTTL: 86400,
  checkperiod: 600
});

const logger = pino({ level: 'silent' });

const mongoClient = new MongoClient(config.mongoUri || '', {
  serverSelectionTimeoutMS: 10000,
  connectTimeoutMS: 10000,
  maxPoolSize: 10
});

let db = null;
let authCollection = null;

let sock = null;

let isConnected = false;
let isConnecting = false;
let mongoConnected = false;

let latestQRDataUrl = null;
let pairingCode = null;

let connectionState = 'starting';
let reconnectTimer = null;
let reconnectAttempts = 0;

// =====================================================
// GEMINI AI CONFIGURATION
// =====================================================

const aiClient = config.geminiKey
  ? new OpenAI({
      apiKey: config.geminiKey,
      baseURL:
        'https://generativelanguage.googleapis.com/v1beta/openai/',
      timeout: 30000,
      maxRetries: 2
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
  const result = await authCollection.findOne({
    _id: `${config.authId}:${id}`
  });

  return result ? deserialize(result.value) : null;
}

async function useMongoDBAuthState() {
  const storedCreds = await readMongoData('creds');

  const creds = storedCreds || initAuthCreds();

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
// AI REPLY GENERATION
// =====================================================

async function generateReply(chatId, userMessage) {
  if (!userMessage || !aiClient) {
    return "⚠️ I'm having trouble thinking right now. Please try again.";
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
      throw new Error('Gemini returned an empty response');
    }

    history.push({
      role: 'user',
      content: userMessage
    });

    history.push({
      role: 'assistant',
      content: reply
    });

    historyCache.set(
      chatId,
      history.slice(-config.maxHistory * 2)
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

function scheduleReconnect(delay = 4000) {
  if (reconnectTimer) return;

  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectToWhatsApp();
  }, delay);
}

async function connectToWhatsApp() {
  if (isConnecting || isConnected) return;

  isConnecting = true;
  connectionState = 'connecting';

  try {
    if (!mongoConnected) {
      throw new Error('MongoDB is not connected');
    }

    console.log('Restoring WhatsApp session from MongoDB...');

    const {
      state,
      saveCreds
    } = await useMongoDBAuthState();

    sock = makeWASocket({
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

    sock.ev.on('creds.update', async () => {
      try {
        await saveCreds();
      } catch (error) {
        console.error('Credential save error:', error.message);
      }
    });

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

          console.log('WhatsApp QR code generated.');
        } catch (error) {
          console.error('QR generation error:', error.message);
        }
      }

      if (connection === 'connecting') {
        connectionState = 'connecting';
        console.log('Connecting to WhatsApp...');
      }

      if (connection === 'open') {
        isConnected = true;
        connectionState = 'open';

        reconnectAttempts = 0;

        latestQRDataUrl = null;
        pairingCode = null;

        console.log('================================');
        console.log('WHATSAPP BOT IS ONLINE!');
        console.log('MongoDB session restored.');
        console.log('================================');
      }

      if (connection === 'close') {
        isConnected = false;
        connectionState = 'disconnected';

        latestQRDataUrl = null;
        pairingCode = null;

        const statusCode =
          lastDisconnect?.error?.output?.statusCode;

        console.log('WhatsApp connection closed:', statusCode);

        sock = null;

        if (statusCode === DisconnectReason.loggedOut) {
          console.log(
            'WhatsApp session logged out. Preparing fresh login.'
          );

          try {
            await authCollection.deleteMany({
              authId: config.authId
            });

            console.log('Old authentication data cleared.');

            connectionState = 'needs_pairing';

            scheduleReconnect(3000);

          } catch (error) {
            console.error(
              'Could not reset authentication:',
              error.message
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

          console.log(
            `Reconnecting in ${delay / 1000} seconds...`
          );

          scheduleReconnect(delay);
        }
      }
    });

    // Receive incoming WhatsApp messages
    sock.ev.on('messages.upsert', async event => {
      if (event.type !== 'notify') return;

      for (const msg of event.messages) {
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

          if (!userMessage || !userMessage.trim()) continue;

          console.log(
            `Incoming message from ${chatId}: ${userMessage.slice(0, 80)}`
          );

          const reply = await generateReply(
            chatId,
            userMessage.trim()
          );

          if (sock && isConnected) {
            await sock.sendMessage(chatId, {
              text: reply
            });

            console.log('AI reply sent successfully.');
          }

        } catch (error) {
          console.error(
            'Message processing error:',
            error.message
          );
        }
      }
    });

    isConnecting = false;

  } catch (error) {
    isConnecting = false;

    console.error(
      'WhatsApp startup error:',
      error.message
    );

    connectionState = 'reconnecting';

    sock = null;

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

  res.redirect('/qr');
});

// =====================================================
// HEALTH CHECK
// =====================================================

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    bot: config.botName,
    aiProvider: 'Google Gemini',
    aiModel: config.geminiModel,
    aiConfigured: !!aiClient,
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
    qrPending: !!latestQRDataUrl,
    qr: latestQRDataUrl,
    pairingCode
  });
});

// =====================================================
// WHATSAPP LOGIN PAGE
// BOTH QR AND PHONE NUMBER
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
        <h1 style="color:#25d366">✅ WhatsApp Connected!</h1>
        <h3>Your AI bot is online.</h3>
        <p>You can close this page.</p>
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

// Automatically update the login page
// without refreshing the whole page.

async function updateStatus() {

  try {

    const response = await fetch('/status');

    const data = await response.json();

    document.getElementById('status').innerText =
      data.connected
        ? 'WhatsApp Connected!'
        : 'WhatsApp: ' + data.state;

    document.getElementById('mongo').innerText =
      'MongoDB: ' + (data.mongoConnected ? 'Connected' : 'Disconnected');

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

    console.log('Pairing code generated.');

    return res.json({
      success: true,
      code: pairingCode
    });

  } catch(error) {

    console.error('Pairing code error:', error.message);

    return res.status(500).json({
      error: 'Could not generate pairing code. Please try again.'
    });

  }
});

// =====================================================
// SEND MESSAGE API
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

  try {

    const phone = String(to).replace(/\D/g, '');

    if (!/^\d{10,15}$/.test(phone)) {
      return res.status(400).json({
        error: 'Invalid phone number.'
      });
    }

    await sock.sendMessage(
      `${phone}@s.whatsapp.net`,
      {
        text: String(message)
      }
    );

    res.json({
      success: true,
      message: 'Message sent successfully.'
    });

  } catch(error) {

    res.status(500).json({
      error: error.message
    });

  }
});

// =====================================================
// START SERVER
// =====================================================

app.listen(config.port, '0.0.0.0', () => {

  console.log('================================');
  console.log('WHATSAPP AI CHATBOT SERVER');
  console.log('================================');

  console.log(`Server running on port ${config.port}`);

  console.log(`AI Model: ${config.geminiModel}`);

});

// =====================================================
// START MONGODB AND WHATSAPP
// =====================================================

async function startBot() {

  try {

    if (!config.mongoUri) {
      throw new Error('MONGODB_URI is missing.');
    }

    if (!config.geminiKey) {
      console.warn('GEMINI_API_KEY is missing. AI replies will not work.');
    }

    console.log('Connecting to MongoDB...');

    await mongoClient.connect();

    db = mongoClient.db(config.mongoDatabase);

    authCollection = db.collection('whatsapp_auth');

    await authCollection.createIndex({
      authId: 1
    });

    mongoConnected = true;

    console.log('MongoDB connected successfully.');

    const existingCreds = await readMongoData('creds');

    if (existingCreds && existingCreds.registered) {
      console.log('Saved WhatsApp credentials found.');
    } else {
      console.log('New WhatsApp login required.');
    }

    await connectToWhatsApp();

  } catch(error) {

    console.error('BOT STARTUP ERROR:', error.message);

    mongoConnected = false;

    process.exit(1);

  }

}

startBot();

// =====================================================
// GRACEFUL SHUTDOWN
// =====================================================

async function shutdown() {

  console.log('Shutting down chatbot...');

  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
  }

  try {
    if (sock) {
      sock.end(undefined);
    }

    if (mongoConnected) {
      await mongoClient.close();
    }

  } catch(error) {
    console.error('Shutdown error:', error.message);
  }

  process.exit(0);

}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
