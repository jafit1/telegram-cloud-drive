const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const { pipeline } = require('stream/promises');
const { TelegramClient, Api } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { computeCheck } = require('telegram/Password');
const db = require('./database');
const auth = require('./auth');

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
// Railway terminates TLS at its edge, so honour X-Forwarded-For for
// per-IP login throttling and Secure cookies.
app.set('trust proxy', 1);
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Auth routes (must be registered before the /api gate) ──
app.post('/api/auth/login', auth.loginHandler);
app.post('/api/auth/logout', auth.logoutHandler);
app.get('/api/auth/status', auth.statusHandler);

// Settings status (read-only, used by the unauthenticated setup wizard to
// decide whether to show login or the Telegram setup flow — must not sit
// behind the auth gate, otherwise the wizard can never load.)
app.get('/api/settings/status', (req, res) => {
  res.json({
    configured: !!(config.apiId && config.apiHash && config.sessionString),
    apiIdSet: !!config.apiId,
    apiHashSet: !!config.apiHash,
    chatId: config.chatId || '',
    connected: client ? client.connected : false,
    sessionRevoked: telegramAuthState === 'revoked'
  });
});

// ── Gate: every other /api/* route requires a valid session ──
app.use('/api', auth.requireAuth);

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

// ── Telegram auth-key health ────────────────────────────────
// `client.connected` only tells us the TCP socket is up; it says nothing
// about whether Telegram still honours our auth key. A revoked key keeps
// connecting happily and then fails mid-upload with AUTH_KEY_UNREGISTERED,
// which is exactly how uploads broke silently. Track the real state here.
//   'ok'      — a request succeeded recently
//   'revoked' — Telegram rejected our key; only a fresh login fixes it
//   'unknown' — not yet proven either way
let telegramAuthState = config.sessionString ? 'unknown' : 'none';

const REVOCATION_PATTERN = /AUTH_KEY_UNREGISTERED|AUTH_KEY_INVALID|AUTH_KEY_DUPLICATED|SESSION_REVOKED|SESSION_EXPIRED|USER_DEACTIVATED/i;

function isRevocationError(err) {
  if (!err) return false;
  return REVOCATION_PATTERN.test(String(err.message || err.errorMessage || err));
}

const SESSION_REVOKED_MESSAGE =
  'Sesi Telegram sudah berakhir dan dicabut oleh Telegram. Buka Pengaturan, ' +
  'lalu hubungkan ulang akun Anda (login OTP) untuk memakai drive kembali.';

// Called from anywhere a Telegram request fails. Returns true when the
// failure was a revocation, so callers can answer 409 instead of 500.
function markRevokedIfNeeded(err, context) {
  if (!isRevocationError(err)) return false;
  if (telegramAuthState !== 'revoked') {
    telegramAuthState = 'revoked';
    if (keepAliveInterval) { clearInterval(keepAliveInterval); keepAliveInterval = null; }
    const detail = String(err.message || err);
    console.error(`Telegram session revoked (${context}): ${detail}`);
    try {
      db.logActivity('System', `Sesi Telegram dicabut (${context}): ${detail}. Login ulang diperlukan.`, 'error');
    } catch {}
  }
  return true;
}

// Temporary authentication sessions map.
// Entries hold a live TelegramClient, so abandoned logins must be reaped
// or they keep a connection open forever.
const activeAuths = new Map();
const AUTH_TTL_MS = 10 * 60 * 1000; // OTP codes expire well before this

setInterval(async () => {
  const now = Date.now();
  for (const [authId, entry] of activeAuths) {
    if (now - (entry.createdAt || 0) > AUTH_TTL_MS) {
      activeAuths.delete(authId);
      try { await entry.client?.disconnect(); } catch {}
      console.log(`Reaped abandoned auth session: ${authId}`);
    }
  }
}, 60 * 1000).unref();

// Upload progress map
const uploadProgress = new Map();

// ============================================================
// TELEGRAM CLIENT INITIALIZATION
// ============================================================
async function initTelegram() {
  if (config.apiId && config.apiHash && config.sessionString) {
    console.log('Initializing Telegram client from saved session...');
    client = new TelegramClient(
      new StringSession(config.sessionString),
      parseInt(config.apiId),
      config.apiHash,
      {
        connectionRetries: 10,
        deviceModel: 'Android',
        systemVersion: '11.0',
        appVersion: '8.4.1'
      }
    );
    try {
      await client.connect();
      console.log('Telegram client connected successfully.');

      // Connecting proves nothing about the auth key, so make one real request.
      // This is what turns a silent mid-upload failure into a startup diagnosis.
      try {
        await client.invoke(new Api.users.GetFullUser({ id: 'me' }));
        telegramAuthState = 'ok';
        db.logActivity('System', 'Telegram client connected successfully on startup');
      } catch (probeErr) {
        if (markRevokedIfNeeded(probeErr, 'startup probe')) {
          console.error('  -> Login ulang lewat Pengaturan diperlukan. Upload akan ditolak sampai itu dilakukan.');
          return; // no keep-alive, no reconnect — neither can help
        }
        console.warn('Startup probe failed (non-fatal):', probeErr.message);
      }

      // Start keep-alive ping every 60 seconds
      startKeepAlive();

      // Start session save interval every 5 minutes
      startSessionSave();
    } catch (err) {
      console.error('Failed to connect Telegram client:', err);
      db.logActivity('System', 'Failed to connect Telegram client: ' + err.message, 'error');
      if (markRevokedIfNeeded(err, 'startup')) return;
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
  if (telegramAuthState === 'revoked') {
    const err = new Error(SESSION_REVOKED_MESSAGE);
    err.sessionRevoked = true;
    throw err;
  }
  if (client && client.connected) return true;
  if (isReconnecting) {
    if (!client || !client.connected) {
      throw new Error('Telegram Client sedang menghubungkan kembali. Silakan coba sesaat lagi.');
    }
    return true;
  }

  isReconnecting = true;
  let attempt = 0;
  const maxAttempts = 5;
  const baseDelay = 1000;

  while (attempt < maxAttempts) {
    attempt++;
    try {
      if (!client) throw new Error('Telegram Client belum diinisialisasi.');
      await client.connect();
      if (client.connected) {
        console.log(`Reconnected successfully after ${attempt} attempt(s).`);
        isReconnecting = false;
        startKeepAlive();
        return true;
      }
    } catch (err) {
      if (isRevocationError(err)) {
        isReconnecting = false;
        markRevokedIfNeeded(err, 'reconnect');
        const revoked = new Error(SESSION_REVOKED_MESSAGE);
        revoked.sessionRevoked = true;
        throw revoked;
      }
      const delay = Math.min(baseDelay * Math.pow(2, attempt - 1), 10000);
      console.log(`Reconnect attempt ${attempt}/${maxAttempts} failed: ${err.message}. Retrying in ${delay/1000}s...`);
      await new Promise(r => setTimeout(r, delay));
    }
  }

  isReconnecting = false;
  throw new Error('Gagal menghubungkan ke Telegram setelah beberapa percobaan.');
}

function startKeepAlive() {
  if (keepAliveInterval) clearInterval(keepAliveInterval);
  keepAliveInterval = setInterval(async () => {
    if (client && client.connected) {
      try {
        // Simple ping — invoke getMe to test the connection
        await client.invoke(new Api.users.GetFullUser({ id: 'me' }));
        telegramAuthState = 'ok';
      } catch (err) {
        // A revoked auth key cannot be recovered by reconnecting — the socket
        // will come back up and every request will keep failing. Stop here and
        // surface it instead of looping forever.
        if (markRevokedIfNeeded(err, 'keep-alive')) return;
        console.log('Keep-alive ping failed, initiating reconnect...', err.message);
        if (keepAliveInterval) { clearInterval(keepAliveInterval); keepAliveInterval = null; }
        scheduleReconnect();
      }
    }
  }, 60000); // Every 60 seconds
}

function scheduleReconnect() {
  if (isReconnecting) return;
  if (telegramAuthState === 'revoked') return;
  isReconnecting = true;
  console.log('Scheduling auto-reconnect in 5 seconds...');
  setTimeout(() => {
    // ensureConnection() throws while isReconnecting is set, so the flag has to
    // be cleared before calling it. The .catch() matters just as much: an
    // unhandled rejection in here terminates the process on Node 22+.
    isReconnecting = false;
    ensureConnection().catch(err => {
      markRevokedIfNeeded(err, 'reconnect');
      console.error('Auto-reconnect failed:', err.message);
    });
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
  // A revocation surfacing here would otherwise be swallowed silently, leaving
  // the drive "connected" but unable to transfer anything.
  markRevokedIfNeeded(reason, 'unhandled rejection');
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

function getMimeTypeByFilename(filename) {
  const ext = path.extname(filename).toLowerCase();
  const mimeMap = {
    '.mp4': 'video/mp4',
    '.mkv': 'video/x-matroska',
    '.avi': 'video/x-msvideo',
    '.mov': 'video/quicktime',
    '.wmv': 'video/x-ms-wmv',
    '.mp3': 'audio/mpeg',
    '.wav': 'audio/wav',
    '.ogg': 'audio/ogg',
    '.pdf': 'application/pdf',
    '.txt': 'text/plain',
    '.zip': 'application/zip',
    '.rar': 'application/x-rar-compressed',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.webp': 'image/webp'
  };
  return mimeMap[ext] || 'application/octet-stream';
}

function groupSplitFiles(files) {  const groups = new Map(); // baseName -> Array of files
  const nonParts = [];

  files.forEach(f => {
    const match = f.filename.match(/(.+)\.part(\d+)$/i);
    if (match) {
      const baseName = match[1];
      const partNum = parseInt(match[2]);
      if (!groups.has(baseName)) {
        groups.set(baseName, []);
      }
      groups.get(baseName).push({ partNum, file: f });
    } else {
      nonParts.push(f);
    }
  });

  const result = [...nonParts];

  groups.forEach((partList, baseName) => {
    partList.sort((a, b) => a.partNum - b.partNum);
    
    const firstPart = partList[0].file;
    const totalSize = partList.reduce((sum, p) => sum + p.file.total_size, 0);
    const mimeType = getMimeTypeByFilename(baseName) || firstPart.mime_type;
    const category = getCategory(baseName, mimeType);

    result.push({
      id: firstPart.id,
      file_key: firstPart.file_key, // Use part1's file_key
      filename: baseName,
      mime_type: mimeType,
      category: category,
      total_size: totalSize,
      uploaded_at: firstPart.uploaded_at,
      telegram_media_id: firstPart.telegram_media_id,
      access_hash: firstPart.access_hash,
      file_reference: firstPart.file_reference,
      telegram_thumb_id: firstPart.telegram_thumb_id,
      dc_id: firstPart.dc_id,
      is_split: true,
      parts: partList.map(p => p.file)
    });
  });

  return result;
}

function resolveFileParts(fileKey) {
  const file = db.getFile(fileKey);
  if (!file) return null;

  const match = file.filename.match(/(.+)\.part(\d+)$/i);
  if (match) {
    const baseName = match[1];
    // Retrieve all files in DB to match baseName
    const allFiles = db.getFiles();
    const partFiles = allFiles.filter(f => {
      const m = f.filename.match(/(.+)\.part(\d+)$/i);
      return m && m[1] === baseName;
    });

    if (partFiles.length > 0) {
      partFiles.sort((a, b) => {
        const ma = a.filename.match(/\.part(\d+)$/i);
        const mb = b.filename.match(/\.part(\d+)$/i);
        return parseInt(ma[1]) - parseInt(mb[1]);
      });
      return {
        file,
        parts: partFiles,
        baseName,
        isSplit: true
      };
    }
  }

  return {
    file,
    parts: [file],
    baseName: file.filename,
    isSplit: false
  };
}

// ── Cache download de-duplication ───────────────────────────
// A video player issues several Range requests at once. Each one used to see
// an empty cache and start its own client.downloadMedia() into the *same*
// path, so the writers interleaved and left a corrupt file behind. Collapse
// concurrent work on one cache path into a single shared promise.
const inFlightCache = new Map(); // absolute path -> Promise

function dedupeCacheWork(key, fn) {
  const existing = inFlightCache.get(key);
  if (existing) return existing;
  const task = (async () => fn())().finally(() => inFlightCache.delete(key));
  inFlightCache.set(key, task);
  return task;
}

// Download one file from Telegram into the cache, exactly once, and never
// leave a truncated file that a later existsSync() would mistake for complete.
async function ensureCachedOriginal(file, fileKey, baseName, reason) {
  const ext = path.extname(baseName) || '';
  const targetPath = path.join(cacheDir, `${fileKey}${ext}`);
  if (fs.existsSync(targetPath)) return targetPath;

  return dedupeCacheWork(targetPath, async () => {
    if (fs.existsSync(targetPath)) return targetPath; // won by another caller
    const partialPath = `${targetPath}.partial`;
    console.log(`Downloading file (${reason}): ${file.filename}`);
    await ensureConnection();
    const messages = await client.getMessages(config.chatId, { ids: [parseInt(file.telegram_media_id)] });
    if (!messages || messages.length === 0 || !messages[0].media) {
      throw new Error('Pesan atau media tidak ditemukan di Telegram.');
    }
    try {
      await client.downloadMedia(messages[0].media, { outputFile: partialPath, workers: 4 });
      fs.renameSync(partialPath, targetPath);
    } catch (err) {
      try { if (fs.existsSync(partialPath)) fs.unlinkSync(partialPath); } catch {}
      markRevokedIfNeeded(err, 'download');
      throw err;
    }
    return targetPath;
  });
}

async function ensureMergedCache(fileKey, parts, baseName) {
  const ext = path.extname(baseName) || '';
  const mergedPath = path.join(cacheDir, `${fileKey}_merged${ext}`);
  if (fs.existsSync(mergedPath)) return mergedPath;

  return dedupeCacheWork(mergedPath, async () => {
    if (fs.existsSync(mergedPath)) return mergedPath;
    console.log(`Merging ${parts.length} parts for split file: ${baseName}`);

    // Ensure all individual parts are downloaded/cached first
    for (const part of parts) {
      const partExt = path.extname(part.filename) || '';
      const partCachePath = path.join(cacheDir, `${part.file_key}${partExt}`);
      if (!fs.existsSync(partCachePath)) {
        await ensureCachedOriginal(part, part.file_key, part.filename, 'part');
      }
    }

    // Append all parts sequentially.
    // Streamed rather than readFileSync'd: a split file is by definition larger
    // than Telegram's 2GB limit, so buffering a whole part in memory is how the
    // server runs out of heap. Write to a .partial and rename at the end, so an
    // interrupted merge can never leave a truncated file that looks complete.
    const partialPath = `${mergedPath}.partial`;
    try {
      const writeStream = fs.createWriteStream(partialPath);
      try {
        for (const part of parts) {
          const partExt = path.extname(part.filename) || '';
          const partCachePath = path.join(cacheDir, `${part.file_key}${partExt}`);
          // { end: false } keeps the destination open across parts; pipeline
          // would otherwise close it after the first one.
          await pipeline(fs.createReadStream(partCachePath), writeStream, { end: false });
        }
      } finally {
        writeStream.end();
      }
      await new Promise((resolve, reject) => {
        writeStream.on('finish', resolve);
        writeStream.on('error', reject);
      });
      fs.renameSync(partialPath, mergedPath);
    } catch (err) {
      try { if (fs.existsSync(partialPath)) fs.unlinkSync(partialPath); } catch {}
      throw err;
    }
    console.log(`Successfully merged parts into: ${mergedPath}`);
    return mergedPath;
  });
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
  // Check auth-key validity before socket state. A revoked key still reports
  // `connected: true`, which is why broken uploads used to look healthy.
  if (telegramAuthState === 'revoked') {
    return res.status(409).json({
      error: SESSION_REVOKED_MESSAGE,
      configured: true,
      connected: !!(client && client.connected),
      sessionRevoked: true
    });
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
  // Always 200: this is Railway's deploy gate, and a revoked Telegram session
  // is a user-fixable condition, not a reason to fail the whole deployment.
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    telegram: client ? client.connected : false,
    telegramAuth: telegramAuthState,
    timestamp: new Date().toISOString()
  });
});

// 1. Settings state
app.get('/api/settings', (req, res) => {
  res.json({
    configured: !!(config.apiId && config.apiHash && config.sessionString),
    apiId: config.apiId || '',
    chatId: config.chatId || '',
    connected: client ? client.connected : false,
    // Surfaced so the dashboard can warn on load rather than waiting for an
    // upload to fail.
    sessionRevoked: telegramAuthState === 'revoked'
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

  // Fall back to server-side env credentials, never to shared public ones.
  // The old default (apiId 6 + the official Android hash) is flagged by
  // Telegram's anti-abuse system and risks getting the account limited.
  if (!apiId) apiId = process.env.API_ID || '';
  if (!apiHash) apiHash = process.env.API_HASH || '';

  if (!apiId || !apiHash) {
    return res.status(400).json({
      error: 'API ID dan API Hash diperlukan. Daftarkan aplikasi Anda sendiri di my.telegram.org, lalu masukkan kredensialnya.'
    });
  }

  const parsedApiId = parseInt(apiId);
  if (!Number.isInteger(parsedApiId) || parsedApiId <= 0) {
    return res.status(400).json({ error: 'API ID harus berupa angka positif.' });
  }
  if (typeof apiHash !== 'string' || !/^[a-f0-9]{32}$/i.test(apiHash.trim())) {
    return res.status(400).json({ error: 'API Hash tidak valid — seharusnya 32 karakter heksadesimal.' });
  }
  apiHash = apiHash.trim();

  try {
    console.log('Initiating Telegram login...');
    // Note: no raw phone in db.logActivity — the log may be world-visible.
    db.logActivity('Auth', 'Memulai proses login Telegram.');

    const tempSession = new StringSession('');
    const tempClient = new TelegramClient(tempSession, parsedApiId, apiHash, {
      connectionRetries: 5,
      deviceModel: 'Android',
      systemVersion: '11.0',
      appVersion: '8.4.1'
    });
    await tempClient.connect();

    const { phoneCodeHash } = await tempClient.sendCode({
      apiId: parsedApiId,
      apiHash: apiHash
    }, phone);

    const authId = 'auth-' + Date.now() + '-' + Math.random().toString(36).substr(2, 5);
    activeAuths.set(authId, { client: tempClient, phone, apiId: parsedApiId, apiHash, phoneCodeHash, createdAt: Date.now() });

    db.logActivity('Auth', 'Kode OTP dikirim ke akun Telegram.');
    res.json({ success: true, authId });
  } catch (err) {
    console.error('Failed to send OTP code:', err);
    db.logActivity('Auth', 'Kode OTP gagal dikirim ke akun Telegram: ' + err.message, 'error');
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
    // The OTP code is a live credential — never print it.
    console.log('Signing in with submitted OTP code...');

    // Reconnect temp client if disconnected (common on slow OTP entry)
    if (!auth.client.connected) {
      console.log('Auth temp client disconnected, reconnecting...');
      await auth.client.connect();
      if (!auth.client.connected) {
        return res.status(400).json({ error: 'Koneksi ke Telegram terputus. Silakan kirim ulang kode OTP.' });
      }
      console.log('Auth temp client reconnected.');
    }

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
    // Fresh login means a fresh auth key — clear any prior revocation so the
    // API stops answering 409 and uploads are allowed again.
    telegramAuthState = 'ok';
    isReconnecting = false;
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

    db.logActivity('Auth', 'Akun Telegram berhasil login ke cloud drive.');
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
  try {
    const rawFiles = db.getFiles(req.query.search, req.query.category);
    const grouped = groupSplitFiles(rawFiles);
    res.json(grouped);
  }
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
    // AUTH_KEY_UNREGISTERED surfaces here, from upload.SaveFilePart, once the
    // transfer is already under way. Report it as a distinct 409 so the client
    // can tell "reconnect your Telegram account" apart from a real server fault.
    const revoked = err.sessionRevoked || markRevokedIfNeeded(err, 'upload');
    const message = revoked ? SESSION_REVOKED_MESSAGE : err.message;

    console.error('Upload failed:', err);
    db.logActivity('Upload', `Gagal mengunggah ${originalName}: ${err.message}`, 'error');
    if (fs.existsSync(filePath)) try { fs.unlinkSync(filePath); } catch {}
    try { if (fs.existsSync(tempFilePath)) fs.unlinkSync(tempFilePath); if (fs.existsSync(tempDir2)) fs.rmdirSync(tempDir2); } catch {}
    const p = uploadProgress.get(uploadId);
    if (p) { p.status = 'error'; p.error = message; if (revoked) p.sessionRevoked = true; }

    if (revoked) {
      return res.status(409).json({ error: message, sessionRevoked: true });
    }
    res.status(500).json({ error: message });
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

    // 2nd attempt: Generate thumbnail from file using Sharp (for images by category or extension)
    const IMAGE_EXTS_SET = new Set(['.jpg','.jpeg','.png','.gif','.bmp','.webp','.heic','.heif','.tiff','.tif','.avif']);
    const strippedName = file.filename.replace(/\.part\d+$/i, '');
    const realExt = path.extname(strippedName).toLowerCase();
    const isImageFile = file.category === 'image' || IMAGE_EXTS_SET.has(realExt);
    
    if (isImageFile && sharp) {
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
    const resolved = await resolveFileParts(fileKey);
    if (!resolved) return res.status(404).json({ error: 'File tidak ditemukan.' });

    const { file, parts, baseName, isSplit } = resolved;
    if (!file.telegram_media_id) {
      return res.status(400).json({ error: 'Berkas lama tidak didukung pada skema login MTProto baru. Silakan unggah kembali berkas ini.' });
    }

    const ext = path.extname(baseName) || '';
    const category = getCategory(baseName, getMimeTypeByFilename(baseName));

    let targetPath;
    if (isSplit) {
      targetPath = await ensureMergedCache(fileKey, parts, baseName);
    } else {
      targetPath = await ensureCachedOriginal(file, fileKey, baseName, 'preview');
    }

    const mimeType = getMimeTypeByFilename(baseName);

    // For images, use compressed preview if available
    if (category === 'image') {
      const compressedPath = path.join(cacheDir, `${fileKey}.webp`);
      // Check if compressed version already exists
      if (fs.existsSync(compressedPath)) {
        res.setHeader('Content-Type', 'image/webp');
        return res.sendFile(compressedPath);
      }

      // Compress the image with Sharp
      try {
        const originalBuffer = fs.readFileSync(targetPath);
        const compressedBuffer = await compressImage(originalBuffer, 1920, 80);
        if (compressedBuffer.length < originalBuffer.length) {
          // Compressed is smaller — save and serve compressed
          fs.writeFileSync(compressedPath, compressedBuffer);
          console.log(`Compressed preview: ${baseName} (${(originalBuffer.length/1024).toFixed(0)}KB → ${(compressedBuffer.length/1024).toFixed(0)}KB)`);
          res.setHeader('Content-Type', 'image/webp');
          return res.send(compressedBuffer);
        } else {
          // Compression didn't help, serve original
          res.setHeader('Content-Type', mimeType);
          return res.sendFile(targetPath);
        }
      } catch (compressErr) {
        console.log('Compression failed, serving original:', compressErr.message);
        res.setHeader('Content-Type', mimeType);
        return res.sendFile(targetPath);
      }
    }

    res.setHeader('Content-Type', mimeType);
    res.sendFile(targetPath);
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
    const resolved = await resolveFileParts(fileKey);
    if (!resolved) return res.status(404).json({ error: 'File tidak ditemukan.' });

    const { file, parts, baseName, isSplit } = resolved;
    if (!file.telegram_media_id) {
      return res.status(400).json({ error: 'Berkas lama tidak didukung pada skema login MTProto baru.' });
    }

    const ext = path.extname(baseName) || '';
    let targetPath;
    if (isSplit) {
      targetPath = await ensureMergedCache(fileKey, parts, baseName);
    } else {
      targetPath = await ensureCachedOriginal(file, fileKey, baseName, 'download-original');
    }

    res.setHeader('Content-Type', getMimeTypeByFilename(baseName));
    res.download(targetPath, baseName);
  } catch (err) {
    console.error('Download original error:', err);
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
});

// 8. Stream endpoint
app.get('/api/stream/:fileKey', checkConfig, async (req, res) => {
  const { fileKey } = req.params;
  try {
    const resolved = await resolveFileParts(fileKey);
    if (!resolved) return res.status(404).json({ error: 'File tidak ditemukan.' });

    const { file, parts, baseName, isSplit } = resolved;
    if (!file.telegram_media_id) {
      return res.status(400).json({ error: 'Berkas lama tidak didukung pada skema login MTProto baru.' });
    }

    const ext = path.extname(baseName) || '';
    let targetPath;
    if (isSplit) {
      targetPath = await ensureMergedCache(fileKey, parts, baseName);
    } else {
      targetPath = await ensureCachedOriginal(file, fileKey, baseName, 'stream');
    }

    // res.sendFile() honours the Range header via the `send` module, so seeking
    // works once the file is cached (206 + Content-Range + Accept-Ranges).
    res.setHeader('Content-Type', getMimeTypeByFilename(baseName));
    res.sendFile(targetPath);
  } catch (err) {
    console.error('Stream error:', err);
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
});

// 9. Download (attachment)
app.get('/api/download/:fileKey', checkConfig, async (req, res) => {
  const { fileKey } = req.params;
  try {
    const resolved = await resolveFileParts(fileKey);
    if (!resolved) return res.status(404).json({ error: 'File tidak ditemukan.' });

    const { file, parts, baseName, isSplit } = resolved;
    if (!file.telegram_media_id) {
      return res.status(400).json({ error: 'Berkas lama tidak didukung pada skema login MTProto baru.' });
    }

    const ext = path.extname(baseName) || '';
    let targetPath;
    if (isSplit) {
      targetPath = await ensureMergedCache(fileKey, parts, baseName);
    } else {
      targetPath = await ensureCachedOriginal(file, fileKey, baseName, 'download');
    }

    res.download(targetPath, baseName);
  } catch (err) {
    console.error('Download error:', err);
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
});

// 10. Delete
app.delete('/api/files/:fileKey', checkConfig, async (req, res) => {
  const { fileKey } = req.params;
  try {
    const resolved = await resolveFileParts(fileKey);
    if (!resolved) return res.status(404).json({ error: 'File tidak ditemukan.' });

    const { file, parts, baseName, isSplit } = resolved;

    // Delete all parts from Telegram and DB
    for (const part of parts) {
      try {
        await ensureConnection();
        await client.deleteMessages(config.chatId, [parseInt(part.telegram_media_id)], { revoke: true });
      } catch (delErr) {
        console.log(`Failed to delete part ${part.filename} in Telegram:`, delErr.message);
      }
      db.deleteFile(part.file_key);

      // Clean cache & thumb for this part
      const partExt = path.extname(part.filename) || '';
      [
        path.join(cacheDir, `${part.file_key}${partExt}`),
        path.join(thumbDir, `${part.file_key}${partExt}`),
        path.join(cacheDir, `${part.file_key}.webp`)
      ].forEach(f => {
        if (fs.existsSync(f)) try { fs.unlinkSync(f); } catch {}
      });
    }

    // Clean merged cache if exists
    const ext = path.extname(baseName) || '';
    const mergedPath = path.join(cacheDir, `${fileKey}_merged${ext}`);
    if (fs.existsSync(mergedPath)) try { fs.unlinkSync(mergedPath); } catch {}

    db.logActivity('Delete', `Berhasil menghapus berkas ${baseName} beserta seluruh pecahannya.`);
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
        try {
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


        } catch (msgErr) {
          console.error(`Error syncing message ID ${msg.id}:`, msgErr.message);
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

// ── Runtime cache eviction ──────────────────────────────────
// Startup cleanup alone is not enough: a long-running instance streaming large
// files will fill the Railway volume and start failing writes. Evict on a timer
// too — oldest-accessed first, until the cache is back under its size cap.
const CACHE_MAX_BYTES = Number(process.env.CACHE_MAX_BYTES || 2 * 1024 * 1024 * 1024); // 2 GB
const CACHE_MAX_AGE_MS = Number(process.env.CACHE_MAX_AGE_MS || 24 * 60 * 60 * 1000);  // 24 h

function pruneCacheDir() {
  try {
    const now = Date.now();
    const entries = [];
    let total = 0;

    for (const name of fs.readdirSync(cacheDir)) {
      const fp = path.join(cacheDir, name);
      // Never touch a download or merge that is still in progress.
      if (name.endsWith('.partial') || inFlightCache.has(fp)) continue;
      try {
        const stat = fs.statSync(fp);
        if (!stat.isFile()) continue;
        entries.push({ fp, size: stat.size, atime: stat.atimeMs });
        total += stat.size;
      } catch {}
    }

    let freed = 0;
    let removed = 0;
    const drop = ({ fp, size }) => {
      try { fs.unlinkSync(fp); freed += size; removed++; return true; } catch { return false; }
    };

    // Age-based first, then oldest-accessed until we are under the cap.
    const survivors = [];
    for (const e of entries) {
      if (now - e.atime > CACHE_MAX_AGE_MS) {
        if (drop(e)) { total -= e.size; continue; }
      }
      survivors.push(e);
    }

    survivors.sort((a, b) => a.atime - b.atime); // least recently used first
    for (const e of survivors) {
      if (total <= CACHE_MAX_BYTES) break;
      if (drop(e)) total -= e.size;
    }

    if (removed > 0) {
      console.log(`Cache prune: removed ${removed} file(s), freed ${(freed / 1024 / 1024).toFixed(1)} MB`);
    }
  } catch (err) {
    console.error('Cache prune error:', err.message);
  }
}

setInterval(pruneCacheDir, 15 * 60 * 1000).unref();

app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT} (Data dir: ${dataDir})`));
