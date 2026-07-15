const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const { TelegramClient, Api } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { computeCheck } = require('telegram/Password');
const db = require('./database');

// Try to load Sharp for image compression
let sharp = null;
try {
  sharp = require('sharp');
  console.log('Sharp image processor loaded successfully.');
} catch (err) {
  console.log('Sharp not available — image previews will serve original files. Install sharp for compression.');
}

const app = express();
const PORT = process.env.PORT || 3000;

// Use persistent volume if available (Railway.app volume mount)
const dataDir = process.env.DATA_DIR || __dirname;

// Middleware
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Directories — all under dataDir for Railway volume persistence
const tempDir = path.join(dataDir, 'temp');
const cacheDir = path.join(dataDir, 'cache');
const thumbDir = path.join(dataDir, 'thumbs');
const uploadDir = path.join(dataDir, 'uploads');
[tempDir, cacheDir, thumbDir, uploadDir].forEach(d => { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); });

// Multer
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, tempDir),
  filename: (req, file, cb) => cb(null, Date.now() + '-' + file.originalname)
});
const upload = multer({ storage });

// ============================================================
// CONFIGURATION
// ============================================================
const configPath = path.join(dataDir, 'config.json');
let config = { apiId: '', apiHash: '', sessionString: '', chatId: '' };

function loadConfig() {
  // 1. Priority: Environment Variables (Railway/Production)
  const envConfig = {
    apiId: process.env.API_ID || '',
    apiHash: process.env.API_HASH || '',
    sessionString: process.env.SESSION_STRING || '',
    chatId: process.env.CHAT_ID || ''
  };

  // 2. Fallback: config.json (local dev)
  let savedConfig = {};
  const configPath = path.join(dataDir, 'config.json');
  if (fs.existsSync(configPath)) {
    try {
      savedConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    } catch (err) {
      console.error('Error reading config.json:', err.message);
    }
  }

  // Merge: env vars override saved config
  config = {
    apiId: envConfig.apiId || savedConfig.apiId || '',
    apiHash: envConfig.apiHash || savedConfig.apiHash || '',
    sessionString: envConfig.sessionString || savedConfig.sessionString || '',
    chatId: envConfig.chatId || savedConfig.chatId || ''
  };
  console.log('Configuration loaded (Env vars take priority).');
}
loadConfig();

// Global Telegram Client
let client = null;
let keepAliveInterval = null;
let sessionSaveInterval = null;
let isReconnecting = false;

// Temporary authentication sessions map
const activeAuths = new Map();

// Upload progress map
const uploadProgress = new Map();

// ============================================================
// TELEGRAM CLIENT INITIALIZATION
// ============================================================
async function initTelegram() {
  if (config.apiId && config.apiHash && config.sessionString) {
    console.log('Initializing Telegram client from saved session...');
    const isAndroidKey = parseInt(config.apiId) === 6;
    client = new TelegramClient(
      new StringSession(config.sessionString),
      parseInt(config.apiId),
      config.apiHash,
      {
        connectionRetries: 10,
        deviceModel: isAndroidKey ? 'Android' : 'Webogram',
        systemVersion: isAndroidKey ? '11.0' : '1.0',
        appVersion: isAndroidKey ? '8.4.1' : '1.0'
      }
    );
    try {
      await client.connect();
      console.log('Telegram client connected successfully.');
      db.logActivity('System', 'Telegram client connected successfully on startup');

      // Start keep-alive ping every 60 seconds
      startKeepAlive();

      // Start session save interval every 5 minutes
      startSessionSave();
    } catch (err) {
      console.error('Failed to connect Telegram client:', err);
      db.logActivity('System', 'Failed to connect Telegram client: ' + err.message, 'error');
      // Schedule auto-reconnect
      scheduleReconnect();
    }
  } else {
    console.log('No Telegram session found. Please complete the login setup.');
  }
}
initTelegram();

// ============================================================
// RECONNECT & KEEP-ALIVE
// ============================================================
async function ensureConnection() {
  if (client && client.connected) return true;
  if (isReconnecting) return false;

  isReconnecting = true;
  let attempt = 0;
  const maxAttempts = 20;
  const baseDelay = 2000; // 2 seconds

  while (attempt < maxAttempts) {
    attempt++;
    try {
      if (!client) return false;
      await client.connect();
      if (client.connected) {
        console.log(`Reconnected successfully after ${attempt} attempt(s).`);
        isReconnecting = false;
        startKeepAlive();
        return true;
      }
    } catch (err) {
      const delay = Math.min(baseDelay * Math.pow(2, attempt - 1), 60000); // Exponential backoff, max 60s
      console.log(`Reconnect attempt ${attempt}/${maxAttempts} failed: ${err.message}. Retrying in ${delay/1000}s...`);
      await new Promise(r => setTimeout(r, delay));
    }
  }

  console.error('Reconnection failed after max attempts.');
  isReconnecting = false;
  return false;
}

function startKeepAlive() {
  if (keepAliveInterval) clearInterval(keepAliveInterval);
  keepAliveInterval = setInterval(async () => {
    if (client && client.connected) {
      try {
        // Simple ping — invoke getMe to test the connection
        await client.invoke(new Api.users.GetFullUser({ id: 'me' }));
      } catch (err) {
        console.log('Keep-alive ping failed, initiating reconnect...', err.message);
        if (keepAliveInterval) clearInterval(keepAliveInterval);
        scheduleReconnect();
      }
    }
  }, 60000); // Every 60 seconds
}

function scheduleReconnect() {
  if (isReconnecting) return;
  isReconnecting = true;
  console.log('Scheduling auto-reconnect in 5 seconds...');
  setTimeout(async () => {
    await ensureConnection();
  }, 5000);
}

function startSessionSave() {
  if (sessionSaveInterval) clearInterval(sessionSaveInterval);
  sessionSaveInterval = setInterval(() => {
    if (client && client.session) {
      try {
        const sessionString = client.session.save();
        // We update the config object with latest session
        config.sessionString = sessionString;
        // Also save to config.json for persistence
        saveConfigToFile();
        console.log('Session string auto-saved to config.');
      } catch (err) {
        // silent
      }
    }
  }, 300000); // Every 5 minutes
}

// ============================================================
// GRACEFUL SHUTDOWN
// ============================================================
async function shutdown(signal) {
  console.log(`\n${signal} received. Shutting down gracefully...`);
  if (keepAliveInterval) clearInterval(keepAliveInterval);
  if (sessionSaveInterval) clearInterval(sessionSaveInterval);

  // Save session one last time
  if (client && client.session) {
    try {
      config.sessionString = client.session.save();
      saveConfigToFile();
      console.log('Session saved on shutdown.');
    } catch (err) { /* silent */ }
  }

  // Disconnect Telegram client
  if (client && client.connected) {
    try {
      await client.disconnect();
      console.log('Telegram client disconnected.');
    } catch (err) { console.log('Disconnect error:', err.message); }
  }

  db.logActivity('System', `Server shutdown (${signal})`);
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
  db.logActivity('System', 'Uncaught Exception: ' + err.message, 'error');
  // Don't exit; let the process restart handler manage it
});
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled Rejection:', reason);
});

function saveConfigToFile() {
  try {
    const configPath = path.join(dataDir, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
  } catch (err) {
    console.error('Failed to save config file:', err.message);
  }
}

// ============================================================
// HELPERS
// ============================================================
function getCategory(filename, mimeType) {
  const ext = path.extname(filename).toLowerCase().replace('.', '');
  const imageExts = ['jpg','jpeg','png','gif','bmp','webp','svg','tiff','ico','heic','heif','avif'];
  const videoExts = ['mp4','mkv','avi','mov','webm','wmv','flv','3gp','m4v','ts'];
  const audioExts = ['mp3','wav','ogg','m4a','flac','aac','wma','opus'];
  if (mimeType.startsWith('image/') || imageExts.includes(ext)) return 'image';
  if (mimeType.startsWith('video/') || videoExts.includes(ext)) return 'video';
  if (mimeType.startsWith('audio/') || audioExts.includes(ext)) return 'audio';
  return 'document';
}

function getSmallestThumb(media) {
  if (!media) return null;
  const doc = media.document;
  if (!doc) return null;
  const thumbs = doc.thumbs || [];
  if (thumbs.length === 0) {
    if (doc.thumbnail) return doc.thumbnail;
    if (doc.thumb) return doc.thumb;
    return null;
  }
  const sorted = [...thumbs].sort((a, b) => {
    const areaA = (a.w || 0) * (a.h || 0) || a.size || 0;
    const areaB = (b.w || 0) * (b.h || 0) || b.size || 0;
    return areaA - areaB;
  });
  return sorted[0];
}

async function downloadTelegramThumb(message) {
  if (!message || !message.media) return null;
  const thumbObj = getSmallestThumb(message.media);
  if (!thumbObj) return null;
  try {
    await ensureConnection();
    const buf = await client.downloadMedia(message.media, { thumbSize: thumbObj });
    if (buf && buf.length > 0 && buf.length < 500 * 1024) {
      return buf;
    }
  } catch (err) {
    console.error('Failed to download smallest thumbnail object:', err.message);
  }
  return null;
}

function generateFileKey() { return Math.random().toString(36).substring(2,15) + Math.random().toString(36).substring(2,15); }

// Image compression function using Sharp
async function compressImage(inputBuffer, maxDimension = 1920, quality = 80) {
  if (!sharp) return inputBuffer; // Sharp not available, return original
  try {
    const metadata = await sharp(inputBuffer).metadata();
    // Only compress if it's a compressible format
    if (!metadata.format || ['svg', 'gif'].includes(metadata.format)) {
      return inputBuffer; // Skip SVG and GIF (animated)
    }
    const result = await sharp(inputBuffer)
      .resize(maxDimension, maxDimension, {
        fit: 'inside',
        withoutEnlargement: true
      })
      .webp({ quality, effort: 4 })
      .toBuffer();
    return result;
  } catch (err) {
    console.error('Image compression error:', err.message);
    return inputBuffer; // Fallback: return original
  }
}

// ============================================================
// CONFIG CHECK MIDDLEWARE
// ============================================================
function checkConfig(req, res, next) {
  if (!config.sessionString || !config.apiId || !config.apiHash || !config.chatId) {
    return res.status(400).json({ error: 'Konfigurasi Telegram belum lengkap.', configured: false });
  }
  if (!client || !client.connected) {
    return res.status(400).json({ error: 'Telegram Client tidak terhubung. Silakan hubungkan kembali.', configured: true, connected: false });
  }
  next();
}

// ============================================================
// API ENDPOINTS
// ============================================================

// --- Health Check (for Railway) ---
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    telegram: client ? client.connected : false,
    timestamp: new Date().toISOString()
  });
});

// 1. Settings state
app.get('/api/settings', (req, res) => {
  res.json({
    configured: !!(config.apiId && config.apiHash && config.sessionString),
    apiId: config.apiId || '',
    chatId: config.chatId || '',
    connected: client ? client.connected : false
  });
});

// 2. Configure Telegram settings
app.post('/api/settings', async (req, res) => {
  const { chatId } = req.body;
  if (!chatId) return res.status(400).json({ error: 'Chat ID diperlukan.' });
  try {
    config.chatId = chatId;
    saveConfigToFile();
    db.logActivity('Config', `Memperbarui Chat ID penyimpanan menjadi: ${chatId}`);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Gagal menyimpan konfigurasi: ' + err.message });
  }
});

// 3. Auth Flow - Step 1: Send OTP Code
app.post('/api/auth/send-code', async (req, res) => {
  let { apiId, apiHash, phone } = req.body;
  if (!phone) return res.status(400).json({ error: 'Nomor Telepon diperlukan.' });
  if (!apiId) apiId = 6;
  if (!apiHash) apiHash = 'eb06d4abfb49dc3eeb1aeb98ae0f581e';

  try {
    console.log(`Initiating login for phone: ${phone}...`);
    db.logActivity('Auth', `Memulai login untuk nomor telepon ${phone}`);

    const tempSession = new StringSession('');
    const tempClient = new TelegramClient(tempSession, parseInt(apiId), apiHash, {
      connectionRetries: 5,
      deviceModel: 'Android',
      systemVersion: '11.0',
      appVersion: '8.4.1'
    });
    await tempClient.connect();

    const { phoneCodeHash } = await tempClient.sendCode({
      apiId: parseInt(apiId),
      apiHash: apiHash
    }, phone);

    const authId = 'auth-' + Date.now() + '-' + Math.random().toString(36).substr(2, 5);
    activeAuths.set(authId, { client: tempClient, phone, apiId, apiHash, phoneCodeHash });

    db.logActivity('Auth', `Kode OTP dikirim ke akun Telegram untuk nomor ${phone}`);
    res.json({ success: true, authId });
  } catch (err) {
    console.error('Failed to send OTP code:', err);
    db.logActivity('Auth', `Gagal mengirim kode OTP ke ${phone}: ${err.message}`, 'error');
    res.status(500).json({ error: err.message });
  }
});

// 3b. Auth Flow - Step 2: Sign In
app.post('/api/auth/sign-in', async (req, res) => {
  const { authId, code, password, chatId } = req.body;
  if (!authId || !code) return res.status(400).json({ error: 'Auth ID dan Kode OTP diperlukan.' });

  const auth = activeAuths.get(authId);
  if (!auth) return res.status(400).json({ error: 'Sesi otentikasi kedaluwarsa atau tidak ditemukan.' });

  try {
    console.log(`Signing in for phone: ${auth.phone} with code: ${code}...`);
    let user;

    try {
      const result = await auth.client.invoke(
        new Api.auth.SignIn({
          phoneNumber: auth.phone,
          phoneCodeHash: auth.phoneCodeHash,
          phoneCode: code
        })
      );
      if (result.className === 'auth.AuthorizationSignUpRequired') {
        return res.status(400).json({ error: 'Nomor telepon belum terdaftar di Telegram.' });
      }
      user = result.user;
    } catch (err) {
      if (err.message.includes('SESSION_PASSWORD_NEEDED') || err.errorMessage === 'SESSION_PASSWORD_NEEDED') {
        if (!password) {
          return res.json({ success: false, requires2FA: true, error: 'Akun Anda dilindungi Verifikasi 2 Langkah (2FA). Silakan masukkan password 2FA Anda.' });
        }
        console.log(`Attempting 2FA sign in with password SRP...`);
        const passwordSrpResult = await auth.client.invoke(new Api.account.GetPassword());
        const passwordSrpCheck = await computeCheck(passwordSrpResult, password);
        const checkResult = await auth.client.invoke(
          new Api.auth.CheckPassword({ password: passwordSrpCheck })
        );
        user = checkResult.user;
      } else {
        throw err;
      }
    }

    // Authenticated successfully! Save session
    const sessionString = auth.client.session.save();

    // Stop old client keep-alive and replace
    if (keepAliveInterval) clearInterval(keepAliveInterval);
    if (sessionSaveInterval) clearInterval(sessionSaveInterval);
    if (client) {
      try { await client.disconnect(); } catch {}
    }

    client = auth.client;
    startKeepAlive();
    startSessionSave();

    config = {
      apiId: auth.apiId,
      apiHash: auth.apiHash,
      sessionString,
      chatId: chatId || config.chatId || ''
    };
    saveConfigToFile();
    activeAuths.delete(authId);

    db.logActivity('Auth', `Akun ${auth.phone} berhasil login ke cloud drive.`);
    res.json({ success: true });
  } catch (err) {
    console.error('Sign in failed:', err);
    db.logActivity('Auth', `Login gagal: ${err.message}`, 'error');
    res.status(400).json({ error: err.message });
  }
});

// 3c. Logout
app.post('/api/logout', async (req, res) => {
  db.logActivity('Auth', 'Pengguna keluar dari sesi cloud drive.');
  if (keepAliveInterval) clearInterval(keepAliveInterval);
  if (sessionSaveInterval) clearInterval(sessionSaveInterval);
  if (client) {
    try { await client.disconnect(); } catch {}
    client = null;
  }
  config = { apiId: '', apiHash: '', sessionString: '', chatId: '' };
  try {
    const configPath = path.join(dataDir, 'config.json');
    if (fs.existsSync(configPath)) fs.unlinkSync(configPath);
  } catch {}
  res.json({ success: true });
});

// 4. File list
app.get('/api/files', checkConfig, (req, res) => {
  try { res.json(db.getFiles(req.query.search, req.query.category)); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// 5. File Upload
app.post('/api/upload', checkConfig, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Tidak ada file.' });

  const filePath = req.file.path;
  const originalName = req.file.originalname;
  const mimeType = req.file.mimetype || 'application/octet-stream';
  const totalSize = req.file.size;
  const category = getCategory(originalName, mimeType);
  const fileKey = generateFileKey();
  const uploadId = req.headers['x-upload-id'] || fileKey;

  // Duplicate check
  const existing = db.getFileByNameAndSize(originalName, totalSize);
  if (existing) {
    console.log(`Skipping duplicate upload: ${originalName} (Already exists)`);
    db.logActivity('Upload', `Unggahan dilewati karena duplikat: ${originalName}`);
    try { if (fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch {}
    uploadProgress.set(uploadId, { total: 100, uploaded: 100, status: 'done', fileKey: existing.file_key, filename: originalName });
    setTimeout(() => uploadProgress.delete(uploadId), 10000);
    return res.json({ success: true, fileKey: existing.file_key, skipped: true });
  }

  uploadProgress.set(uploadId, { total: 100, uploaded: 0, status: 'uploading', fileKey, filename: originalName });

  console.log(`Starting MTProto upload: ${originalName} (${totalSize}B)`);
  db.logActivity('Upload', `Memulai unggah berkas ${originalName} (${(totalSize / 1024 / 1024).toFixed(2)} MB)`);

  const tempDir2 = path.join(uploadDir, uploadId);
  const tempFilePath = path.join(tempDir2, path.basename(originalName));

  try {
    fs.mkdirSync(tempDir2, { recursive: true });
    fs.renameSync(filePath, tempFilePath);

    await ensureConnection();

    const message = await client.sendFile(config.chatId, {
      file: tempFilePath,
      forceDocument: true,
      workers: 4,
      progressCallback: (progress) => {
        const pct = Math.round(progress * 100);
        const p = uploadProgress.get(uploadId);
        if (p) p.uploaded = pct;
      }
    });

    // Cleanup local temp file
    try {
      if (fs.existsSync(tempFilePath)) fs.unlinkSync(tempFilePath);
      if (fs.existsSync(tempDir2)) fs.rmdirSync(tempDir2);
    } catch {}

    if (!message || !message.media || !message.media.document) {
      throw new Error('Telegram did not return a valid document media object.');
    }

    const doc = message.media.document;
    const telegramMediaId = message.id.toString();
    const accessHash = doc.accessHash.toString();
    const fileReference = doc.fileReference.toString('hex');
    const dcId = doc.dcId;

    // Cache thumbnail immediately
    let telegramThumbId = null;
    try {
      const thumbBuffer = await downloadTelegramThumb(message);
      if (thumbBuffer) {
        const ext = path.extname(originalName) || '';
        fs.writeFileSync(path.join(thumbDir, `${fileKey}${ext}`), thumbBuffer);
        console.log(`Generated thumbnail for ${originalName} (${thumbBuffer.length} bytes)`);
        telegramThumbId = 'local_cached';
      }
    } catch (thumbErr) {
      console.log('Failed to cache thumbnail on upload:', thumbErr.message);
    }

    db.saveFile(fileKey, originalName, mimeType, category, totalSize, telegramMediaId, accessHash, fileReference, telegramThumbId, dcId);
    db.logActivity('Upload', `Selesai mengunggah ${originalName} ke Telegram`);

    const p = uploadProgress.get(uploadId);
    if (p) { p.status = 'done'; p.fileKey = fileKey; p.uploaded = 100; }
    setTimeout(() => uploadProgress.delete(uploadId), 30000);

    res.json({ success: true, fileKey });
  } catch (err) {
    console.error('Upload failed:', err);
    db.logActivity('Upload', `Gagal mengunggah ${originalName}: ${err.message}`, 'error');
    if (fs.existsSync(filePath)) try { fs.unlinkSync(filePath); } catch {}
    try { if (fs.existsSync(tempFilePath)) fs.unlinkSync(tempFilePath); if (fs.existsSync(tempDir2)) fs.rmdirSync(tempDir2); } catch {}
    const p = uploadProgress.get(uploadId);
    if (p) { p.status = 'error'; }
    res.status(500).json({ error: err.message });
  }
});

// 5b. Upload progress SSE
app.get('/api/upload-progress/:uploadId', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const { uploadId } = req.params;
  const interval = setInterval(() => {
    const p = uploadProgress.get(uploadId);
    if (p) {
      res.write(`data: ${JSON.stringify(p)}\n\n`);
      if (p.status === 'done' || p.status === 'error') {
        clearInterval(interval);
        res.end();
      }
    } else {
      res.write(`data: ${JSON.stringify({ status: 'unknown' })}\n\n`);
    }
  }, 500);

  req.on('close', () => clearInterval(interval));
});

// 5c. Get all active background uploads
app.get('/api/uploads', (req, res) => {
  const uploads = {};
  uploadProgress.forEach((value, key) => { uploads[key] = value; });
  res.json(uploads);
});

// 6. Thumbnail endpoint — with Sharp fallback for images
app.get('/api/thumb/:fileKey', checkConfig, async (req, res) => {
  const { fileKey } = req.params;
  try {
    const file = db.getFile(fileKey);
    if (!file) return res.status(404).end();

    const ext = path.extname(file.filename) || '';
    
    // Check for existing thumbnail (both original extension and .webp)
    const thumbPath = path.join(thumbDir, `${fileKey}${ext}`);
    const thumbWebpPath = path.join(thumbDir, `${fileKey}.webp`);
    
    if (fs.existsSync(thumbPath)) {
      return res.sendFile(thumbPath);
    }
    if (fs.existsSync(thumbWebpPath)) {
      res.setHeader('Content-Type', 'image/webp');
      return res.sendFile(thumbWebpPath);
    }

    if (!file.telegram_media_id) return res.status(404).end();

    // 1st attempt: Download Telegram native thumbnail
    console.log(`Downloading thumbnail dynamically for: ${file.filename}`);
    await ensureConnection();
    const messages = await client.getMessages(config.chatId, { ids: [parseInt(file.telegram_media_id)] });

    if (messages && messages.length > 0 && messages[0].media) {
      const thumbBuffer = await downloadTelegramThumb(messages[0]);
      if (thumbBuffer) {
        fs.writeFileSync(thumbPath, thumbBuffer);
        db.updateFileThumb(fileKey, 'local_cached');
        return res.sendFile(thumbPath);
      }
    }

    // 2nd attempt (images only): Generate thumbnail from file using Sharp
    if (file.category === 'image' && sharp) {
      // Use a temp file (NOT persistent volume) to avoid filling storage
      const tmpPath = path.join(require('os').tmpdir(), `thumb_tmp_${fileKey}${ext}`);
      
      try {
        console.log(`Downloading file for thumbnail generation: ${file.filename}`);
        await ensureConnection();
        const msgs = await client.getMessages(config.chatId, { ids: [parseInt(file.telegram_media_id)] });
        if (msgs && msgs.length > 0 && msgs[0].media) {
          await client.downloadMedia(msgs[0].media, {
            outputFile: tmpPath,
            workers: 4
          });
        }

        if (fs.existsSync(tmpPath)) {
          const thumbBuffer = await sharp(tmpPath)
            .resize(300, 300, { fit: 'cover', position: 'centre' })
            .webp({ quality: 65 })
            .toBuffer();
          fs.writeFileSync(thumbWebpPath, thumbBuffer);
          db.updateFileThumb(fileKey, 'local_cached');
          res.setHeader('Content-Type', 'image/webp');
          console.log(`Sharp thumbnail generated: ${file.filename}`);
          
          // IMPORTANT: Delete temp file immediately to save storage
          try { fs.unlinkSync(tmpPath); } catch {}
          
          return res.send(thumbBuffer);
        }
      } catch (sharpErr) {
        console.error('Sharp thumbnail generation failed:', sharpErr.message);
        // Clean up temp file on error too
        try { fs.unlinkSync(tmpPath); } catch {}
      }
    }

    return res.status(404).end();
  } catch (err) {
    console.error('Thumbnail error:', err);
    if (!res.headersSent) res.status(500).end();
  }
});

// 7. Preview (with image compression for images)
app.get('/api/preview/:fileKey', checkConfig, async (req, res) => {
  const { fileKey } = req.params;
  try {
    const file = db.getFile(fileKey);
    if (!file) return res.status(404).json({ error: 'File tidak ditemukan.' });
    if (!file.telegram_media_id) {
      return res.status(400).json({ error: 'Berkas lama tidak didukung pada skema login MTProto baru. Silakan unggah kembali berkas ini.' });
    }

    const ext = path.extname(file.filename) || '';
    const cachedPath = path.join(cacheDir, `${fileKey}${ext}`);
    const compressedPath = path.join(cacheDir, `${fileKey}.webp`);

    // For images, use compressed preview if available
    if (file.category === 'image') {
      // Check if compressed version already exists
      if (fs.existsSync(compressedPath)) {
        res.setHeader('Content-Type', 'image/webp');
        return res.sendFile(compressedPath);
      }

      // Download original from Telegram
      if (!fs.existsSync(cachedPath)) {
        console.log(`Downloading file for preview: ${file.filename}`);
        db.logActivity('Download', `Mengunduh ${file.filename} untuk pratinjau`);
        await ensureConnection();
        const messages = await client.getMessages(config.chatId, { ids: [parseInt(file.telegram_media_id)] });
        if (!messages || messages.length === 0 || !messages[0].media) {
          throw new Error('Pesan atau media tidak ditemukan di Telegram.');
        }
        await client.downloadMedia(messages[0].media, {
          outputFile: cachedPath,
          workers: 4
        });
        console.log(`Cached original: ${file.filename}`);
      }

      // Compress the image with Sharp
      try {
        const originalBuffer = fs.readFileSync(cachedPath);
        const compressedBuffer = await compressImage(originalBuffer, 1920, 80);
        if (compressedBuffer.length < originalBuffer.length) {
          // Compressed is smaller — save and serve compressed
          fs.writeFileSync(compressedPath, compressedBuffer);
          console.log(`Compressed preview: ${file.filename} (${(originalBuffer.length/1024).toFixed(0)}KB → ${(compressedBuffer.length/1024).toFixed(0)}KB)`);
          res.setHeader('Content-Type', 'image/webp');
          return res.send(compressedBuffer);
        } else {
          // Compression didn't help, serve original
          res.setHeader('Content-Type', file.mime_type || 'application/octet-stream');
          return res.sendFile(cachedPath);
        }
      } catch (compressErr) {
        console.log('Compression failed, serving original:', compressErr.message);
        res.setHeader('Content-Type', file.mime_type || 'application/octet-stream');
        return res.sendFile(cachedPath);
      }
    }

    // For non-images, serve cached original
    if (!fs.existsSync(cachedPath)) {
      console.log(`Downloading file for preview: ${file.filename}`);
      await ensureConnection();
      const messages = await client.getMessages(config.chatId, { ids: [parseInt(file.telegram_media_id)] });
      if (!messages || messages.length === 0 || !messages[0].media) {
        throw new Error('Pesan atau media tidak ditemukan di Telegram.');
      }
      await client.downloadMedia(messages[0].media, {
        outputFile: cachedPath,
        workers: 4
      });
      console.log(`Cached file: ${file.filename}`);
    }

    res.setHeader('Content-Type', file.mime_type || 'application/octet-stream');
    res.sendFile(cachedPath);
  } catch (err) {
    console.error('Preview error:', err);
    db.logActivity('Download', `Gagal mengunduh pratinjau: ${err.message}`, 'error');
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
});

// 7b. Download Original (bypass compression, direct file download)
app.get('/api/download-original/:fileKey', checkConfig, async (req, res) => {
  const { fileKey } = req.params;
  try {
    const file = db.getFile(fileKey);
    if (!file) return res.status(404).json({ error: 'File tidak ditemukan.' });
    if (!file.telegram_media_id) {
      return res.status(400).json({ error: 'Berkas lama tidak didukung pada skema login MTProto baru.' });
    }

    const ext = path.extname(file.filename) || '';
    const cachedPath = path.join(cacheDir, `${fileKey}${ext}`);

    if (!fs.existsSync(cachedPath)) {
      console.log(`Downloading original file: ${file.filename}`);
      db.logActivity('Download', `Mengunduh berkas asli ${file.filename}`);
      await ensureConnection();
      const messages = await client.getMessages(config.chatId, { ids: [parseInt(file.telegram_media_id)] });
      if (!messages || messages.length === 0 || !messages[0].media) {
        throw new Error('Pesan atau media tidak ditemukan di Telegram.');
      }
      await client.downloadMedia(messages[0].media, {
        outputFile: cachedPath,
        workers: 4
      });
    }

    res.setHeader('Content-Type', file.mime_type || 'application/octet-stream');
    res.download(cachedPath, file.filename);
  } catch (err) {
    console.error('Download original error:', err);
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
});

// 8. Stream endpoint
app.get('/api/stream/:fileKey', checkConfig, async (req, res) => {
  const { fileKey } = req.params;
  try {
    const file = db.getFile(fileKey);
    if (!file) return res.status(404).json({ error: 'File tidak ditemukan.' });
    if (!file.telegram_media_id) {
      return res.status(400).json({ error: 'Berkas lama tidak didukung pada skema login MTProto baru.' });
    }

    const ext = path.extname(file.filename) || '';
    const cachedPath = path.join(cacheDir, `${fileKey}${ext}`);

    if (!fs.existsSync(cachedPath)) {
      console.log(`Downloading file for stream: ${file.filename}`);
      await ensureConnection();
      const messages = await client.getMessages(config.chatId, { ids: [parseInt(file.telegram_media_id)] });
      if (!messages || messages.length === 0 || !messages[0].media) {
        throw new Error('Pesan atau media tidak ditemukan di Telegram.');
      }
      await client.downloadMedia(messages[0].media, {
        outputFile: cachedPath,
        workers: 4
      });
    }

    res.setHeader('Content-Type', file.mime_type || 'application/octet-stream');
    res.sendFile(cachedPath);
  } catch (err) {
    console.error('Stream error:', err);
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
});

// 9. Download (attachment)
app.get('/api/download/:fileKey', checkConfig, async (req, res) => {
  const { fileKey } = req.params;
  try {
    const file = db.getFile(fileKey);
    if (!file) return res.status(404).json({ error: 'File tidak ditemukan.' });
    if (!file.telegram_media_id) {
      return res.status(400).json({ error: 'Berkas lama tidak didukung pada skema login MTProto baru.' });
    }

    const ext = path.extname(file.filename) || '';
    const cachedPath = path.join(cacheDir, `${fileKey}${ext}`);

    if (!fs.existsSync(cachedPath)) {
      console.log(`Downloading file for download: ${file.filename}`);
      await ensureConnection();
      const messages = await client.getMessages(config.chatId, { ids: [parseInt(file.telegram_media_id)] });
      if (!messages || messages.length === 0 || !messages[0].media) {
        throw new Error('Pesan atau media tidak ditemukan di Telegram.');
      }
      await client.downloadMedia(messages[0].media, {
        outputFile: cachedPath,
        workers: 4
      });
    }

    res.download(cachedPath, file.filename);
  } catch (err) {
    console.error('Download error:', err);
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
});

// 10. Delete
app.delete('/api/files/:fileKey', checkConfig, async (req, res) => {
  const { fileKey } = req.params;
  try {
    const file = db.getFile(fileKey);
    if (!file) return res.status(404).json({ error: 'File tidak ditemukan.' });

    // Delete message from Telegram
    try {
      await ensureConnection();
      await client.deleteMessages(config.chatId, [parseInt(file.telegram_media_id)], { revoke: true });
      db.logActivity('Delete', `Berhasil menghapus berkas ${file.filename} dari Telegram`);
    } catch (delErr) {
      console.log("Failed to delete message in Telegram:", delErr.message);
    }

    db.deleteFile(fileKey);

    // Clean cache & thumb & compressed
    const ext = path.extname(file.filename) || '';
    [
      path.join(cacheDir, `${fileKey}${ext}`),
      path.join(thumbDir, `${fileKey}${ext}`),
      path.join(cacheDir, `${fileKey}.webp`)  // compressed preview
    ].forEach(f => {
      if (fs.existsSync(f)) try { fs.unlinkSync(f); } catch {}
    });

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 10.5 Reset all files
app.post('/api/reset', checkConfig, async (req, res) => {
  try {
    const files = db.getFiles('', 'all');
    for (const file of files) {
      const ext = path.extname(file.filename) || '';
      const cached = path.join(cacheDir, `${file.file_key}${ext}`);
      const thumb = path.join(thumbDir, `${file.file_key}${ext}`);
      const compressed = path.join(cacheDir, `${file.file_key}.webp`);
      if (fs.existsSync(cached)) try { fs.unlinkSync(cached); } catch {}
      if (fs.existsSync(thumb)) try { fs.unlinkSync(thumb); } catch {}
      if (fs.existsSync(compressed)) try { fs.unlinkSync(compressed); } catch {}
    }

    if (fs.existsSync(uploadDir)) {
      const items = fs.readdirSync(uploadDir);
      for (const item of items) {
        const fullPath = path.join(uploadDir, item);
        try {
          if (fs.statSync(fullPath).isDirectory()) {
            fs.rmSync(fullPath, { recursive: true, force: true });
          } else {
            fs.unlinkSync(fullPath);
          }
        } catch {}
      }
    }

    db.clearAllFiles();
    db.logActivity('System', 'Melakukan reset data drive, menghapus semua berkas.');
    res.json({ success: true });
  } catch (err) {
    console.error('Reset error:', err);
    res.status(500).json({ error: err.message });
  }
});

// 11. Activity logs
app.get('/api/logs', (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 100;
    res.json(db.getLogs(limit));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 13. Sync — Scan Telegram channel and add missing files to database
let syncInProgress = false;

app.post('/api/sync', checkConfig, async (req, res) => {
  if (syncInProgress) {
    return res.json({ success: true, message: 'Sync sudah berjalan...' });
  }
  syncInProgress = true;
  res.json({ success: true, message: 'Memulai sinkronisasi...' });

  // Continue in background
  syncAllFromChannel().then(result => {
    syncInProgress = false;
    console.log(`Sync selesai: ${result.added} file baru ditambahkan, ${result.skipped} sudah ada.`);
  }).catch(err => {
    syncInProgress = false;
    console.error('Sync error:', err.message);
  });
});

async function syncAllFromChannel() {
  let added = 0;
  let skipped = 0;
  let offsetId = 0;

  console.log('Memulai sinkronisasi dari channel Telegram...');
  db.logActivity('Sync', 'Memulai sinkronisasi dari channel Telegram...');

  await ensureConnection();

  while (true) {
    try {
      const result = await client.invoke(new Api.messages.GetHistory({
        peer: config.chatId,
        offsetId: offsetId,
        offsetDate: 0,
        addOffset: 0,
        limit: 100,
        maxId: 0,
        minId: 0,
        hash: 0
      }));

      const messages = result.messages || [];
      if (messages.length === 0) break;

      for (const msg of messages) {
        // Skip empty messages or non-document media
        if (!msg.media || !msg.media.document) continue;

        const doc = msg.media.document;
        const filename = (doc.attributes || [])
          .filter(a => a.className === 'DocumentAttributeFilename')
          .map(a => a.fileName)[0] || `file_${msg.id}`;
        const mimeType = doc.mimeType || 'application/octet-stream';
        // Convert Long/BigInt values to plain Number for SQLite binding
        const totalSize = typeof doc.size === 'object' && doc.size !== null ? Number(doc.size) : (parseInt(doc.size) || 0);
        const fileKey = `sync_${msg.id}`;

        // Check if file already exists by file_key (message ID)
        let existing;
        try { existing = db.getFile(fileKey); } catch { existing = null; }
        if (existing) {
          skipped++;
          continue;
        }

        const category = getCategory(filename, mimeType);
        const telegramMediaId = msg.id.toString();
        const accessHash = doc.accessHash ? (typeof doc.accessHash === 'object' ? doc.accessHash.toString() : String(doc.accessHash)) : '0';
        const fileReference = doc.fileReference ? (Buffer.isBuffer(doc.fileReference) ? doc.fileReference.toString('hex') : String(doc.fileReference)) : '';
        const dcId = typeof doc.dcId === 'object' && doc.dcId !== null ? Number(doc.dcId) : (parseInt(doc.dcId) || 4);

        db.saveFile(fileKey, filename, mimeType, category, totalSize, telegramMediaId, accessHash, fileReference, null, dcId);
        added++;

        // Download thumbnail in background (non-blocking)
        try {
          const thumbBuffer = await downloadTelegramThumb(msg);
          if (thumbBuffer) {
            const ext = path.extname(filename) || '';
            fs.writeFileSync(path.join(thumbDir, `${fileKey}${ext}`), thumbBuffer);
            db.updateFileThumb(fileKey, 'local_cached');
          }
        } catch (thumbErr) {
          // Silently fail thumbnail download
        }
      }

      // Update offset to get older messages (pagination)
      if (messages.length > 0) {
        offsetId = messages[messages.length - 1].id;
      }

      // If less than 100 messages, we've reached the end
      if (messages.length < 100) break;

      // Small delay to avoid rate limiting
      await new Promise(r => setTimeout(r, 200));
    } catch (err) {
      console.error('Sync batch error:', err.message);
      break;
    }
  }

  const result = { added, skipped };
  db.logActivity('Sync', `Sinkronisasi selesai: ${result.added} file baru, ${result.skipped} sudah ada.`);
  return result;
}

// 14. Sync status
app.get('/api/sync-status', (req, res) => {
  res.json({ syncing: syncInProgress });
});

// 15. Stats
app.get('/api/stats', (req, res) => {
  try { res.json(db.getStats()); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// Catch-all — serve frontend
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Startup: Clean up cache directory to free volume space
function cleanupCacheDir() {
  try {
    const files = fs.readdirSync(cacheDir);
    let freedBytes = 0;
    let count = 0;
    for (const f of files) {
      const fp = path.join(cacheDir, f);
      try {
        const stat = fs.statSync(fp);
        if (stat.isFile()) {
          freedBytes += stat.size;
          fs.unlinkSync(fp);
          count++;
        }
      } catch {}
    }
    if (count > 0) {
      console.log(`Startup cleanup: Deleted ${count} cached files, freed ${(freedBytes / 1024 / 1024).toFixed(1)} MB`);
    }
  } catch (err) {
    console.error('Cleanup error:', err.message);
  }
}
cleanupCacheDir();

app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT} (Data dir: ${dataDir})`));
