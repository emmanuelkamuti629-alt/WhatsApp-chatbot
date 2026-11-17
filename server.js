
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

// ======================================================
// CONFIGURATION
// ======================================================

const PORT = process.env.PORT || 3000;

const SESSION_PATH =
  process.env.SESSION_PATH || './.baileys_auth';

const BOT_NAME =
  process.env.BOT_NAME || 'Smart Assistant';

const BOT_PERSONALITY =
  process.env.BOT_PERSONALITY ||
  'You are a helpful, accurate and friendly WhatsApp assistant.';

const MAX_HISTORY = parseInt(
  process.env.MAX_HISTORY_MESSAGES || '10',
  10
);

const MAX_TOKENS = parseInt(
  process.env.OPENAI_MAX_TOKENS || '500',
  10
);

const TEMPERATURE = parseFloat(
  process.env.OPENAI_TEMPERATURE || '0.7'
);

const API_KEY =
  process.env.GROQ_API_KEY ||
  process.env.GEMINI_API_KEY ||
  process.env.OPENAI_API_KEY;

let BASE_URL;
let MODEL;

if (process.env.GROQ_API_KEY) {
  BASE_URL = 'https://api.groq.com/openai/v1';
  MODEL = process.env.OPENAI_MODEL || 'llama-3.3-70b-versatile';
} else if (process.env.GEMINI_API_KEY) {
  BASE_URL =
    'https://generativelanguage.googleapis.com/v1beta/openai/';
  MODEL = process.env.OPENAI_MODEL || 'gemini-2.5-flash';
} else {
  BASE_URL = undefined;
  MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
}

// ======================================================
// AI CONFIGURATION
// ======================================================

const openai = new OpenAI({
  apiKey: API_KEY || 'missing-api-key',
  ...(BASE_URL ? { baseURL: BASE_URL } : {})
});

const historyCache = new NodeCache({
  stdTTL: 3600,
  checkperiod: 600
});

async function generateReply(chatId, userMessage) {
  if (!userMessage || !API_KEY) {
    if (!API_KEY) {
      console.error('AI API key is missing.');
      return '⚠️ AI service is not configured. Please try again later.';
    }

    return null;
  }

  let history = historyCache.get(chatId) || [];

  history.push({
    role: 'user',
    content: userMessage
  });

  const messages = [
    {
      role: 'system',
      content: BOT_PERSONALITY
    },
    ...history
  ];

  try {
    const response = await openai.chat.completions.create({
      model: MODEL,
      messages,
      max_tokens: MAX_TOKENS,
      temperature: TEMPERATURE
    });

    const reply =
      response.choices?.[0]?.message?.content;

    if (!reply) {
      return 'Sorry, I could not generate a response.';
    }

    history.push({
      role: 'assistant',
      content: reply
    });

    historyCache.set(
      chatId,
      history.slice(-MAX_HISTORY * 2)
    );

    return reply;

  } catch (error) {
    console.error('AI ERROR:', error.message);

    return "⚠️ I'm having trouble thinking right now. Please try again.";
  }
}

// ======================================================
// EXPRESS SERVER
// ======================================================

const app = express();

app.use(express.json({ limit: '1mb' }));

app.use(express.static(__dirname));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ======================================================
// WHATSAPP GLOBAL VARIABLES
// ======================================================

let sock = null;

let isConnected = false;

let latestQRDataUrl = null;

let pairingCode = null;

let pairingReady = false;

let pairingInProgress = false;

let requestedPhone = null;

let reconnectTimer = null;

let isConnecting = false;

// ======================================================
// PHONE NUMBER VALIDATION
// ======================================================

function normalizePhoneNumber(input) {
  let phone = String(input || '').replace(/\D/g, '');

  // Convert Kenyan local numbers to international format.
  if (phone.startsWith('0') && phone.length === 10) {
    phone = '254' + phone.substring(1);
  }

  // Accept Kenyan numbers beginning with 254.
  if (/^254[17]\d{8}$/.test(phone)) {
    return phone;
  }

  // Allow other international numbers.
  if (/^[1-9]\d{7,14}$/.test(phone)) {
    return phone;
  }

  return null;
}

// ======================================================
// HEALTH CHECK
// ======================================================

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    bot: BOT_NAME,
    whatsappReady: isConnected,
    pairingReady,
    pairingPending: !!pairingCode,
    qrPending: !!latestQRDataUrl
  });
});

// ======================================================
// WHATSAPP QR / PAIRING PAGE
// ======================================================

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
        background:#e9edef;
        font-family:Arial;
        display:flex;
        justify-content:center;
        align-items:center;
        min-height:100vh;
        margin:0;
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
          <p>Your chatbot is now online.</p>
          <p>You can close this page.</p>
        </div>
      </body>
      </html>
    `);
  }

  let contentHtml = '';

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
          5. Enter the pairing code above.
        </div>

        <script>
          function copyCode() {
            navigator.clipboard.writeText(
              '${pairingCode}'
            ).then(() => alert('Code copied'));
          }
        </script>

      </div>
    `;

  } else if (latestQRDataUrl) {

    contentHtml = `
      <div style="text-align:center;width:100%;">

        <h2 style="color:#075e54;">
          Scan WhatsApp QR Code
        </h2>

        <p>WhatsApp → Linked Devices → Link a Device</p>

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

  } else {

    contentHtml = `
      <div style="text-align:center;">
        <h2 style="color:#667781;">
          ⏳ Starting WhatsApp...
        </h2>
        <p>Please wait a few seconds.</p>
      </div>
    `;

  }

  // Pairing input form

  let inputHtml = '';

  if (!pairingCode && !isConnected) {

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

            status.innerText = 'Code generated successfully!';

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
        content="width=device-width, initial-scale=1.0">

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

// ======================================================
// REQUEST PAIRING CODE
// ======================================================

app.get('/request-pairing', async (req, res) => {

  const phone = normalizePhoneNumber(req.query.phone);

  if (!phone) {
    return res.status(400).json({
      success: false,
      error: 'Invalid phone number. Example: 254712345678'
    });
  }

  if (!sock) {
    return res.status(503).json({
      success: false,
      error: 'WhatsApp is still starting. Try again shortly.'
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
      error: 'An existing WhatsApp session is registered. Check your connection.'
    });
  }

  if (pairingInProgress) {
    return res.status(409).json({
      success: false,
      error: 'A pairing request is already processing.'
    });
  }

  if (!pairingReady) {
    return res.status(503).json({
      success: false,
      error: 'WhatsApp is not ready for pairing yet. Wait a few seconds and retry.'
    });
  }

  pairingInProgress = true;

  try {

    requestedPhone = phone;

    pairingReady = false;

    console.log('Requesting WhatsApp pairing code...');

    const code = await sock.requestPairingCode(phone);

    // Display the code in groups of four.

    pairingCode =
      code.match(/.{1,4}/g)?.join('-') || code;

    latestQRDataUrl = null;

    console.log('Pairing code generated:', pairingCode);

    res.json({
      success: true,
      code: pairingCode,
      message: 'Enter this code in WhatsApp Linked Devices.'
    });

  } catch (error) {

    console.error('PAIRING ERROR:', error);

    res.status(500).json({
      success: false,
      error: error.message || 'Could not generate pairing code.'
    });

  } finally {

    pairingInProgress = false;

  }

});

// ======================================================
// SEND WHATSAPP MESSAGE
// ======================================================

app.post('/send', async (req, res) => {

  const { to, message } = req.body;

  if (!isConnected || !sock) {
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
      error: 'Invalid destination phone number.'
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
      message: 'WhatsApp message sent successfully.'
    });

  } catch (error) {

    console.error('SEND ERROR:', error);

    res.status(500).json({
      success: false,
      error: error.message
    });

  }

});

// ======================================================
// START EXPRESS SERVER
// ======================================================

app.listen(PORT, '0.0.0.0', () => {

  console.log('====================================');
  console.log(`${BOT_NAME} SERVER STARTED`);
  console.log(`Port: ${PORT}`);
  console.log('WhatsApp dashboard: /qr');
  console.log('Health check: /health');
  console.log('====================================');

});

// ======================================================
// WHATSAPP CONNECTION
// ======================================================

async function connectToWhatsApp() {

  if (isConnecting) {
    return;
  }

  isConnecting = true;

  try {

    // Create session folder if it doesn't exist.

    fs.mkdirSync(SESSION_PATH, {
      recursive: true
    });

    const { state, saveCreds } =
      await useMultiFileAuthState(SESSION_PATH);

    console.log('Loading WhatsApp authentication...');

    // Create WhatsApp socket.
    // Let Baileys use its supported default Web version.

    sock = makeWASocket({

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

    // Save authentication credentials.

    sock.ev.on('creds.update', saveCreds);

    // ==================================================
    // CONNECTION EVENTS
    // ==================================================

    sock.ev.on('connection.update', async (update) => {

      const {
        connection,
        lastDisconnect,
        qr
      } = update;

      // QR event also indicates that pairing is ready.
      // This is the point at which requestPairingCode
      // should be called.

      if (qr) {

        pairingReady = true;

        if (!pairingCode) {

          try {

            latestQRDataUrl = await QRCode.toDataURL(qr, {
              width: 500,
              margin: 1
            });

            console.log('QR Code generated. Visit /qr');

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

        requestedPhone = null;

        console.log('====================================');
        console.log('✅ WHATSAPP BOT IS ONLINE!');
        console.log('====================================');

      }

      // CONNECTION CLOSED

      if (connection === 'close') {

        isConnected = false;

        pairingReady = false;

        pairingCode = null;

        latestQRDataUrl = null;

        requestedPhone = null;

        const statusCode =
          lastDisconnect?.error?.output?.statusCode;

        const shouldReconnect =
          statusCode !== DisconnectReason.loggedOut;

        console.log('====================================');
        console.log('WhatsApp connection closed.');
        console.log('Status:', statusCode);
        console.log('Reconnect:', shouldReconnect);
        console.log('====================================');

        if (shouldReconnect) {

          if (reconnectTimer) {
            clearTimeout(reconnectTimer);
          }

          reconnectTimer = setTimeout(() => {

            connectToWhatsApp().catch(error => {
              console.error('RECONNECTION ERROR:', error);
            });

          }, 3000);

        } else {

          console.log(
            'WhatsApp logged out. New authentication required.'
          );

        }

      }

    });

    // ==================================================
    // RECEIVE WHATSAPP MESSAGES
    // ==================================================

    sock.ev.on('messages.upsert', async (event) => {

      const { messages, type } = event;

      // Process each incoming message.

      for (const msg of messages) {

        try {

          if (!msg.message) continue;

          if (msg.key.fromMe) continue;

          if (msg.key.remoteJid === 'status@broadcast') {
            continue;
          }

          const chatId = msg.key.remoteJid;

          if (!chatId || chatId.endsWith('@newsletter')) {
            continue;
          }

          // Extract text from common message formats.

          const message =
            msg.message.conversation ||
            msg.message.extendedTextMessage?.text ||
            msg.message.imageMessage?.caption ||
            msg.message.videoMessage?.caption ||
            msg.message.documentMessage?.caption;

          if (!message || !message.trim()) {
            continue;
          }

          console.log(
            `📩 Incoming from ${chatId}: ${message.slice(0, 100)}`
          );

          // Generate AI response.

          const reply = await generateReply(
            chatId,
            message.trim()
          );

          if (reply) {

            await sock.sendMessage(chatId, {
              text: reply
            });

            console.log(
              `📤 Replied to ${chatId}`
            );

          }

        } catch (error) {

          console.error(
            'MESSAGE PROCESSING ERROR:',
            error
          );

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

// ======================================================
// START WHATSAPP
// ======================================================

connectToWhatsApp().catch(error => {

  console.error('INITIAL WHATSAPP ERROR:', error);

});
