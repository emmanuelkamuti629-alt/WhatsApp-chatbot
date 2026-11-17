
require('dotenv').config();

const express = require('express');
const path = require('path');
const fs = require('fs');

const makeWASocket = require('@whiskeysockets/baileys').default;

const {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestWaWebVersion
} = require('@whiskeysockets/baileys');

const QRCode = require('qrcode');
const OpenAI = require('openai');
const NodeCache = require('node-cache');
const pino = require('pino');

// =====================================================
// 1. CONFIGURATION
// =====================================================

const config = {
  port: process.env.PORT || 3000,

  sessionPath:
    process.env.SESSION_PATH || './.baileys_auth',

  botName:
    process.env.BOT_NAME || 'Smart Assistant',

  personality:
    process.env.BOT_PERSONALITY ||
    'You are a helpful, intelligent, friendly WhatsApp assistant. Answer naturally, accurately and clearly. Keep conversations engaging.',

  maxHistory: parseInt(
    process.env.MAX_HISTORY_MESSAGES || '10',
    10
  ),

  maxTokens: parseInt(
    process.env.OPENAI_MAX_TOKENS || '1000',
    10
  ),

  temperature: parseFloat(
    process.env.OPENAI_TEMPERATURE || '0.7'
  ),

  geminiKey: process.env.GEMINI_API_KEY,

  geminiModel:
    process.env.OPENAI_MODEL || 'gemini-2.5-flash',

  geminiURL:
    'https://generativelanguage.googleapis.com/v1beta/openai/'
};

// =====================================================
// 2. GEMINI AI SETUP
// =====================================================

if (!config.geminiKey) {
  console.error('WARNING: GEMINI_API_KEY is missing!');
}

const ai = new OpenAI({
  apiKey: config.geminiKey || 'missing-api-key',
  baseURL: config.geminiURL,
  timeout: 60000,
  maxRetries: 2
});

const historyCache = new NodeCache({
  stdTTL: 3600,
  checkperiod: 600
});

// =====================================================
// 3. AI RESPONSE GENERATOR
// =====================================================

async function generateReply(chatId, userMessage) {

  if (!userMessage) return null;

  if (!config.geminiKey) {
    return '⚠️ Gemini API key is not configured.';
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

    console.log('========== GEMINI REQUEST ==========');
    console.log('Model:', config.geminiModel);
    console.log('Chat:', chatId);

    const response = await ai.chat.completions.create({
      model: config.geminiModel,
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

    console.log('GEMINI SUCCESS');

    return reply;

  } catch (error) {

    console.error('========== GEMINI ERROR ==========');
    console.error('Message:', error.message);
    console.error('Status:', error.status);
    console.error('Code:', error.code);
    console.error('Type:', error.type);
    console.error('===================================');

    // Remove failed user message from history.

    history.pop();

    historyCache.set(
      chatId,
      history.slice(-config.maxHistory * 2)
    );

    if (error.status === 401 || error.status === 403) {
      return '⚠️ Gemini authentication failed. Please check the API key.';
    }

    if (error.status === 429) {
      return '⚠️ Gemini request limit reached. Please try again later.';
    }

    if (error.status === 404) {
      return '⚠️ Gemini model not found. Check your model configuration.';
    }

    return '⚠️ Gemini is temporarily unavailable. Please try again.';

  }
}

// =====================================================
// 4. EXPRESS SERVER
// =====================================================

const app = express();

app.use(express.json({
  limit: '1mb'
}));

app.use(express.static(__dirname));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// =====================================================
// 5. WHATSAPP GLOBAL VARIABLES
// =====================================================

let sock = null;

let isConnected = false;

let latestQRDataUrl = null;

let pairingCode = null;

let pairingReady = false;

let pairingInProgress = false;

let isConnecting = false;

let reconnectTimer = null;

// =====================================================
// 6. PHONE NUMBER VALIDATION
// =====================================================

function normalizePhoneNumber(input) {

  let phone = String(input || '').replace(/\D/g, '');

  // Convert Kenyan local number to international format.

  if (phone.startsWith('0') && phone.length === 10) {
    phone = '254' + phone.substring(1);
  }

  // Kenyan mobile numbers.

  if (/^254[17]\d{8}$/.test(phone)) {
    return phone;
  }

  // Other international numbers.

  if (/^[1-9]\d{7,14}$/.test(phone)) {
    return phone;
  }

  return null;
}

// =====================================================
// 7. HEALTH CHECK
// =====================================================

app.get('/health', (req, res) => {

  res.json({
    status: 'ok',
    bot: config.botName,
    aiProvider: 'Google Gemini',
    aiModel: config.geminiModel,
    aiConfigured: !!config.geminiKey,
    whatsappReady: isConnected,
    pairingReady,
    qrPending: !!latestQRDataUrl
  });

});

// =====================================================
// 8. WHATSAPP LOGIN PAGE
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

      <body style="
        background:#f0f2f5;
        font-family:Arial;
        display:flex;
        justify-content:center;
        align-items:center;
        min-height:100vh;
      ">

        <div style="
          background:white;
          padding:35px;
          border-radius:15px;
          text-align:center;
        ">

          <h2 style="color:#25d366;">
            ✅ WhatsApp Connected!
          </h2>

          <p>Your chatbot is online.</p>

          <p>AI Provider: Google Gemini</p>

          <p>You can close this page.</p>

        </div>

      </body>
      </html>
    `);

  }

  let contentHtml = '';

  // PAIRING CODE DISPLAY

  if (pairingCode) {

    contentHtml = `

      <div style="text-align:center;width:100%;">

        <h2 style="color:#075e54;">
          Your WhatsApp Pairing Code
        </h2>

        <div style="
          font-size:clamp(35px,10vw,65px);
          font-weight:900;
          color:#128c7e;
          letter-spacing:5px;
          margin:25px 0;
        ">
          ${pairingCode}
        </div>

        <button onclick="copyCode()" style="
          padding:12px 25px;
          background:#25d366;
          border:0;
          color:white;
          border-radius:8px;
          font-size:16px;
          font-weight:bold;
        ">
          Copy Code
        </button>

        <div style="
          background:white;
          padding:20px;
          border-radius:12px;
          margin-top:25px;
          text-align:left;
          line-height:2;
        ">

          1. Open WhatsApp on your phone.<br>
          2. Go to Linked Devices.<br>
          3. Tap Link a Device.<br>
          4. Select Link with phone number instead.<br>
          5. Enter the pairing code.

        </div>

        <script>
          function copyCode() {
            navigator.clipboard.writeText('${pairingCode}')
              .then(() => alert('Code copied'));
          }
        </script>

      </div>

    `;

  }

  // QR CODE DISPLAY

  else if (latestQRDataUrl) {

    contentHtml = `

      <div style="text-align:center;width:100%;">

        <h2 style="color:#075e54;">
          Scan WhatsApp QR Code
        </h2>

        <p>
          WhatsApp → Linked Devices → Link a Device
        </p>

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

      </div>

    `;

  }

  else {

    contentHtml = `

      <div style="text-align:center;">

        <h2 style="color:#667781;">
          ⏳ Starting WhatsApp...
        </h2>

        <p>Please wait a few seconds.</p>

      </div>

    `;

  }

  // PHONE NUMBER INPUT

  let inputHtml = '';

  if (!pairingCode) {

    inputHtml = `

      <div style="
        margin-top:30px;
        background:white;
        padding:20px;
        border-radius:12px;
        width:90%;
        max-width:500px;
        box-sizing:border-box;
      ">

        <h3 style="color:#075e54;">
          Login with Phone Number
        </h3>

        <p style="color:#667781;">
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
            font-size:18px;
            border:2px solid #ccc;
            border-radius:8px;
            margin-bottom:15px;
          "
        >

        <button
          id="getCodeButton"
          onclick="getCode()"
          style="
            width:100%;
            padding:15px;
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

        <p id="status" style="color:#667781;"></p>

      </div>

      <script>

        async function getCode() {

          const phone =
            document.getElementById('phone').value.trim();

          const button =
            document.getElementById('getCodeButton');

          const status =
            document.getElementById('status');

          if (!phone) {
            alert('Enter your WhatsApp number');
            return;
          }

          button.disabled = true;
          button.innerText = 'Generating Code...';

          status.innerText = 'Please wait...';

          try {

            const response = await fetch(
              '/request-pairing?phone=' +
              encodeURIComponent(phone)
            );

            const data = await response.json();

            if (!response.ok) {
              throw new Error(data.error || 'Request failed');
            }

            window.location.reload();

          } catch (error) {

            status.innerText = error.message;

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

      <title>WhatsApp Login</title>

      <meta name="viewport"
        content="width=device-width, initial-scale=1">

      <meta http-equiv="refresh" content="30">

    </head>

    <body style="
      margin:0;
      padding:20px 0;
      background:#f0f2f5;
      font-family:Arial,sans-serif;
      display:flex;
      flex-direction:column;
      align-items:center;
      justify-content:center;
      min-height:100vh;
    ">

      <div style="
        width:100%;
        display:flex;
        flex-direction:column;
        align-items:center;
        box-sizing:border-box;
      ">

        ${contentHtml}

        ${inputHtml}

      </div>

    </body>

    </html>

  `);

});

// =====================================================
// 9. REQUEST PAIRING CODE
// =====================================================

app.get('/request-pairing', async (req, res) => {

  const phone = normalizePhoneNumber(req.query.phone);

  if (!phone) {

    return res.status(400).json({
      success: false,
      error: 'Invalid number. Example: 254712345678'
    });

  }

  if (!sock) {

    return res.status(503).json({
      success: false,
      error: 'WhatsApp socket is not ready.'
    });

  }

  if (isConnected) {

    return res.status(409).json({
      success: false,
      error: 'WhatsApp is already connected.'
    });

  }

  if (sock.authState.creds.registered) {

    return res.status(409).json({
      success: false,
      error: 'Existing WhatsApp session is registered.'
    });

  }

  if (!pairingReady) {

    return res.status(503).json({
      success: false,
      error: 'WhatsApp is not ready. Wait a few seconds and retry.'
    });

  }

  if (pairingInProgress) {

    return res.status(409).json({
      success: false,
      error: 'Pairing request is already processing.'
    });

  }

  pairingInProgress = true;

  try {

    console.log('Requesting pairing code for:', phone);

    // Prevent duplicate pairing requests.

    pairingReady = false;

    const code = await sock.requestPairingCode(phone);

    pairingCode =
      code.match(/.{1,4}/g)?.join('-') || code;

    latestQRDataUrl = null;

    console.log('Pairing code generated successfully.');

    return res.json({
      success: true,
      code: pairingCode
    });

  } catch (error) {

    console.error('PAIRING ERROR:', error);

    return res.status(500).json({
      success: false,
      error: error.message || 'Pairing code generation failed.'
    });

  } finally {

    pairingInProgress = false;

  }

});

// =====================================================
// 10. SEND WHATSAPP MESSAGE
// =====================================================

app.post('/send', async (req, res) => {

  const { to, message } = req.body;

  if (!sock || !isConnected) {

    return res.status(503).json({
      success: false,
      error: 'WhatsApp is not connected.'
    });

  }

  if (!to || !message) {

    return res.status(400).json({
      success: false,
      error: 'Phone number and message are required.'
    });

  }

  const phone = normalizePhoneNumber(to);

  if (!phone) {

    return res.status(400).json({
      success: false,
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

    res.json({
      success: true,
      message: 'Message sent successfully.'
    });

  } catch (error) {

    console.error('SEND ERROR:', error);

    res.status(500).json({
      success: false,
      error: error.message
    });

  }

});

// =====================================================
// 11. START EXPRESS SERVER
// =====================================================

app.listen(config.port, '0.0.0.0', () => {

  console.log('====================================');

  console.log(config.botName + ' STARTED');

  console.log('Port:', config.port);

  console.log('AI Provider: Google Gemini');

  console.log('AI Model:', config.geminiModel);

  console.log('Dashboard: /qr');

  console.log('Health: /health');

  console.log('====================================');

});

// =====================================================
// 12. WHATSAPP CONNECTION
// =====================================================

async function connectToWhatsApp() {

  if (isConnecting) return;

  isConnecting = true;

  try {

    fs.mkdirSync(config.sessionPath, {
      recursive: true
    });

    const {
      state,
      saveCreds
    } = await useMultiFileAuthState(config.sessionPath);

    console.log('Loading WhatsApp session...');

    // IMPORTANT:
    // Fetch the latest WhatsApp Web version.

    console.log('Fetching latest WhatsApp Web version...');

    const latest = await fetchLatestWaWebVersion();

    if (!latest || !latest.version) {
      throw new Error(
        'Could not obtain the latest WhatsApp Web version.'
      );
    }

    const version = latest.version;

    console.log(
      'WhatsApp Web Version:',
      version.join('.')
    );

    console.log(
      'Is Latest:',
      latest.isLatest
    );

    // CREATE WHATSAPP SOCKET

    sock = makeWASocket({

      version,

      auth: state,

      printQRInTerminal: false,

      logger: pino({
        level: process.env.LOG_LEVEL || 'silent'
      }),

      browser: ['Ubuntu', 'Chrome', '20.0.04'],

      markOnlineOnConnect: false,

      syncFullHistory: false,

      generateHighQualityLinkPreview: false

    });

    isConnecting = false;

    // SAVE CREDENTIALS

    sock.ev.on('creds.update', async () => {

      try {

        await saveCreds();

      } catch (error) {

        console.error('CREDENTIAL SAVE ERROR:', error);

      }

    });

    // =================================================
    // CONNECTION UPDATE
    // =================================================

    sock.ev.on('connection.update', async (update) => {

      const {
        connection,
        lastDisconnect,
        qr
      } = update;

      // QR EVENT / PAIRING READY

      if (qr) {

        if (
          !pairingCode &&
          !pairingInProgress &&
          !state.creds.registered
        ) {

          pairingReady = true;

          try {

            latestQRDataUrl = await QRCode.toDataURL(qr, {
              width: 500,
              margin: 1
            });

            console.log('QR CODE GENERATED.');

          } catch (error) {

            console.error('QR GENERATION ERROR:', error);

          }

        }

      }

      // CONNECTION OPEN

      if (connection === 'open') {

        isConnected = true;

        pairingReady = false;

        pairingCode = null;

        latestQRDataUrl = null;

        console.log('====================================');

        console.log('✅ WHATSAPP CONNECTED!');

        console.log('✅ GEMINI AI READY!');

        console.log('====================================');

      }

      // CONNECTION CLOSED

      if (connection === 'close') {

        isConnected = false;

        pairingReady = false;

        pairingCode = null;

        latestQRDataUrl = null;

        const statusCode =
          lastDisconnect?.error?.output?.statusCode;

        const shouldReconnect =
          statusCode !== DisconnectReason.loggedOut;

        console.log('====================================');

        console.log('WHATSAPP CONNECTION CLOSED');

        console.log('Disconnect status:', statusCode);

        console.log('Reconnect:', shouldReconnect);

        console.log('====================================');

        if (shouldReconnect) {

          if (reconnectTimer) {
            clearTimeout(reconnectTimer);
          }

          // Reconnect, including after 515 restart.

          reconnectTimer = setTimeout(() => {

            connectToWhatsApp().catch(error => {
              console.error('RECONNECT ERROR:', error);
            });

          }, 3000);

        } else {

          console.log(
            'WhatsApp logged out. New login required.'
          );

        }

      }

    });

    // =================================================
    // 13. RECEIVE WHATSAPP MESSAGES
    // =================================================

    sock.ev.on('messages.upsert', async (event) => {

      const { messages } = event;

      for (const msg of messages) {

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

          // Ignore group messages if desired.
          // Remove these two lines if you want group replies.
          // if (chatId.endsWith('@g.us')) continue;

          // Extract message text.

          const userMessage =

            msg.message.conversation ||

            msg.message.extendedTextMessage?.text ||

            msg.message.imageMessage?.caption ||

            msg.message.videoMessage?.caption ||

            msg.message.documentMessage?.caption;

          if (!userMessage || !userMessage.trim()) {
            continue;
          }

          console.log('--------------------------------');

          console.log('INCOMING MESSAGE:', chatId);

          console.log('TEXT:', userMessage);

          console.log('--------------------------------');

          // GENERATE GEMINI RESPONSE

          const reply = await generateReply(
            chatId,
            userMessage.trim()
          );

          if (reply && sock && isConnected) {

            await sock.sendMessage(chatId, {
              text: reply
            });

            console.log('AI REPLY SENT:', chatId);

          }

        } catch (error) {

          console.error('MESSAGE PROCESSING ERROR:', error);

        }

      }

    });

  } catch (error) {

    isConnecting = false;

    console.error('WHATSAPP START ERROR:', error);

    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
    }

    reconnectTimer = setTimeout(() => {

      connectToWhatsApp().catch(err => {
        console.error('RETRY ERROR:', err);
      });

    }, 5000);

  }

}

// =====================================================
// 14. START WHATSAPP BOT
// =====================================================

connectToWhatsApp().catch(error => {

  console.error('INITIAL WHATSAPP ERROR:', error);

});
