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
  makeCacheableSignalKeyStore
} = baileys;

// ======================================================
// 1. CONFIGURATION
// ======================================================
const config = {
  port: process.env.PORT || 3000,
  mongoUri: process.env.MONGODB_URI,
  mongoDb: process.env.MONGODB_DB || 'whatsapp_bot',
  geminiKey: process.env.GEMINI_API_KEY,
  geminiModel: process.env.GEMINI_MODEL || 'gemini-2.5-flash',
  maxTokens: Number(process.env.OPENAI_MAX_TOKENS || 1000),
  temperature: Number(process.env.OPENAI_TEMPERATURE || 0.7),
  botName: process.env.BOT_NAME || 'Smart Assistant',
  personality: process.env.BOT_PERSONALITY || 'You are a helpful, friendly, intelligent and accurate assistant. Answer naturally and clearly.',
  maxHistory: Number(process.env.MAX_HISTORY_MESSAGES || 10)
};

// ======================================================
// 2. LOGGER & AI & CACHE
// ======================================================
const logger = pino({ level: process.env.LOG_LEVEL || 'warn' });

const ai = new OpenAI({
  apiKey: config.geminiKey || 'missing-key',
  baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai/',
  timeout: 60000,
  maxRetries: 2
});

const historyCache = new NodeCache({ stdTTL: 3600, checkperiod: 600 });

// ======================================================
// 3. MONGODB SETUP
// ======================================================
const mongoClient = new MongoClient(config.mongoUri || 'mongodb://127.0.0.1:27017', {
  serverSelectionTimeoutMS: 10000,
  connectTimeoutMS: 10000,
  maxPoolSize: 10,
  retryWrites: true
});

let db;
let authCollection;
let mongoReady = false;

// ======================================================
// 4. WHATSAPP STATE
// ======================================================
let sock = null;
let authState = null;
let isConnected = false;
let isConnecting = false;
let pairingCode = null;
let pairingReady = false;
let pairingInProgress = false;
let latestQRDataUrl = null;
let reconnectTimer = null;
let reconnectAttempts = 0;
let lastConnectionError = null;
let lastConnectedAt = null;
let connectionStatus = 'starting';
let socketGeneration = 0;

// ======================================================
// 5. EXPRESS
// ======================================================
const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(__dirname));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ======================================================
// 6. MONGODB CONNECTION & AUTH STORAGE
// ======================================================
async function connectMongo() {
  if (mongoReady) return;
  if (!config.mongoUri) throw new Error('MONGODB_URI is missing.');

  console.log('Connecting to MongoDB...');
  await mongoClient.connect();
  db = mongoClient.db(config.mongoDb);
  authCollection = db.collection('baileys_auth');
  mongoReady = true;
  console.log('MONGODB CONNECTED SUCCESSFULLY');
}

async function createMongoAuthState(collection) {
  async function readData(id) {
    const document = await collection.findOne({ _id: id });
    if (!document || !document.value) return null;
    return JSON.parse(document.value, BufferJSON.reviver);
  }

  async function writeData(id, value) {
    await collection.updateOne(
      { _id: id },
      { $set: { value: JSON.stringify(value, BufferJSON.replacer), updatedAt: new Date() } },
      { upsert: true }
    );
  }

  const creds = (await readData('creds')) || initAuthCreds();

  const keys = {
    get: async (type, ids) => {
      const result = {};
      if (!ids.length) return result;
      const documents = await collection.find({ _id: { $in: ids.map(id => `${type}-${id}`) } }).toArray();
      const stored = new Map(documents.map(document => [document._id, document.value]));
      for (const id of ids) {
        const value = stored.get(`${type}-${id}`);
        let data = value ? JSON.parse(value, BufferJSON.reviver) : null;
        if (type === 'app-state-sync-key' && data) {
          data = proto.Message.AppStateSyncKeyData.fromObject(data);
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
                filter: { _id: key },
                update: { $set: { value: JSON.stringify(value, BufferJSON.replacer), updatedAt: new Date() } },
                upsert: true
              }
            });
          } else {
            operations.push({ deleteOne: { filter: { _id: key } } });
          }
        }
      }
      if (operations.length) {
        await collection.bulkWrite(operations, { ordered: false });
      }
    }
  };

  async function saveCreds() {
    await writeData('creds', creds);
  }

  if (!(await collection.findOne({ _id: 'creds' }))) {
    await saveCreds();
  }

  return { state: { creds, keys }, saveCreds };
}

// ======================================================
// 7. GEMINI AI & PHONE VALIDATION
// ======================================================
async function generateReply(chatId, userMessage) {
  if (!userMessage) return null;
  if (!config.geminiKey) {
    console.error('GEMINI API KEY MISSING');
    return "⚠️ I'm having trouble thinking right now. Please try again.";
  }

  let history = historyCache.get(chatId) || [];
  history.push({ role: 'user', content: userMessage });

  const messages = [{ role: 'system', content: config.personality }, ...history];

  try {
    console.log('GEMINI REQUEST:', config.geminiModel);
    const response = await ai.chat.completions.create({
      model: config.geminiModel,
      messages,
      max_tokens: config.maxTokens,
      temperature: config.temperature
    });

    const reply = response.choices?.[0]?.message?.content;
    if (!reply || typeof reply !== 'string') throw new Error('Empty Gemini response');

    history.push({ role: 'assistant', content: reply });
    historyCache.set(chatId, history.slice(-config.maxHistory * 2));
    console.log('GEMINI REPLY GENERATED');
    return reply;
  } catch (error) {
    console.error('GEMINI ERROR:', { message: error.message, status: error.status, model: config.geminiModel });
    history.pop();
    historyCache.set(chatId, history.slice(-config.maxHistory * 2));
    return "⚠️ I'm having trouble thinking right now. Please try again.";
  }
}

function normalizePhone(input) {
  let phone = String(input || '').replace(/\D/g, '');
  if (phone.startsWith('0') && phone.length === 10) phone = '254' + phone.substring(1);
  if (/^254[17]\d{8}$/.test(phone)) return phone;
  if (/^[1-9]\d{7,14}$/.test(phone)) return phone;
  return null;
}

// ======================================================
// 8. ROUTES (Health, Status, QR, Pairing, Send)
// ======================================================
app.get('/health', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({
    status: 'ok',
    bot: config.botName,
    aiProvider: 'Google Gemini',
    aiModel: config.geminiModel,
    aiConfigured: !!config.geminiKey,
    mongodbReady: mongoReady,
    whatsappReady: isConnected,
    whatsappStatus: connectionStatus,
    pairingReady,
    qrPending: !!latestQRDataUrl,
    lastConnectedAt,
    lastConnectionError,
    reconnectAttempts
  });
});

app.get('/status', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({
    connected: isConnected,
    connecting: isConnecting,
    mongodb: mongoReady,
    status: connectionStatus,
    bot: config.botName,
    ai: 'Google Gemini',
    model: config.geminiModel
  });
});

app.get('/qr', (req, res) => {
  if (isConnected) {
    return res.send(`
      <!DOCTYPE html><html><head><title>Connected</title><meta name="viewport" content="width=device-width, initial-scale=1"></head>
      <body style="margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#f0f2f5;font-family:Arial;">
        <div style="background:white;padding:30px;border-radius:15px;text-align:center;">
          <h2 style="color:#25d366">✅ WhatsApp Connected!</h2>
          <p>Your chatbot is online.</p>
          <p>MongoDB: Connected</p>
          <p>Gemini AI: Ready</p>
        </div>
      </body></html>
    `);
  }

  let contentHtml = '';
  if (pairingCode) {
    contentHtml = `
      <h2 style="color:#075e54">Your Pairing Code</h2>
      <div style="font-size:clamp(40px,10vw,75px);font-weight:900;color:#128c7e;letter-spacing:5px;margin:25px 0;">${pairingCode}</div>
      <div style="background:white;padding:20px;border-radius:12px;text-align:left;line-height:2;">
        1. Open WhatsApp.<br>2. Go to Linked Devices.<br>3. Tap Link a Device.<br>4. Choose Link with phone number instead.<br>5. Enter the code above.
      </div>
    `;
  } else if (latestQRDataUrl) {
    contentHtml = `
      <h2 style="color:#075e54">Scan with WhatsApp</h2>
      <img src="${latestQRDataUrl}" style="width:75vw;max-width:400px;border:10px solid white;border-radius:15px;">
    `;
  } else {
    contentHtml = `
      <h2 style="color:#667781">⏳ Starting WhatsApp...</h2>
      <p id="connectionMessage">Status: ${connectionStatus}</p>
      <p>MongoDB: ${mongoReady ? 'Connected' : 'Connecting...'}</p>
    `;
  }

  // ONLY show input if not connected, not waiting for code, AND mongo is ready/socket exists
  const showInput = !pairingCode && !isConnected && sock && pairingReady;

  res.send(`
    <!DOCTYPE html><html><head><title>WhatsApp Login</title><meta name="viewport" content="width=device-width, initial-scale=1"></head>
    <body style="margin:0;padding:20px;min-height:100vh;box-sizing:border-box;display:flex;align-items:center;justify-content:center;background:#f0f2f5;font-family:Arial;">
      <div style="width:100%;max-width:500px;text-align:center;">
        ${contentHtml}
        ${showInput ? `
          <div style="margin-top:30px;padding:25px;background:white;border-radius:15px;box-sizing:border-box;">
            <h2 style="color:#075e54">Login with Phone Number</h2>
            <p style="color:#667781">Enter your WhatsApp number with country code.</p>
            <input id="phone" type="tel" placeholder="254712345678" style="width:100%;box-sizing:border-box;padding:15px;border:2px solid #ccc;border-radius:8px;font-size:18px;margin-bottom:15px;">
            <button id="getCode" onclick="getPairingCode()" style="width:100%;padding:16px;background:#25d366;color:white;border:0;border-radius:8px;font-size:18px;font-weight:bold;">Get Pairing Code</button>
            <p id="message"></p>
          </div>
          <script>
            async function getPairingCode() {
              const phone = document.getElementById('phone').value.trim();
              const button = document.getElementById('getCode');
              const message = document.getElementById('message');
              if (!phone) return alert('Enter your WhatsApp number');
              button.disabled = true;
              button.innerText = 'Generating...';
              try {
                const response = await fetch('/request-pairing?phone=' + encodeURIComponent(phone));
                const data = await response.json();
                if (!response.ok) throw new Error(data.error || 'Pairing failed');
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
            const response = await fetch('/status', { cache: 'no-store' });
            const data = await response.json();
            const message = document.getElementById('connectionMessage');
            if (data.connected) {
              window.location.reload();
            } else if (message) {
              message.innerText = 'WhatsApp status: ' + data.status;
            }
            // Force a reload if the socket is ready but the page hasn't refreshed yet
            if (data.status === 'connecting' && !document.getElementById('phone') && !data.connected) {
               window.location.reload();
            }
          } catch (error) {}
        }
        setInterval(checkStatus, 3000);
      </script>
    </body></html>
  `);
});

app.get('/request-pairing', async (req, res) => {
  const phone = normalizePhone(req.query.phone);
  if (!phone) return res.status(400).json({ error: 'Invalid phone number. Include country code.' });
  if (!mongoReady || !sock || !authState) return res.status(503).json({ error: 'WhatsApp is not initialized yet.' });
  if (isConnected) return res.status(409).json({ error: 'WhatsApp is already connected.' });
  if (authState.creds.registered) return res.status(409).json({ error: 'A saved WhatsApp session exists. Check connection status.' });
  if (pairingInProgress) return res.status(409).json({ error: 'A pairing request is already running.' });

  pairingInProgress = true;
  try {
    console.log('REQUESTING WHATSAPP PAIRING CODE');
    const code = await sock.requestPairingCode(phone);
    pairingCode = code.match(/.{1,4}/g)?.join('-') || code;
    latestQRDataUrl = null;
    res.json({ success: true, code: pairingCode });
  } catch (error) {
    console.error('PAIRING ERROR:', error.message);
    res.status(500).json({ error: error.message });
  } finally {
    pairingInProgress = false;
  }
});

app.post('/send', async (req, res) => {
  const { to, message } = req.body;
  if (!sock || !isConnected) return res.status(503).json({ error: 'WhatsApp is not connected.' });
  if (!to || !message) return res.status(400).json({ error: 'Phone number and message required.' });

  const phone = normalizePhone(to);
  if (!phone) return res.status(400).json({ error: 'Invalid phone number.' });

  try {
    await sock.sendMessage(`${phone}@s.whatsapp.net`, { text: String(message) });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ======================================================
// 9. CONNECTION & RECONNECTION LOGIC
// ======================================================
function scheduleReconnect() {
  if (reconnectTimer || isConnected) return;
  reconnectAttempts++;
  const delay = Math.min(3000 * Math.pow(2, reconnectAttempts - 1), 30000);
  connectionStatus = 'reconnecting';
  console.log(`WHATSAPP RECONNECTING IN ${delay / 1000} SECONDS`);
  reconnectTimer = setTimeout(async () => {
    reconnectTimer = null;
    try {
      await connectToWhatsApp();
    } catch (error) {
      console.error('RECONNECT ERROR:', error.message);
      scheduleReconnect();
    }
  }, delay);
}

async function connectToWhatsApp() {
  if (isConnecting || isConnected) return;
  if (!mongoReady || !authCollection) {
    console.log('WAITING FOR MONGODB');
    return;
  }

  isConnecting = true;
  connectionStatus = 'connecting';
  const generation = ++socketGeneration;
  let currentSock = null;

  try {
    console.log('RESTORING WHATSAPP SESSION FROM MONGODB');
    const mongoAuth = await createMongoAuthState(authCollection);
    authState = mongoAuth.state;

    if (generation !== socketGeneration) return;

    const cachedKeys = makeCacheableSignalKeyStore(authState.keys, logger);
    console.log(authState.creds.registered ? 'SAVED SESSION FOUND' : 'NEW WHATSAPP SESSION');

    currentSock = makeWASocket({
      auth: { creds: authState.creds, keys: cachedKeys },
      logger,
      printQRInTerminal: false,
      browser: ['Ubuntu', 'Chrome', '20.0.04'],
      markOnlineOnConnect: false,
      syncFullHistory: false
    });

    sock = currentSock;
    isConnecting = false;

    currentSock.ev.on('creds.update', async () => {
      try {
        await mongoAuth.saveCreds();
        console.log('AUTHENTICATION SAVED TO MONGODB');
      } catch (error) {
        console.error('CREDENTIAL SAVE ERROR:', error.message);
      }
    });

    currentSock.ev.on('connection.update', async update => {
      if (currentSock !== sock || generation !== socketGeneration) return;
      const { connection, lastDisconnect, qr } = update;

      if (qr && !authState.creds.registered) {
        pairingReady = true;
        try {
          latestQRDataUrl = await QRCode.toDataURL(qr, { width: 500, margin: 1 });
          console.log('WHATSAPP QR GENERATED');
        } catch (error) {
          console.error('QR ERROR:', error.message);
        }
      }

      if (connection === 'connecting') {
        connectionStatus = 'connecting';
        pairingReady = true;
        console.log('WHATSAPP CONNECTING...');
      }

      if (connection === 'open') {
        isConnected = true;
        isConnecting = false;
        pairingReady = false;
        pairingCode = null;
        latestQRDataUrl = null;
        reconnectAttempts = 0;
        lastConnectionError = null;
        lastConnectedAt = new Date().toISOString();
        connectionStatus = 'connected';

        if (reconnectTimer) {
          clearTimeout(reconnectTimer);
          reconnectTimer = null;
        }

        try {
          await mongoAuth.saveCreds();
        } catch (error) {
          console.error('INITIAL CREDENTIAL SAVE ERROR:', error.message);
        }

        console.log('================================');
        console.log('WHATSAPP CONNECTED SUCCESSFULLY');
        console.log('================================');
      }

      if (connection === 'close') {
        isConnected = false;
        isConnecting = false;
        pairingReady = false;
        pairingCode = null;
        latestQRDataUrl = null;

        if (sock === currentSock) sock = null;

        const statusCode = lastDisconnect?.error?.output?.statusCode;
        lastConnectionError = lastDisconnect?.error?.message || String(statusCode || 'Unknown error');
        const loggedOut = statusCode === DisconnectReason.loggedOut;
        const replaced = statusCode === DisconnectReason.connectionReplaced;

        console.error('WHATSAPP DISCONNECTED. STATUS:', statusCode, 'REASON:', lastConnectionError);

        if (loggedOut) {
          connectionStatus = 'logged_out';
        } else if (replaced) {
          connectionStatus = 'connection_replaced';
        } else {
          connectionStatus = 'disconnected';
          scheduleReconnect();
        }
      }
    });

    currentSock.ev.on('messages.upsert', async event => {
      if (event.type !== 'notify') return;
      for (const msg of event.messages) {
        try {
          if (!msg.message || msg.key.fromMe) continue;
          const chatId = msg.key.remoteJid;
          if (!chatId || chatId === 'status@broadcast' || chatId.endsWith('@newsletter')) continue;

          const userMessage = msg.message.conversation || msg.message.extendedTextMessage?.text || msg.message.imageMessage?.caption || msg.message.videoMessage?.caption || msg.message.documentMessage?.caption;
          if (!userMessage || !userMessage.trim()) continue;

          console.log('INCOMING MESSAGE:', chatId);
          const reply = await generateReply(chatId, userMessage.trim());

          if (reply && isConnected && sock === currentSock) {
            await currentSock.sendMessage(chatId, { text: reply });
            console.log('AI REPLY SENT');
          }
        } catch (error) {
          console.error('MESSAGE ERROR:', error.message);
        }
      }
    });

  } catch (error) {
    isConnecting = false;
    isConnected = false;
    connectionStatus = 'error';
    lastConnectionError = error.message;
    console.error('WHATSAPP START ERROR:', error);
    
    if (generation === socketGeneration) {
      if (currentSock) {
        try { currentSock.end(error); } catch (_) {}
      }
      sock = null;
      scheduleReconnect();
    }
  }
}

// ======================================================
// 10. START & SHUTDOWN
// ======================================================
let mongoRetryTimer = null;
async function retryMongo() {
  if (mongoReady) return;
  try {
    await connectMongo();
    console.log('MONGODB RESTORED');
    if (mongoRetryTimer) {
      clearTimeout(mongoRetryTimer);
      mongoRetryTimer = null;
    }
    await connectToWhatsApp();
  } catch (error) {
    console.error('MONGODB ERROR:', error.message);
    if (!mongoRetryTimer) {
      mongoRetryTimer = setTimeout(() => {
        mongoRetryTimer = null;
        retryMongo();
      }, 15000);
    }
  }
}

async function startApplication() {
  app.listen(config.port, '0.0.0.0', () => {
    console.log('================================');
    console.log('WHATSAPP BOT SERVER STARTED');
    console.log('PORT:', config.port);
    console.log('AI:', config.geminiModel);
    console.log('================================');
  });

  if (!config.geminiKey) console.error('GEMINI_API_KEY IS MISSING');

  try {
    await connectMongo();
    await connectToWhatsApp();
  } catch (error) {
    console.error('INITIALIZATION ERROR:', error.message);
    retryMongo();
  }
}

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log('SERVER SHUTTING DOWN');
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  if (mongoRetryTimer) { clearTimeout(mongoRetryTimer); mongoRetryTimer = null; }
  try {
    if (sock) { sock.end(undefined); sock = null; }
    await mongoClient.close();
  } catch (error) {
    console.error('SHUTDOWN ERROR:', error.message);
  }
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

startApplication().catch(error => {
  console.error('FATAL APPLICATION ERROR:', error);
});
