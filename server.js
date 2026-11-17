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

// =====================================================
// CONFIGURATION
// =====================================================

const app = express();
app.use(express.json({ limit: '2mb' }));

const PORT = process.env.PORT || 10000;
const MONGODB_URI = process.env.MONGODB_URI;
const DB_NAME = process.env.MONGODB_DB_NAME || 'whatsapp_bot';
const AUTH_ID = process.env.WHATSAPP_AUTH_ID || 'main';

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite';
const GEMINI_FALLBACK_MODEL = process.env.GEMINI_FALLBACK_MODEL || 'gemini-3.8-flash';
const GEMINI_TIMEOUT = Number(process.env.GEMINI_TIMEOUT_MS) || 120000;
const GEMINI_MAX_TOKENS = Number(process.env.GEMINI_MAX_OUTPUT_TOKENS) || 2048;

const SYSTEM_PROMPT =
  process.env.BOT_SYSTEM_PROMPT ||
  'You are a helpful and intelligent WhatsApp AI assistant. Answer naturally, politely and accurately. Keep replies clear and suitable for WhatsApp.';

const logger = pino({ level: 'silent' });

const seenMessages = new NodeCache({ stdTTL: 3600, checkperiod: 600 });

const mongoClient = MONGODB_URI ? new MongoClient(MONGODB_URI) : null;

// =====================================================
// GLOBAL STATE
// =====================================================

let authCollection = null;
let mongoConnected = false;
let whatsappSocket = null;
let whatsappConnected = false;
let whatsappState = 'disconnected';
let qrCodeData = null;
let startingWhatsApp = false;
let resettingAuth = false;
let pairingInProgress = false;
let reconnectTimer = null;

// =====================================================
// LOGGING
// =====================================================

function logInfo(event, message, extra = {}) {
  console.log(JSON.stringify({ level: 'INFO', event, message, ...extra, time: new Date().toISOString() }));
}

function logWarn(event, message, extra = {}) {
  console.warn(JSON.stringify({ level: 'WARN', event, message, ...extra, time: new Date().toISOString() }));
}

function logError(event, message, err) {
  console.error(JSON.stringify({ level: 'ERROR', event, message, error: err?.message || String(err), time: new Date().toISOString() }));
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// =====================================================
// MONGODB
// =====================================================

async function connectMongoDB() {
  if (!MONGODB_URI || !mongoClient) {
    throw new Error('MONGODB_URI is missing.');
  }
  await mongoClient.connect();
  const db = mongoClient.db(DB_NAME);
  authCollection = db.collection('whatsapp_auth');
  mongoConnected = true;
  logInfo('MONGODB_CONNECTED', 'MongoDB connected successfully.');
}

// =====================================================
// MONGODB WHATSAPP AUTH STORAGE
// =====================================================

function deserializeAuthValue(value) {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return JSON.parse(value, BufferJSON.reviver);
  return JSON.parse(JSON.stringify(value), BufferJSON.reviver);
}

async function useMongoDBAuthState() {
  if (!authCollection) throw new Error('MongoDB authentication storage is unavailable.');

  const credsId = AUTH_ID + ':creds';
  const storedCreds = await authCollection.findOne({ _id: credsId });
  let creds;

  if (storedCreds) {
    creds = deserializeAuthValue(storedCreds.data ?? storedCreds.creds);
  } else {
    creds = initAuthCreds();
  }

  const saveCreds = async () => {
    await authCollection.updateOne(
      { _id: credsId },
      { $set: { data: JSON.stringify(creds, BufferJSON.replacer), updatedAt: new Date() } },
      { upsert: true }
    );
  };

  const keys = {
    get: async (type, ids) => {
      const result = {};
      if (!ids || ids.length === 0) return result;

      const prefix = AUTH_ID + ':' + type + ':';
      const documentIds = ids.map(id => prefix + id);

      const documents = await authCollection.find({ _id: { $in: documentIds } }).toArray();

      for (const document of documents) {
        const id = document._id.substring(prefix.length);
        const storedValue = document.data ?? document.value;
        if (storedValue === undefined) continue;

        let value = deserializeAuthValue(storedValue);
        if (type === 'app-state-sync-key') {
          value = proto.Message.AppStateSyncKeyData.fromObject(value);
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
          const documentId = AUTH_ID + ':' + category + ':' + id;
          if (value === null || value === undefined) {
            operations.push({ deleteOne: { filter: { _id: documentId } } });
          } else {
            operations.push({
              updateOne: {
                filter: { _id: documentId },
                update: { $set: { data: JSON.stringify(value, BufferJSON.replacer), updatedAt: new Date() } },
                upsert: true
              }
            });
          }
        }
      }
      if (operations.length > 0) {
        await authCollection.bulkWrite(operations, { ordered: false });
      }
    }
  };

  return { state: { creds, keys }, saveCreds };
}

// =====================================================
// GEMINI AI
// =====================================================

async function callGemini(model, prompt) {
  if (!GEMINI_API_KEY) throw new Error('GEMINI_API_KEY is missing.');

  const url = 'https://generativelanguage.googleapis.com/v1beta/models/' + encodeURIComponent(model) + ':generateContent?key=' + encodeURIComponent(GEMINI_API_KEY);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), GEMINI_TIMEOUT);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { maxOutputTokens: GEMINI_MAX_TOKENS }
      })
    });

    const responseText = await response.text();
    let data;

    try {
      data = JSON.parse(responseText);
    } catch {
      throw new Error('Invalid Gemini response. HTTP ' + response.status);
    }

    if (!response.ok) {
      throw new Error('Gemini HTTP ' + response.status + ': ' + (data?.error?.message || responseText));
    }

    const answer = data?.candidates?.[0]?.content?.parts?.map(part => part.text || '').join('').trim();
    if (!answer) throw new Error('Gemini returned an empty response using ' + model);

    return answer;
  } finally {
    clearTimeout(timeout);
  }
}

async function askGemini(prompt) {
  const models = [GEMINI_MODEL, GEMINI_FALLBACK_MODEL].filter((model, index, array) => model && array.indexOf(model) === index);
  let lastError;

  for (const model of models) {
    try {
      logInfo('GEMINI_REQUEST', 'Sending request to ' + model);
      const answer = await callGemini(model, prompt);
      logInfo('GEMINI_SUCCESS', 'Gemini responded using ' + model);
      return answer;
    } catch (err) {
      lastError = err;
      logError('GEMINI_MODEL_FAILED', 'Gemini model failed: ' + model, err);
    }
  }
  throw lastError || new Error('All Gemini models failed.');
}

// =====================================================
// MESSAGE EXTRACTION
// =====================================================

function extractMessageText(message) {
  if (!message) return '';
  let content = message;
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

// =====================================================
// INCOMING WHATSAPP MESSAGES
// =====================================================

async function handleIncomingMessage(socket, message) {
  try {
    if (!message || !message.message) return;
    if (message.key?.fromMe) return;

    const jid = message.key?.remoteJid;
    if (!jid || jid === 'status@broadcast') return;

    const messageId = message.key?.id;
    if (messageId && seenMessages.has(messageId)) return;
    if (messageId) seenMessages.set(messageId, true);

    const text = extractMessageText(message.message);
    if (!text) return;

    logInfo('WHATSAPP_MESSAGE', 'Incoming message received.', { sender: jid });

    const answer = await askGemini(text);
    if (!answer) return;

    if (socket !== whatsappSocket || !whatsappConnected) return;

    await socket.sendMessage(jid, { text: answer }, { quoted: message });
    logInfo('WHATSAPP_REPLY_SENT', 'AI reply sent successfully.', { recipient: jid });

  } catch (err) {
    logError('MESSAGE_HANDLER_ERROR', 'Could not process WhatsApp message.', err);
  }
}

// =====================================================
// START WHATSAPP
// =====================================================

async function startWhatsApp() {
  if (startingWhatsApp || resettingAuth) return;
  if (!authCollection) {
    logWarn('WHATSAPP_START', 'Waiting for MongoDB authentication storage.');
    return;
  }

  startingWhatsApp = true;

  try {
    whatsappState = 'connecting';
    logInfo('WHATSAPP_START', 'Starting WhatsApp socket.');

    // CRITICAL FIX: Hardcoded recent version to prevent silent pairing rejections
    // The dynamic fetcher was returning an outdated version (isLatest: false)
    const version = [2, 3000, 1043857760]; 
    logInfo('WA_VERSION', `Using forced WA v${version.join('.')}`);

    const { state, saveCreds } = await useMongoDBAuthState();

    const socket = makeWASocket({
      version, 
      auth: state,
      logger,
      printQRInTerminal: false,
      browser: ['Manny AI WhatsApp Bot', 'Chrome', '120.0.0'],
      markOnlineOnConnect: false,
      syncFullHistory: false,
      connectTimeoutMs: 60000,
      defaultQueryTimeoutMs: 60000,
      keepAliveIntervalMs: 25000
    });

    whatsappSocket = socket;

    socket.ev.on('creds.update', async () => {
      try {
        await saveCreds();
      } catch (err) {
        logError('AUTH_SAVE_ERROR', 'Could not save WhatsApp credentials.', err);
      }
    });

    // CONNECTION EVENTS
    socket.ev.on('connection.update', async update => {
      if (socket !== whatsappSocket) return;

      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        qrCodeData = qr;
        whatsappConnected = false;
        whatsappState = 'waiting_for_scan';
        logInfo('WHATSAPP_QR', 'New QR code generated. Pairing code can now be requested.');
      }

      if (connection === 'connecting') {
        whatsappState = 'connecting';
        logInfo('WHATSAPP_CONNECTING', 'Connecting to WhatsApp.');
      }

      if (connection === 'open') {
        whatsappConnected = true;
        whatsappState = 'connected';
        qrCodeData = null;
        pairingInProgress = false;
        logInfo('WHATSAPP_CONNECTED', 'WhatsApp connected successfully.');
      }

      if (connection === 'close') {
        whatsappConnected = false;
        whatsappState = 'disconnected';
        qrCodeData = null;
        pairingInProgress = false;

        const statusCode = lastDisconnect?.error?.output?.statusCode;
        logWarn('WHATSAPP_CLOSED', 'WhatsApp connection closed.', { statusCode });
        whatsappSocket = null;

        // AUTOMATIC 401 AUTHENTICATION RESET
        if (statusCode === DisconnectReason.loggedOut) {
          if (resettingAuth) return;
          resettingAuth = true;
          try {
            logWarn('WHATSAPP_LOGOUT', 'Invalid session detected. Resetting authentication.');
            const prefix = escapeRegex(AUTH_ID + ':');
            const result = await authCollection.deleteMany({ _id: { $regex: '^' + prefix } });
            logInfo('WHATSAPP_AUTH_RESET', 'Old authentication records cleared.', { deletedCount: result.deletedCount });
            await sleep(2000);
            resettingAuth = false;
            await startWhatsApp();
            return;
          } catch (err) {
            logError('WHATSAPP_AUTH_RESET_ERROR', 'Could not reset WhatsApp authentication.', err);
            resettingAuth = false;
            return;
          }
        }

        // AUTOMATIC RECONNECTION
        if (!reconnectTimer) {
          reconnectTimer = setTimeout(async () => {
            reconnectTimer = null;
            if (!whatsappSocket && !startingWhatsApp) {
              logInfo('WHATSAPP_RECONNECT', 'Attempting to reconnect WhatsApp.');
              await startWhatsApp();
            }
          }, 5000);
        }
      }
    });

    // INCOMING MESSAGES
    socket.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return;
      for (const message of messages) {
        await handleIncomingMessage(socket, message);
      }
    });

    logInfo('WHATSAPP_SOCKET_CREATED', 'WhatsApp socket created successfully.');

  } catch (err) {
    whatsappSocket = null;
    whatsappConnected = false;
    whatsappState = 'error';
    logError('WHATSAPP_START_ERROR', 'Could not start WhatsApp.', err);
  } finally {
    startingWhatsApp = false;
  }
}

// =====================================================
// HOMEPAGE
// =====================================================

app.get('/', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Manny AI WhatsApp Bot</title>
<style>
* { box-sizing: border-box; }
body { margin: 0; padding: 20px; background: #0b141a; color: white; font-family: Arial, sans-serif; }
.container { max-width: 500px; margin: 25px auto; }
.header { text-align: center; margin-bottom: 25px; }
.logo { font-size: 42px; }
h1 { color: #25d366; margin: 8px 0; }
.subtitle { color: #b7c5cc; line-height: 1.5; }
.card { background: #17252d; border: 1px solid #30434d; border-radius: 15px; padding: 22px; margin-bottom: 20px; }
.card h2 { font-size: 19px; margin-top: 0; }
.description { color: #b7c5cc; font-size: 14px; line-height: 1.6; }
input { width: 100%; padding: 15px; margin: 12px 0; border: 1px solid #45616d; border-radius: 9px; background: #0b141a; color: white; font-size: 17px; outline: none; }
input:focus { border-color: #25d366; }
button { width: 100%; padding: 15px; border: none; border-radius: 9px; background: #25d366; color: #062b17; font-size: 16px; font-weight: bold; cursor: pointer; margin-top: 8px; }
button:disabled { opacity: .6; cursor: not-allowed; }
.pairCode { font-size: 30px; letter-spacing: 5px; text-align: center; color: #25d366; background: #0b141a; padding: 20px; border-radius: 10px; margin: 15px 0; font-weight: bold; }
#pairResult { text-align: center; margin-top: 15px; overflow-wrap: anywhere; }
#qrImage { display: none; width: 100%; max-width: 270px; margin: 20px auto; background: white; padding: 10px; border-radius: 10px; }
#qrStatus { text-align: center; color: #25d366; margin-top: 15px; }
.statusRow { display: flex; justify-content: space-between; padding: 12px 0; border-bottom: 1px solid #30434d; }
.statusRow:last-child { border-bottom: none; }
.statusValue { color: #25d366; font-weight: bold; }
.instructions { color: #b7c5cc; font-size: 13px; line-height: 1.7; margin-top: 15px; }
footer { text-align: center; color: #82939c; font-size: 12px; padding: 20px; }
</style>
</head>
<body>
<div class="container">
  <div class="header">
    <div class="logo">🤖</div>
    <h1>Manny AI WhatsApp Bot</h1>
    <p class="subtitle">Connect your WhatsApp account to your AI assistant. Choose your preferred linking method below.</p>
  </div>

  <div class="card">
    <h2>📱 Link using phone number</h2>
    <p class="description">Enter the WhatsApp number you want to connect. Include your country code. For Kenya, use 2547XXXXXXXX. Do not include the plus sign.</p>
    <input type="tel" id="phone" placeholder="2547XXXXXXXX" autocomplete="tel">
    <button id="pairButton" onclick="generateCode()">Generate Pairing Code</button>
    <div id="pairResult"></div>
    <div class="instructions">
      1. Open WhatsApp on the phone you want to link.<br>
      2. Go to Linked Devices.<br>
      3. Select Link a Device.<br>
      4. Select Link with phone number instead.<br>
      5. Enter the pairing code displayed above.
    </div>
  </div>

  <div class="card">
    <h2>🔳 Link using QR code</h2>
    <p class="description">You can also connect by scanning the QR code using WhatsApp on your phone.</p>
    <div id="qrStatus">Waiting for QR code...</div>
    <img id="qrImage" alt="WhatsApp QR Code">
    <div class="instructions">
      1. Open WhatsApp.<br>
      2. Go to Linked Devices.<br>
      3. Select Link a Device.<br>
      4. Scan the QR code above.
    </div>
  </div>

  <div class="card">
    <h2>Connection status</h2>
    <div class="statusRow"><span>WhatsApp</span><span class="statusValue" id="waStatus">Checking...</span></div>
    <div class="statusRow"><span>MongoDB</span><span class="statusValue" id="mongoStatus">Checking...</span></div>
    <div class="statusRow"><span>Gemini AI</span><span class="statusValue" id="geminiStatus">Checking...</span></div>
  </div>

  <footer>Manny AI WhatsApp Bot</footer>
</div>

<script>
async function generateCode() {
  const phone = document.getElementById('phone').value.trim();
  const result = document.getElementById('pairResult');
  const button = document.getElementById('pairButton');

  if (!/^\\d{8,15}$/.test(phone)) {
    result.textContent = 'Enter a valid phone number with country code.';
    return;
  }

  button.disabled = true;
  button.textContent = 'Generating code...';
  result.textContent = 'Please wait...';

  try {
    const response = await fetch('/request-pairing', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone: phone })
    });

    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Pairing code generation failed.');

    result.innerHTML = '';
    const heading = document.createElement('p');
    heading.textContent = 'Your WhatsApp pairing code:';
    
    const code = document.createElement('div');
    code.className = 'pairCode';
    code.textContent = data.code;

    const copyButton = document.createElement('button');
    copyButton.textContent = 'Copy Pairing Code';
    copyButton.onclick = async function() {
      try {
        await navigator.clipboard.writeText(data.code);
        copyButton.textContent = 'Copied successfully!';
      } catch {
        copyButton.textContent = 'Please copy the code manually.';
      }
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

async function refreshStatus() {
  try {
    const response = await fetch('/status', { cache: 'no-store' });
    const data = await response.json();

    document.getElementById('waStatus').textContent = data.whatsappConnected ? 'Connected' : data.whatsappState;
    document.getElementById('mongoStatus').textContent = data.mongoConnected ? 'Connected' : 'Disconnected';
    document.getElementById('geminiStatus').textContent = data.geminiConfigured ? 'Configured' : 'Missing API Key';

    const qrImage = document.getElementById('qrImage');
    const qrStatus = document.getElementById('qrStatus');

    if (data.qrReady && !data.whatsappConnected) {
      qrImage.src = '/qr?t=' + Date.now();
      qrImage.style.display = 'block';
      qrStatus.textContent = 'Scan this QR code using WhatsApp.';
    } else {
      qrImage.style.display = 'none';
      qrStatus.textContent = data.whatsappConnected ? 'WhatsApp is already connected.' : 'Waiting for QR code...';
    }
  } catch (error) {
    console.error('Status error:', error);
  }
}

refreshStatus();
setInterval(refreshStatus, 5000);
</script>
</body>
</html>`);
});

// =====================================================
// HEALTH CHECK
// =====================================================

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

// =====================================================
// STATUS API
// =====================================================

app.get('/status', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
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

// =====================================================
// QR CODE API
// =====================================================

app.get('/qr', async (req, res) => {
  try {
    if (!qrCodeData) {
      return res.status(404).send('QR code is not available. Wait for a new QR code.');
    }
    const image = await QRCode.toBuffer(qrCodeData, { type: 'png', width: 300, margin: 2 });
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'no-store');
    res.send(image);
  } catch (err) {
    logError('QR_ERROR', 'Could not generate QR code.', err);
    res.status(500).send('QR generation failed.');
  }
});

// =====================================================
// PHONE NUMBER PAIRING API
// =====================================================

function normalizePhone(phone) {
  return String(phone || '').replace(/\D/g, '');
}

app.post('/request-pairing', async (req, res) => {
  if (pairingInProgress) {
    return res.status(409).json({ success: false, error: 'A pairing request is already in progress. Please wait.' });
  }
  if (resettingAuth) {
    return res.status(503).json({ success: false, error: 'WhatsApp authentication is being reset. Try again shortly.' });
  }

  const phone = normalizePhone(req.body?.phone || req.body?.number);
  if (!/^\d{8,15}$/.test(phone)) {
    return res.status(400).json({ success: false, error: 'Enter a valid phone number with country code. Example: 2547XXXXXXXX.' });
  }

  if (whatsappConnected) {
    return res.status(409).json({ success: false, error: 'WhatsApp is already connected.' });
  }

  if (!whatsappSocket) {
    return res.status(503).json({ success: false, error: 'WhatsApp socket is not ready. Wait for the QR code to appear and try again.' });
  }

  if (!qrCodeData) {
     return res.status(400).json({ success: false, error: 'Please wait for the QR code to appear on the screen, then try requesting the pairing code again.' });
  }

  pairingInProgress = true;

  try {
    const socket = whatsappSocket;

    logInfo('PAIRING_REQUEST', 'Generating phone number pairing code.');
    const code = await socket.requestPairingCode(phone);
    logInfo('PAIRING_CODE_GENERATED', 'WhatsApp pairing code generated successfully.');

    res.json({ success: true, phone, code });

  } catch (err) {
    logError('PAIRING_ERROR', 'Could not generate pairing code.', err);
    res.status(500).json({ success: false, error: err.message || 'Pairing code generation failed.' });
  } finally {
    pairingInProgress = false;
  }
});

// =====================================================
// SEND WHATSAPP MESSAGE API
// =====================================================

function normalizeJid(value) {
  const raw = String(value || '').trim();
  if (raw.includes('@')) {
    if (!/^\d{5,20}@(s\.whatsapp\.net|g\.us)$/.test(raw)) throw new Error('Invalid WhatsApp recipient.');
    return raw;
  }
  const phone = normalizePhone(raw);
  if (!/^\d{8,15}$/.test(phone)) throw new Error('Enter a valid recipient phone number.');
  return phone + '@s.whatsapp.net';
}

app.post('/send', async (req, res) => {
  try {
    if (!whatsappConnected || !whatsappSocket) {
      return res.status(503).json({ success: false, error: 'WhatsApp is not connected.' });
    }

    const recipient = normalizeJid(req.body?.to || req.body?.phone || req.body?.number);
    const message = String(req.body?.message || '').trim();

    if (!message) {
      return res.status(400).json({ success: false, error: 'Message cannot be empty.' });
    }

    await whatsappSocket.sendMessage(recipient, { text: message });
    logInfo('MESSAGE_SENT', 'WhatsApp message sent successfully.', { recipient });

    res.json({ success: true, message: 'Message sent successfully.' });
  } catch (err) {
    logError('SEND_ERROR', 'Could not send WhatsApp message.', err);
    res.status(500).json({ success: false, error: err.message || 'Message sending failed.' });
  }
});

// =====================================================
// START SERVER
// =====================================================

app.listen(PORT, '0.0.0.0', () => {
  logInfo('SERVER_STARTED', 'Server running on port ' + PORT);
  logInfo('GEMINI_CONFIGURATION', 'Gemini configuration loaded.', {
    apiKeyPresent: Boolean(GEMINI_API_KEY),
    primaryModel: GEMINI_MODEL,
    fallbackModel: GEMINI_FALLBACK_MODEL
  });

  connectMongoDB()
    .then(async () => {
      await startWhatsApp();
    })
    .catch(err => {
      mongoConnected = false;
      logError('STARTUP_ERROR', 'Could not initialize MongoDB or WhatsApp.', err);
    });
});

// =====================================================
// PROCESS ERROR HANDLING
// =====================================================

process.on('unhandledRejection', reason => {
  logError('UNHANDLED_REJECTION', 'Unhandled promise rejection.', reason);
});

process.on('uncaughtException', err => {
  logError('UNCAUGHT_EXCEPTION', 'Uncaught application exception.', err);
});
