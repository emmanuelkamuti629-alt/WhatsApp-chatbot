
require('dotenv').config();

const express = require('express');
const path = require('path');
const fs = require('fs');

const makeWASocket = require('@whiskeysockets/baileys').default;

const {
  useMultiFileAuthState,
  DisconnectReason
} = require('@whiskeysockets/baileys');

const QRCode = require('qrcode');
const OpenAI = require('openai');
const NodeCache = require('node-cache');
const pino = require('pino');

// =====================================================
// CONFIGURATION
// =====================================================

const config = {
  server: {
    port: process.env.PORT || 3000
  },

  whatsapp: {
    sessionPath: process.env.SESSION_PATH || './.baileys_auth'
  },

  bot: {
    name: process.env.BOT_NAME || 'Smart Assistant',

    personality:
      process.env.BOT_PERSONALITY ||
      'You are a helpful, friendly and intelligent WhatsApp assistant. Answer clearly and naturally. Keep replies conversational and concise unless more detail is requested.',

    maxHistory: parseInt(
      process.env.MAX_HISTORY_MESSAGES || '10',
      10
    )
  },

  gemini: {
    apiKey: process.env.GEMINI_API_KEY,

    baseURL:
      'https://generativelanguage.googleapis.com/v1beta/openai/',

    model:
      process.env.OPENAI_MODEL || 'gemini-3.8-flash',

    maxTokens: parseInt(
      process.env.OPENAI_MAX_TOKENS || '1000',
      10
    ),

    temperature: parseFloat(
      process.env.OPENAI_TEMPERATURE || '0.7'
    )
  }
};

// =====================================================
// GEMINI AI SETUP
// =====================================================

if (!config.gemini.apiKey) {
  console.error('ERROR: GEMINI_API_KEY is missing!');
}

const ai = new OpenAI({
  apiKey: config.gemini.apiKey || 'missing-api-key',

  baseURL: config.gemini.baseURL,

  timeout: 60000,

  maxRetries: 2
});

const historyCache = new NodeCache({
  stdTTL: 3600,
  checkperiod: 600
});

// =====================================================
// AI REPLY GENERATOR
// =====================================================

async function generateReply(chatId, userMessage) {

  if (!userMessage) return null;

  if (!config.gemini.apiKey) {
    console.error('Gemini API key is not configured.');

    return '⚠️ AI service is not configured. Please contact the administrator.';
  }

  let history = historyCache.get(chatId) || [];

  history.push({
    role: 'user',
    content: userMessage
  });

  const messages = [
    {
      role: 'system',
      content: config.bot.personality
    },
    ...history
  ];

  try {

    console.log('--------------------------------');
    console.log('GEMINI AI REQUEST');
    console.log('Model:', config.gemini.model);
    console.log('Chat:', chatId);
    console.log('--------------------------------');

    const response = await ai.chat.completions.create({

      model: config.gemini.model,

      messages: messages,

      max_tokens: config.gemini.maxTokens,

      temperature: config.gemini.temperature

    });

    const reply =
      response.choices?.[0]?.message?.content;

    if (!reply || typeof reply !== 'string') {

      console.error('Gemini returned an empty response.');

      return 'Sorry, I could not generate a response. Please try again.';

    }

    // Save conversation history.

    history.push({
      role: 'assistant',
      content: reply
    });

    historyCache.set(
      chatId,
      history.slice(-config.bot.maxHistory * 2)
    );

    console.log('GEMINI SUCCESS: Reply generated.');

    return reply;

  } catch (error) {

    console.error('========== GEMINI ERROR ==========');

    console.error('Message:', error.message);
    console.error('Status:', error.status);
    console.error('Code:', error.code);
    console.error('Type:', error.type);

    if (error.response) {
      console.error('Response:', error.response.data);
    }

    console.error('Model:', config.gemini.model);

    console.error('===================================');

    // Remove the failed message from history.

    history.pop();

    historyCache.set(
      chatId,
      history.slice(-config.bot.maxHistory * 2)
    );

    if (error.status === 401 || error.status === 403) {
      return '⚠️ Gemini API authentication failed. Please check the API configuration.';
    }

    if (error.status === 429) {
      return '⚠️ Gemini API limit reached. Please try again shortly.';
    }

    if (error.status === 404) {
      return '⚠️ Gemini model not found. Please check the model configuration.';
    }

    return '⚠️ Gemini is temporarily unavailable. Please try again shortly.';

  }
}

// =====================================================
// EXPRESS SERVER
// =====================================================

const app = express();

app.use(express.json({
  limit: '1mb'
}));

app.use(express.static(__dirname));

let sock = null;
let authState = null;

let isConnected = false;
let latestQRDataUrl = null;
let pairingCode = null;
let pairingReady = false;
let pairingInProgress = false;
let isConnecting = false;
let reconnectTimer = null;

// =====================================================
// PHONE NUMBER VALIDATION
// =====================================================

function normalizePhoneNumber(input) {

  let phone = String(input || '').replace(/\D/g, '');

  // Convert Kenyan local number to international format.

  if (phone.startsWith('0') && phone.length === 10) {
    phone = '254' + phone.substring(1);
  }

  // Validate international number.

  if (!/^[1-9]\d{7,14}$/.test(phone)) {
    return null;
  }

  return phone;
}

// =====================================================
// HOME PAGE
// =====================================================

app.get('/', (req, res) => {

  res.sendFile(
    path.join(__dirname, 'index.html')
  );

});

// =====================================================
// HEALTH CHECK
// =====================================================

app.get('/health', (req, res) => {

  res.json({

    status: 'ok',

    bot: config.bot.name,

    aiProvider: 'Google Gemini',

    aiModel: config.gemini.model,

    aiConfigured: !!config.gemini.apiKey,

    whatsappReady: isConnected,

    pairingReady: pairingReady,

    qrPending: !!latestQRDataUrl

  });

});

// =====================================================
// WHATSAPP LOGIN PAGE
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
        align-items:center;
        justify-content:center;
        min-height:100vh;
      ">

        <div style="
          background:white;
          padding:35px;
          border-radius:15px;
          text-align:center;
        ">

          <h2 style="color:#25d366">
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

  // PAIRING CODE

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

          1. Open WhatsApp.<br>
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

  // QR CODE

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

  // WAITING

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

  // PHONE INPUT

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

          button.innerText = 'Generating...';

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
// REQUEST WHATSAPP PAIRING CODE
// =====================================================

app.get('/request-pairing', async (req, res) => {

  const phone = normalizePhoneNumber(req.query.phone);

  if (!phone) {

    return res.status(400).json({

      success: false,

      error: 'Invalid number. Example: 254712345678'

    });

  }

  if (!sock || !authState) {

    return res.status(503).json({

      success: false,

      error: 'WhatsApp is still starting.'

    });

  }

  if (isConnected) {

    return res.status(409).json({

      success: false,

      error: 'WhatsApp is already connected.'

    });

  }

  if (authState.creds.registered) {

    return res.status(409).json({

      success: false,

      error: 'An existing WhatsApp session is registered.'

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

      error: 'Pairing request already processing.'

    });

  }

  pairingInProgress = true;

  try {

    console.log('Requesting WhatsApp pairing code...');

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

    pairingReady = true;

    return res.status(500).json({

      success: false,

      error: error.message || 'Pairing failed.'

    });

  } finally {

    pairingInProgress = false;

  }

});

// =====================================================
// SEND WHATSAPP MESSAGE
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
// START SERVER
// =====================================================

app.listen(config.server.port, '0.0.0.0', () => {

  console.log('====================================');

  console.log('WHATSAPP AI BOT STARTED');

  console.log('Port:', config.server.port);

  console.log('AI Provider: Google Gemini');

  console.log('AI Model:', config.gemini.model);

  console.log('Dashboard: /qr');

  console.log('Health: /health');

  console.log('====================================');

});

// =====================================================
// WHATSAPP CONNECTION
// =====================================================

async function connectToWhatsApp() {

  if (isConnecting) return;

  isConnecting = true;

  try {

    fs.mkdirSync(config.whatsapp.sessionPath, {
      recursive: true
    });

    const auth = await useMultiFileAuthState(
      config.whatsapp.sessionPath
    );

    authState = auth.state;

    const saveCreds = auth.saveCreds;

    console.log('Loading WhatsApp session...');

    sock = makeWASocket({

      auth: authState,

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

    // SAVE AUTHENTICATION

    sock.ev.on('creds.update', saveCreds);

    // =================================================
    // CONNECTION EVENTS
    // =================================================

    sock.ev.on('connection.update', async (update) => {

      const {
        connection,
        lastDisconnect,
        qr
      } = update;

      // QR EVENT

      if (qr) {

        pairingReady = true;

        if (!pairingCode) {

          try {

            latestQRDataUrl = await QRCode.toDataURL(qr, {
              width: 500,
              margin: 1
            });

            console.log('WhatsApp QR generated.');

          } catch (error) {

            console.error('QR ERROR:', error);

          }

        }

      }

      // CONNECTED

      if (connection === 'open') {

        isConnected = true;

        pairingReady = false;

        pairingCode = null;

        latestQRDataUrl = null;

        console.log('====================================');

        console.log('WHATSAPP CONNECTED SUCCESSFULLY!');

        console.log('GEMINI AI IS READY.');

        console.log('====================================');

      }

      // DISCONNECTED

      if (connection === 'close') {

        isConnected = false;

        pairingReady = false;

        pairingCode = null;

        latestQRDataUrl = null;

        const statusCode =
          lastDisconnect?.error?.output?.statusCode;

        const shouldReconnect =
          statusCode !== DisconnectReason.loggedOut;

        console.log('WhatsApp connection closed.');

        console.log('Disconnect code:', statusCode);

        console.log('Reconnect:', shouldReconnect);

        if (shouldReconnect) {

          if (reconnectTimer) {
            clearTimeout(reconnectTimer);
          }

          reconnectTimer = setTimeout(() => {

            connectToWhatsApp().catch(error => {
              console.error('RECONNECT ERROR:', error);
            });

          }, 3000);

        } else {

          console.log(
            'WhatsApp logged out. New authentication required.'
          );

        }

      }

    });

    // =================================================
    // INCOMING MESSAGES
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

          console.log('NEW MESSAGE:', chatId);

          console.log('MESSAGE:', userMessage);

          console.log('--------------------------------');

          // Generate Gemini response.

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

          console.error('MESSAGE ERROR:', error);

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
// START WHATSAPP BOT
// =====================================================

connectToWhatsApp().catch(error => {

  console.error('INITIAL CONNECTION ERROR:', error);

});
