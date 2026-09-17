// Load .env before anything else: ./data-dir reads DATA_DIR and ./auth reads
// DRIVE_PASSWORD / DRIVE_SECRET at require time, so a later call would be too
// late to matter. dotenv was already a declared dependency but never loaded,
// which is why a .env file used to be silently ignored.
require('dotenv').config();

const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { pipeline } = require('stream/promises');
const { TelegramClient, Api } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { computeCheck } = require('telegram/Password');
// Must be required before ./database — that module opens SQLite at require
// time, so the legacy-file migration has to have already finished.
const { dataDir } = require('./data-dir');
const db = require('./database');
const auth = require('./auth');
// Normalisation of the two media shapes a channel history returns. Kept in its
// own module so it can be unit-tested without standing up a server or a
// Telegram client — see the header there for why photos used to be skipped.
const { describeSyncMedia, floodWaitSeconds } = require('./sync-media');
// Throwaway mailbox (mail.tm). Own module for the same reason as sync-media:
// the shaping is pure and unit-testable without standing up a server.
const tempmail = require('./tempmail');

// Try to load Sharp for image compression
let sharp = null;
try {
  sharp = require('sharp');
  console.log('Sharp image processor loaded successfully.');
} catch (err) {
  console.log('Sharp not available — image previews will serve original files. Install sharp for compression.');
}

// null = belum diperiksa. Diisi sekali saat thumbnail video pertama diminta.
let ffmpegAvailable = null;

const app = express();
const PORT = process.env.PORT || 3000;

// dataDir is resolved once in ./data-dir (imported above) and defaults to
// ./data, matching the setup docs and the wizard. Set DATA_DIR to point it at a
// mounted volume instead.

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

// What the setup wizard puts in the API Hash box. The hash is a credential —
// whoever holds it plus the api id can impersonate this app — so the real
// value never leaves the server. The last four characters are kept visible so
// the operator can tell which of their apps is configured; that alone is not
// enough to use. An empty stored hash masks to an empty string, which is what
// makes the wizard fall back to asking for one.
function maskApiHash(hash) {
  const h = String(hash || '');
  if (!h) return '';
  if (h.length <= 4) return '•'.repeat(h.length);
  return '•'.repeat(h.length - 4) + h.slice(-4);
}

// ============================================================
// HELPERS
// ============================================================
function getCategory(filename, mimeType) {
  const ext = path.extname(filename).toLowerCase().replace('.', '');
  const mime = String(mimeType || '');
  // MIME didahulukan: berkas tanpa ekstensi tetap punya mimeType dari Telegram,
  // dan tanpa ini fotonya berakhir di Dokumen lalu tidak pernah dibuatkan
  // pratinjau.
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  const imageExts = ['jpg','jpeg','png','gif','bmp','webp','svg','tiff','tif','ico','heic','heif','avif'];
  const videoExts = ['mp4','mkv','avi','mov','webm','wmv','flv','3gp','m4v','ts','mpg','mpeg','m2ts'];
  const audioExts = ['mp3','wav','ogg','m4a','flac','aac','wma','opus'];
  if (imageExts.includes(ext)) return 'image';
  if (videoExts.includes(ext)) return 'video';
  if (audioExts.includes(ext)) return 'audio';
  return 'document';
}

// Ekstensi setelah sufiks .partN dibuang, dalam huruf kecil dan berkode titik.
function realExtOf(filename) {
  return path.extname(String(filename || '').replace(/\.part\d+$/i, '')).toLowerCase();
}

// Picks which of Telegram's own pre-rendered variants to serve as the grid
// thumbnail. Named "smallest" because that is what it used to return outright —
// but type 's' is 100px on its long edge and the cards render at roughly twice
// that, so every tile came back visibly soft. The rule now is the smallest
// variant that still covers THUMB_TARGET_PX, falling back to the largest one
// available when none does. Either way nothing but the variant itself is
// downloaded; the original is never touched.
const THUMB_TARGET_PX = 320;

function pickThumbVariant(variants) {
  const usable = variants.filter(v => v && !Array.isArray(v.bytes));
  if (usable.length === 0) return null;

  const longEdge = v => Math.max(v.w || 0, v.h || 0);
  const weight = v => longEdge(v) || Number(v.size) || 0;
  const sorted = [...usable].sort((a, b) => weight(a) - weight(b));

  // A variant with no dimensions at all (a bare PhotoCachedSize) sorts by byte
  // count, which is not comparable to pixels — so it only ever wins as the
  // last resort below, never as a "covers the target" match.
  return sorted.find(v => longEdge(v) >= THUMB_TARGET_PX) || sorted[sorted.length - 1];
}

function getSmallestThumb(media) {
  if (!media) return null;

  // A photo (MessageMediaPhoto) carries its variants directly in `sizes`
  // instead of a `thumbs` list on a document. Without this branch the thumbnail
  // route fell straight through to the Sharp path for every synced photo —
  // downloading the full-resolution image just to shrink it — even though
  // Telegram already hosts a small variant.
  if (!media.document && media.photo) {
    return pickThumbVariant((media.photo.sizes || []).filter(s => s.type));
  }

  const doc = media.document;
  if (!doc) return null;
  const thumbs = doc.thumbs || [];
  if (thumbs.length === 0) return doc.thumbnail || doc.thumb || null;
  return pickThumbVariant(thumbs);
}

/* The preview pane decides what to render from this, so the map has to cover
   more than the nine types it started with — a .m4a came back as
   application/octet-stream and no <audio> element would touch it.

   Two deliberate mislabels, both to keep same-origin script execution out of
   the drive: .html/.htm and .xhtml are declared text/plain so a stored page is
   shown as source instead of being executed against this origin, and .svg is
   only ever consumed inside an <img> (where scripts do not run) by the preview
   code. Everything textual carries charset=utf-8 so accented filenames and
   content do not arrive mojibaked. */
const MIME_BY_EXT = {
  // images
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
  '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif',
  '.bmp': 'image/bmp', '.ico': 'image/x-icon', '.svg': 'image/svg+xml',
  '.tif': 'image/tiff', '.tiff': 'image/tiff',
  '.heic': 'image/heic', '.heif': 'image/heif',
  // video
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.webm': 'video/webm',
  '.mkv': 'video/x-matroska', '.avi': 'video/x-msvideo',
  '.mov': 'video/quicktime', '.wmv': 'video/x-ms-wmv',
  '.flv': 'video/x-flv', '.mpg': 'video/mpeg', '.mpeg': 'video/mpeg',
  '.3gp': 'video/3gpp',
  // audio
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg', '.opus': 'audio/opus', '.m4a': 'audio/mp4',
  '.aac': 'audio/aac', '.flac': 'audio/flac', '.wma': 'audio/x-ms-wma',
  '.mid': 'audio/midi', '.midi': 'audio/midi',
  // documents
  '.pdf': 'application/pdf',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.odt': 'application/vnd.oasis.opendocument.text',
  '.ods': 'application/vnd.oasis.opendocument.spreadsheet',
  '.epub': 'application/epub+zip', '.rtf': 'application/rtf',
  // text and source, all inline-safe
  '.txt': 'text/plain; charset=utf-8', '.log': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8', '.markdown': 'text/plain; charset=utf-8',
  '.csv': 'text/plain; charset=utf-8', '.tsv': 'text/plain; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.xml': 'text/plain; charset=utf-8', '.yml': 'text/plain; charset=utf-8',
  '.yaml': 'text/plain; charset=utf-8', '.toml': 'text/plain; charset=utf-8',
  '.ini': 'text/plain; charset=utf-8', '.cfg': 'text/plain; charset=utf-8',
  '.conf': 'text/plain; charset=utf-8', '.env': 'text/plain; charset=utf-8',
  '.srt': 'text/plain; charset=utf-8', '.vtt': 'text/plain; charset=utf-8',
  '.html': 'text/plain; charset=utf-8', '.htm': 'text/plain; charset=utf-8',
  '.xhtml': 'text/plain; charset=utf-8',
  '.css': 'text/plain; charset=utf-8', '.js': 'text/plain; charset=utf-8',
  '.mjs': 'text/plain; charset=utf-8', '.cjs': 'text/plain; charset=utf-8',
  '.jsx': 'text/plain; charset=utf-8', '.tsx': 'text/plain; charset=utf-8',
  '.py': 'text/plain; charset=utf-8', '.rb': 'text/plain; charset=utf-8',
  '.php': 'text/plain; charset=utf-8', '.java': 'text/plain; charset=utf-8',
  '.c': 'text/plain; charset=utf-8', '.h': 'text/plain; charset=utf-8',
  '.cpp': 'text/plain; charset=utf-8', '.hpp': 'text/plain; charset=utf-8',
  '.cs': 'text/plain; charset=utf-8', '.go': 'text/plain; charset=utf-8',
  '.rs': 'text/plain; charset=utf-8', '.kt': 'text/plain; charset=utf-8',
  '.ts': 'text/plain; charset=utf-8',
  '.swift': 'text/plain; charset=utf-8', '.sh': 'text/plain; charset=utf-8',
  '.bat': 'text/plain; charset=utf-8', '.ps1': 'text/plain; charset=utf-8',
  '.sql': 'text/plain; charset=utf-8', '.dockerfile': 'text/plain; charset=utf-8',
  // archives
  '.zip': 'application/zip', '.rar': 'application/vnd.rar',
  '.7z': 'application/x-7z-compressed', '.tar': 'application/x-tar',
  '.gz': 'application/gzip', '.bz2': 'application/x-bzip2',
  '.xz': 'application/x-xz', '.iso': 'application/x-iso9660-image',
  '.apk': 'application/vnd.android.package-archive',
  '.exe': 'application/octet-stream', '.msi': 'application/octet-stream',
};

function getMimeTypeByFilename(filename) {
  // A split part (.part001) keeps the real extension one segment back.
  const cleaned = String(filename || '').replace(/\.part\d+$/i, '');
  const ext = path.extname(cleaned).toLowerCase();
  return MIME_BY_EXT[ext] || 'application/octet-stream';
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
    // `thumb`, not `thumbSize` — GramJS ignores an unknown key, so the option
    // name being wrong meant this downloaded the ENTIRE original every time and
    // then threw it away for exceeding the size guard below. That is what made
    // the grid slow and what made every PDF thumbnail 404: the fallback path
    // downloaded the original a second time for images, and gave up for
    // anything else. See node_modules/telegram/client/downloads.d.ts:136.
    const buf = await client.downloadMedia(message.media, { thumb: thumbObj });
    if (buf && buf.length > 0 && buf.length < 500 * 1024) {
      return buf;
    }
  } catch (err) {
    console.error('Failed to download smallest thumbnail object:', err.message);
  }
  return null;
}

function generateFileKey() { return Math.random().toString(36).substring(2,15) + Math.random().toString(36).substring(2,15); }

// Formats Sharp reads on its own. HEIC/HEIF are NOT here: they need libheif,
// which is present in the image but only reachable when the extension is spelled
// out to Sharp — hence the heif block below.
const SHARP_NATIVE_FORMATS = new Set(['jpeg', 'png', 'webp', 'avif', 'tiff', 'gif', 'svg', 'bmp']);
const HEIF_EXTS = new Set(['.heic', '.heif', '.hif', '.avif']);

function isHeifName(name) {
  return HEIF_EXTS.has(realExtOf(name));
}

// Image compression function using Sharp.
//
// Every output is WebP, because the point of this path is a *preview* the
// browser can paint. That matters most for HEIC/HEIF (iPhone photos): Chrome,
// Firefox and Edge cannot decode them at all, so serving the original — which is
// what happened whenever Sharp failed — produced an empty viewer.
//
// Two routes in, because Sharp alone is not enough here: npm's sharp is built
// without the HEVC plugin that HEIC needs, so a HEIC goes through heif-convert
// first and arrives as PNG. `hintName` is the original filename, used only to
// decide whether that first step is needed.
async function compressImage(inputBuffer, maxDimension = 1920, quality = 80, hintName = '') {
  if (!sharp) return inputBuffer; // Sharp not available, return original
  try {
    const metadata = await sharp(inputBuffer).metadata();
    // SVG and GIF: the first is already tiny and the second is usually animated.
    // Re-encoding either through the pixel pipeline loses more than it saves.
    if (!metadata.format || ['svg', 'gif'].includes(metadata.format)) {
      return inputBuffer;
    }

    let source = inputBuffer;
    if (isHeifName(hintName) || !SHARP_NATIVE_FORMATS.has(metadata.format)) {
      const png = await decodeHeifToPng(inputBuffer, realExtOf(hintName) || '.heic');
      if (png) source = png;
    }

    return await sharp(source)
      .rotate() // honour EXIF orientation before the pixels are thrown away
      .resize(maxDimension, maxDimension, {
        fit: 'inside',
        withoutEnlargement: true
      })
      .webp({ quality, effort: 4 })
      .toBuffer();
  } catch (err) {
    console.error('Image compression error:', err.message);
    return inputBuffer; // Fallback: return original
  }
}

/* ffmpeg is the only way to make a picture out of a video the browser will not
   play. A .mov from an iPhone is HEVC, and HEVC-in-MOV is exactly the case where
   <video> shows a black box on Chrome and Firefox. Pulling one frame at ~1s to
   WebP gives the grid and the viewer something visible with no client-side
   decoder, and the file is fetched once then cached next to the other thumbs.

   Input and output are files on disk, not pipes. `-i pipe:0` looked tidier but
   failed with a raw OS error (code 3199971767) as soon as the sink could not
   seek, which mp4 demuxing needs. Writing the already-downloaded buffer to a
   temp file costs one copy and always works. */
const FFMPEG_BIN = process.env.FFMPEG_BIN || 'ffmpeg';

function ffmpegThumb(buffer, seconds = 1, hintExt = '.mp4') {
  return new Promise((resolve, reject) => {
    const stamp = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const safeExt = /^\.[a-z0-9]{1,5}$/i.test(hintExt) ? hintExt.toLowerCase() : '.mp4';
    const inPath = path.join(require('os').tmpdir(), `thumb_src_${stamp}${safeExt}`);
    const outPath = path.join(require('os').tmpdir(), `thumb_out_${stamp}.webp`);
    try {
      fs.writeFileSync(inPath, buffer);
    } catch (e) {
      return reject(e);
    }

    const args = [
      '-hide_banner', '-loglevel', 'error',
      '-ss', String(seconds),
      '-i', inPath,
      '-frames:v', '1',
      '-vf', 'scale=400:-2:force_original_aspect_ratio=decrease',
      '-f', 'webp', '-quality', '70',
      '-y', outPath,
    ];    const proc = spawn(FFMPEG_BIN, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const errs = [];
    let settled = false;
    const bersihkan = () => {
      try { fs.unlinkSync(inPath); } catch {}
      try { fs.unlinkSync(outPath); } catch {}
    };
    proc.stderr.on('data', (c) => errs.push(c));
    proc.on('error', (e) => {
      if (settled) return;
      settled = true;
      bersihkan();
      reject(e);
    });
    proc.on('close', (code) => {
      if (settled) return;
      settled = true;
      let out = null;
      try {
        if (code === 0 && fs.existsSync(outPath)) out = fs.readFileSync(outPath);
      } catch (e) {
        out = null;
      }
      try { fs.unlinkSync(inPath); } catch {}
      try { fs.unlinkSync(outPath); } catch {}
      if (out && out.length) return resolve(out);
      reject(new Error(`ffmpeg keluar dengan kode ${code}: ${Buffer.concat(errs).toString().slice(0, 200)}`));
    });
  });
}

// Batas ukuran untuk mengambil frame video sendiri. Telepon mengunggah video
// puluhan MB, dan mengunduh semuanya demi satu gambar membuat satu kartu
// menghabiskan kuota dan waktu yang tidak sepadan. Di atas batas ini, thumbnail
// Telegram dipakai kalau ada; kalau tidak, kartunya tetap berikon.
const FFMPEG_MAX_BYTES = Number(process.env.FFMPEG_MAX_BYTES) || 60 * 1024 * 1024;

// Cetak halaman pertama PDF jadi PNG. pdftoppm dari poppler dipakai lebih dulu
// karena itulah alatnya; ffmpeg cadangan tidak berguna di sini — build Debian
// tidak membawa demuxer PDF, jadi setiap percobaan berakhir "keluar dengan kode".
const PDFTOPPM_BIN = process.env.PDFTOPPM_BIN || 'pdftoppm';

function pdfFirstPage(buffer) {
  return new Promise((resolve, reject) => {
    const stamp = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const inPath = path.join(require('os').tmpdir(), `pdf_src_${stamp}.pdf`);
    const outBase = path.join(require('os').tmpdir(), `pdf_out_${stamp}`);
    try {
      fs.writeFileSync(inPath, buffer);
    } catch (e) {
      return reject(e);
    }
    // -f/-l halaman pertama, -png format keluaran, -r 90 cukup untuk kartu.
    const args = ['-f', '1', '-l', '1', '-r', '90', '-png', inPath, outBase];
    const proc = spawn(PDFTOPPM_BIN, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const errs = [];
    let settled = false;
    const buang = () => {
      try { fs.unlinkSync(inPath); } catch {}
      try {
        for (const f of fs.readdirSync(require('os').tmpdir())) {
          if (f.startsWith(`pdf_out_${stamp}`)) {
            try { fs.unlinkSync(path.join(require('os').tmpdir(), f)); } catch {}
          }
        }
      } catch {}
    };
    proc.stderr.on('data', (c) => errs.push(c));
    proc.on('error', (e) => {
      if (settled) return;
      settled = true;
      buang();
      reject(e);
    });
    proc.on('close', (code) => {
      if (settled) return;
      settled = true;
      let out = null;
      try {
        const files = fs.readdirSync(require('os').tmpdir())
          .filter((f) => f.startsWith(`pdf_out_${stamp}`) && f.endsWith('.png'))
          .sort();
        if (files.length) out = fs.readFileSync(path.join(require('os').tmpdir(), files[0]));
      } catch (e) {
        out = null;
      }
      buang();
      if (out && out.length) return resolve(out);
      reject(new Error(`pdftoppm keluar dengan kode ${code}: ${Buffer.concat(errs).toString().slice(0, 200)}`));
    });
  });
}

// Cetak halaman pertama PDF jadi gambar, lewat ffmpeg (poppler tidak dipasang
// di image ini, sedangkan ffmpeg membaca PDF sebagai video satu-frame).
function ffmpegPdfThumb(buffer) {
  return new Promise((resolve, reject) => {
    const stamp = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const inPath = path.join(require('os').tmpdir(), `pdf_src_${stamp}.pdf`);
    const outPath = path.join(require('os').tmpdir(), `pdf_out_${stamp}.png`);
    try {
      fs.writeFileSync(inPath, buffer);
    } catch (e) {
      return reject(e);
    }
    // -frames:v 1 membatasi ke halaman pertama. Skala besar supaya teks judul
    // masih terbaca di kartu.
    const args = [
      '-hide_banner', '-loglevel', 'error',
      '-i', inPath,
      '-frames:v', '1',
      '-vf', 'scale=600:-2:force_original_aspect_ratio=decrease',
      '-f', 'image2', '-y', outPath,
    ];
    const proc = spawn(FFMPEG_BIN, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const errs = [];
    let settled = false;
    proc.stderr.on('data', (c) => errs.push(c));
    proc.on('error', (e) => {
      if (settled) return;
      settled = true;
      try { fs.unlinkSync(inPath); } catch {}
      reject(e);
    });
    proc.on('close', (code) => {
      if (settled) return;
      settled = true;
      let out = null;
      try {
        if (code === 0 && fs.existsSync(outPath)) out = fs.readFileSync(outPath);
      } catch (e) {
        out = null;
      }
      try { fs.unlinkSync(inPath); } catch {}
      try { fs.unlinkSync(outPath); } catch {}
      if (out && out.length) return resolve(out);
      reject(new Error(`ffmpeg pdf keluar dengan kode ${code}: ${Buffer.concat(errs).toString().slice(0, 200)}`));
    });
  });
}

async function hasFfmpeg() {
  if (ffmpegAvailable !== null) return ffmpegAvailable;
  ffmpegAvailable = await new Promise((resolve) => {
    const p = spawn(FFMPEG_BIN, ['-version'], { stdio: 'ignore' });
    p.on('error', () => resolve(false));
    p.on('close', (code) => resolve(code === 0));
  });
  if (!ffmpegAvailable) {
    console.log('ffmpeg tidak tersedia — thumbnail video akan memakai thumbnail Telegram saja.');
  }
  return ffmpegAvailable;
}

/* Sharp membaca HEIC hanya kalau libvips-nya dibangun dengan plugin HEVC, dan
   build npm standar tidak. Di image ini `heif-convert` dari libheif-examples
   selalu ada, jadi HEIC/HEIF dikonversi lewat biner itu dulu, baru hasil PNG-nya
   diserahkan ke Sharp. Tanpa jalur ini foto iPhone hanya muncul sebagai ikon
   karena Sharp gagal sebelum sempat membaca pikselnya. */
const HEIF_CONVERT_BIN = process.env.HEIF_CONVERT_BIN || 'heif-convert';

function heifConvert(buffer, hintExt) {
  return new Promise((resolve, reject) => {
    const stamp = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const safeExt = /^\.[a-z0-9]{1,5}$/i.test(hintExt) ? hintExt.toLowerCase() : '.heic';
    const inPath = path.join(require('os').tmpdir(), `heif_src_${stamp}${safeExt}`);
    const outPath = path.join(require('os').tmpdir(), `heif_out_${stamp}.png`);
    try {
      fs.writeFileSync(inPath, buffer);
    } catch (e) {
      return reject(e);
    }
    const proc = spawn(HEIF_CONVERT_BIN, [inPath, outPath], { stdio: ['ignore', 'pipe', 'pipe'] });
    const errs = [];
    let settled = false;
    proc.stderr.on('data', (c) => errs.push(c));
    proc.on('error', (e) => {
      if (settled) return;
      settled = true;
      try { fs.unlinkSync(inPath); } catch {}
      reject(e);
    });
    proc.on('close', (code) => {
      if (settled) return;
      settled = true;
      let out = null;
      try {
        if (fs.existsSync(outPath)) out = fs.readFileSync(outPath);
      } catch (e) {
        out = null;
      }
      try { fs.unlinkSync(inPath); } catch {}
      try { fs.unlinkSync(outPath); } catch {}
      if (out && out.length) return resolve(out);
      reject(new Error(`heif-convert keluar dengan kode ${code}: ${Buffer.concat(errs).toString().slice(0, 200)}`));
    });
  });
}

// Ubah HEIC/HEIF apa pun menjadi PNG lewat heif-convert, kalau binernya ada.
async function decodeHeifToPng(buffer, hintExt) {
  try {
    return await heifConvert(buffer, hintExt);
  } catch (e) {
    console.log('heif-convert gagal:', e.message);
    return null;
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
    // Bullets plus the last four characters — enough for the wizard to show the
    // field as already filled, never enough to reuse the credential.
    apiHashMasked: maskApiHash(config.apiHash),
    apiHashSet: !!config.apiHash,
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

  // Fall back to the server-side credentials (config.json / env), never to
  // shared public ones. The old default (apiId 6 + the official Android hash)
  // is flagged by Telegram's anti-abuse system and risks limiting the account.
  // This is what makes the two fields optional in the login form: if the
  // operator already provisioned credentials, the client sends nothing.
  // The wizard pre-fills the API Hash box with bullets (see maskApiHash). Those
  // bullets are not a hash, so treat anything non-hexadecimal as "not supplied"
  // and fall through to the stored value — otherwise submitting the untouched
  // form would fail validation on a login that needed no credentials at all.
  if (typeof apiHash === 'string' && /[^a-f0-9]/i.test(apiHash.trim())) apiHash = '';

  if (!apiId) apiId = config.apiId || process.env.API_ID || '';
  if (!apiHash) apiHash = config.apiHash || process.env.API_HASH || '';

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

// 3c. Logout — ends the Telegram session, keeps the app registration.
//
// This used to blank all four fields and delete config.json outright, which is
// why the API ID and Hash had to be retyped from my.telegram.org after every
// logout. They identify the *application*, not the session: the OTP login that
// follows needs them, so throwing them away made the next login harder for no
// gain. Only an explicit reset (below) clears them now.
app.post('/api/logout', async (req, res) => {
  db.logActivity('Auth', 'Pengguna keluar dari sesi cloud drive.');
  if (keepAliveInterval) clearInterval(keepAliveInterval);
  if (sessionSaveInterval) clearInterval(sessionSaveInterval);
  if (client) {
    try { await client.disconnect(); } catch {}
    client = null;
  }
  config = {
    apiId: config.apiId,
    apiHash: config.apiHash,
    sessionString: '',
    chatId: config.chatId
  };
  telegramAuthState = 'none';
  saveConfigToFile();
  res.json({ success: true });
});

// 3d. Reset the API credentials — the one action that changes them.
//
// Separate from Reset Drive (which clears files) and from logout (which clears
// only the session) so that "my credentials are wrong" and "I want to start
// over" are not the same button. The session cannot outlive the credentials it
// was issued under, so it goes too; the storage chat id is not a credential and
// stays. If API_ID/API_HASH are set as environment variables they win again on
// the next restart — that is the deployment case, and it is deliberate.
app.post('/api/settings/reset-credentials', async (req, res) => {
  try {
    if (keepAliveInterval) clearInterval(keepAliveInterval);
    if (sessionSaveInterval) clearInterval(sessionSaveInterval);
    if (client) {
      try { await client.disconnect(); } catch {}
      client = null;
    }
    config = { apiId: '', apiHash: '', sessionString: '', chatId: config.chatId || '' };
    telegramAuthState = 'none';
    saveConfigToFile();
    db.logActivity('Config', 'Kredensial API Telegram direset. Perlu diisi ulang saat login berikutnya.');
    res.json({ success: true });
  } catch (err) {
    console.error('Credential reset failed:', err);
    res.status(500).json({ error: 'Gagal mereset kredensial: ' + err.message });
  }
});

// 3e. Temp mail — a throwaway mailbox for the operator of this drive.
//
// All five routes sit behind the password gate (registered after line 68), so a
// stranger cannot spend this instance's mailbox or read what arrives in it.
// None of them take `checkConfig`: the mailbox has nothing to do with the
// Telegram session, and making it depend on one would break the feature exactly
// when someone is still in the middle of setting up.
//
// Scope stops at an inbox. Nothing here submits a form on a third-party site or
// registers accounts in bulk — see the header of ./tempmail for why.
app.get('/api/tempmail/address', async (req, res) => {
  try {
    res.json({ address: (await tempmail.current())?.address || null });
  } catch (err) {
    console.error('Temp mail address failed:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/tempmail/address', async (req, res) => {
  try {
    const out = await tempmail.create();
    db.logActivity('TempMail', 'Alamat temp mail baru dibuat: ' + out.address);
    res.json(out);
  } catch (err) {
    console.error('Temp mail create failed:', err);
    res.status(502).json({ error: err.message });
  }
});

app.get('/api/tempmail/inbox', async (req, res) => {
  try {
    res.json({ messages: await tempmail.inbox() });
  } catch (err) {
    console.error('Temp mail inbox failed:', err);
    res.status(502).json({ error: err.message });
  }
});

app.get('/api/tempmail/message/:id', async (req, res) => {
  try {
    res.json(await tempmail.message(req.params.id));
  } catch (err) {
    const status = err.status || 502;
    if (status >= 500) console.error('Temp mail message failed:', err);
    res.status(status).json({ error: err.message });
  }
});

app.delete('/api/tempmail/address', async (req, res) => {
  try {
    const out = await tempmail.destroy();
    db.logActivity('TempMail', out.remoteDeleted
      ? 'Alamat temp mail dihapus.'
      : 'Alamat temp mail dibuang lokal; penghapusan di mail.tm gagal.');
    res.json(out);
  } catch (err) {
    console.error('Temp mail delete failed:', err);
    res.status(502).json({ error: err.message });
  }
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
        // Always .jpg: a native Telegram thumbnail is JPEG no matter what the
        // file it belongs to is, and naming it after the original extension is
        // what made /api/thumb serve a PDF's thumbnail as application/pdf.
        fs.writeFileSync(path.join(thumbDir, `${fileKey}.jpg`), thumbBuffer);
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

/* ══════════════════════════════════════════════════════════════════════════
   6. THUMBNAILS
   --------------------------------------------------------------------------
   The grid asks for one of these per visible card, so this route is what makes
   the drive feel fast or slow. Four rules keep it cheap:

   1. A cached thumbnail is served with a long immutable Cache-Control. A
      file_key never points at different bytes, so the browser may keep it
      indefinitely. The old route sent no cache headers at all, so every
      re-render — switching to list view and back, changing a filter — re-fetched
      every tile from the server.

   2. Telegram's own thumbnail is the only source consulted by default. It is a
      few KB and rides along with the message we already look up by id.

   3. Downloading the *original* just to shrink it is the expensive path: for a
      300 MB image that is 300 MB pulled over MTProto to produce one 400px
      square. It now runs only for files at or under THUMB_AUTO_BYTES, or when
      the caller asks for it explicitly with ?generate=1 (the preview pane does,
      the grid never does). Everything else answers 404 and the client draws its
      file-type icon instead.

   4. Concurrency is capped. A 50-card grid used to fire 50 simultaneous
      getMessages/downloadMedia calls — which is precisely how scrolling earned
      a FLOOD_WAIT. THUMB_CONCURRENCY run at a time and the rest wait for a slot.
   ══════════════════════════════════════════════════════════════════════════ */

/* Batas ukuran asli yang masih mau diolah untuk mencari thumbnail. Awalnya
   8 MB, dan itu membuat foto kamera (11-13 MB) tidak pernah punya pratinjau —
   kartunya berikon generik padahal berkasnya sehat. 32 MB menampung foto ponsel
   dan kamera pada umumnya tanpa membuka pintu untuk mengunduh berkas raksasa
   hanya demi satu gambar. */
const THUMB_AUTO_BYTES = 32 * 1024 * 1024;
const THUMB_CONCURRENCY = 4;                // parallel Telegram thumb fetches
const THUMB_MISS_TTL_MS = 10 * 60 * 1000;   // how long "no thumbnail" is trusted
const BROWSER_IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.avif', '.bmp']);

// fileKey -> when we last failed to produce a thumbnail. Without this, a file
// that genuinely has none is re-requested from Telegram on every single render.
const thumbMisses = new Map();

function thumbMissedRecently(fileKey) {
  const at = thumbMisses.get(fileKey);
  if (!at) return false;
  if (Date.now() - at > THUMB_MISS_TTL_MS) { thumbMisses.delete(fileKey); return false; }
  return true;
}

let thumbActive = 0;
const thumbWaiting = [];

// Minimal semaphore. Every acquire must be paired with a release in a finally,
// or the queue stalls permanently.
function acquireThumbSlot() {
  if (thumbActive < THUMB_CONCURRENCY) {
    thumbActive++;
    return Promise.resolve();
  }
  return new Promise(resolve => thumbWaiting.push(resolve));
}

function releaseThumbSlot() {
  const next = thumbWaiting.shift();
  if (next) next();        // hand the slot straight over; the count is unchanged
  else thumbActive--;
}

// A native Telegram thumbnail is always JPEG regardless of what the file it
// belongs to is, so serving it under the original extension mislabelled it:
// the thumbnail of a PDF went out as application/pdf and no <img> would render
// it. Anything that is not a browser-renderable image extension is declared
// image/jpeg.
function thumbContentType(filePath) {
  const e = path.extname(filePath).toLowerCase();
  if (e === '.webp') return 'image/webp';
  if (BROWSER_IMAGE_EXTS.has(e)) return getMimeTypeByFilename(filePath);
  return 'image/jpeg';
}

function sendCachedThumb(res, filePath) {
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  res.setHeader('Content-Type', thumbContentType(filePath));
  return res.sendFile(filePath);
}

// A short positive cache on the miss stops the icon fallback from re-asking on
// every scroll, while still letting a later Sync or ?generate=1 fix things.
function sendNoThumb(res) {
  res.setHeader('Cache-Control', 'public, max-age=300');
  return res.status(404).end();
}

// Kenali jenis berkas dari beberapa byte pertama. Dipakai hanya ketika nama
// berkas dan mimeType sama-sama tidak memberi petunjuk, mis. berkas kiriman
// Telegram yang tersimpan sebagai application/octet-stream tanpa ekstensi.
function sniffImageKind(buf) {
  if (!buf || buf.length < 12) return null;
  const b = buf;
  if (b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF) return { exts: ['.jpg'], mime: 'image/jpeg' };
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47) return { exts: ['.png'], mime: 'image/png' };
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return { exts: ['.gif'], mime: 'image/gif' };
  const head4 = b.slice(0, 4).toString('latin1');
  if (head4 === 'RIFF' && b.slice(8, 12).toString('latin1') === 'WEBP') return { exts: ['.webp'], mime: 'image/webp' };
  if (b.slice(0, 5).toString('latin1') === '%PDF-') return { exts: ['.pdf'], mime: 'application/pdf' };
  // HEIF/HEIC: kotak 'ftyp' dengan brand heic/heif/mif1 di offset 4.
  if (b.slice(4, 8).toString('latin1') === 'ftyp') {
    const brand = b.slice(8, 12).toString('latin1').toLowerCase();
    if (brand.startsWith('heic') || brand.startsWith('heif') || brand === 'mif1' || brand === 'msf1') {
      return { exts: ['.heic', '.heif'], mime: 'image/heic' };
    }
    if (brand.indexOf('qt') === 0) return { exts: ['.mov'], mime: 'video/quicktime' };
    return { exts: ['.mp4'], mime: 'video/mp4' };
  }
  return null;
}

// Ukuran berkas yang dilaporkan Telegram sendiri untuk sebuah pesan media.
app.get('/api/thumb/:fileKey', checkConfig, async (req, res) => {
  const { fileKey } = req.params;
  const generate = req.query.generate === '1';
  try {
    const file = db.getFile(fileKey);
    if (!file) return res.status(404).end();

    const ext = path.extname(file.filename) || '';
    const candidates = [
      path.join(thumbDir, `${fileKey}.webp`),   // written by the Sharp path
      path.join(thumbDir, `${fileKey}.jpg`),    // written by the native path
      path.join(thumbDir, `${fileKey}${ext}`),  // legacy: original extension
    ];
    for (const p of candidates) {
      if (fs.existsSync(p)) return sendCachedThumb(res, p);
    }

    if (!file.telegram_media_id) return sendNoThumb(res);
    if (!generate && thumbMissedRecently(fileKey)) return sendNoThumb(res);

    const IMAGE_EXTS_SET = new Set(['.jpg','.jpeg','.png','.gif','.bmp','.webp','.heic','.heif','.tiff','.tif','.avif']);
    const VIDEO_EXTS_SET = new Set(['.mp4','.mov','.m4v','.webm','.mkv','.avi','.3gp','.wmv','.flv','.mpg','.mpeg','.ts']);
    const strippedName = file.filename.replace(/\.part\d+$/i, '');
    const realExt = path.extname(strippedName).toLowerCase();
    /* Sebagian berkas tersimpan tanpa ekstensi sama sekali (nama aslinya
       memang begitu di Telegram). Kategori dari MIME yang tersimpan di baris
       itu dipakai sebagai gantinya, supaya fotonya tetap bisa dibuatkan
       pratinjau alih-alih berhenti sebagai dokumen tak dikenal. */
    const mimeAwal = String(file.mime_type || '');
    const isImageFile = file.category === 'image' || IMAGE_EXTS_SET.has(realExt);
    const isVideoFile = file.category === 'video' || VIDEO_EXTS_SET.has(realExt);
    const isPdfFile = realExt === '.pdf' || mimeAwal === 'application/pdf';
    const totalSize = Number(file.total_size) || 0;
    // Video selalu boleh dicoba: thumbnail asli Telegram untuk .mov sering kosong,
    // dan tanpa frame hasil ffmpeg kartunya hanya menampilkan ikon. PDF dibatasi
    // ukurannya karena ffmpeg harus membaca seluruh berkas untuk halaman pertama.
    const maySharp = !!sharp && (isImageFile || isVideoFile || isPdfFile) &&
      (generate || isVideoFile || isPdfFile || isImageFile || (totalSize > 0 && totalSize <= THUMB_AUTO_BYTES));

    const nativePath = path.join(thumbDir, `${fileKey}.jpg`);
    const webpPath = path.join(thumbDir, `${fileKey}.webp`);

    // Two requests for the same key arriving together — grid and list both
    // mounted, or a fast re-render — share one piece of work.
    const built = await dedupeCacheWork(`thumb:${fileKey}:${maySharp ? 'full' : 'native'}`, async () => {
      await acquireThumbSlot();
      try {
        await ensureConnection();
        const messages = await client.getMessages(config.chatId, { ids: [parseInt(file.telegram_media_id)] });
        const msg = messages && messages[0];
        if (!msg || !msg.media) return null;

        const thumbBuffer = await downloadTelegramThumb(msg);
        if (thumbBuffer) {
          fs.writeFileSync(nativePath, thumbBuffer);
          db.updateFileThumb(fileKey, 'local_cached');
          return nativePath;
        }

        if (!maySharp) return null;

        /* Ekstensi tmp harus diambil dari nama setelah sufiks .partN dibuang dan
           dalam huruf kecil. Memakai `ext` apa adanya pernah menghasilkan
           "thumb_tmp_sync_11.part1", dan Sharp menolak berkas dengan akhiran itu
           sebelum sempat membaca isinya. */
        const thumbExt = realExtOf(file.filename) || ext || '.bin';
        const tmpPath = path.join(require('os').tmpdir(), `thumb_tmp_${fileKey}${thumbExt}`);
        try {
          console.log(`Thumbnail from original (${(totalSize / 1024 / 1024).toFixed(1)} MB): ${file.filename}`);

          /* Berkas besar dipecah jadi .part1, .part2, ... dan satu bagian bukan
             berkas yang sah: .mov bagian pertama tidak punya moov atom, jadi
             ffmpeg menolak dengan "moov atom not found" sementara ukurannya
             tampak wajar. Semua bagian digabung dulu lewat jalur yang sama yang
             dipakai pratinjau, lalu frame diambil dari hasil gabungannya. */
          const resolved = await resolveFileParts(fileKey);
          let sourcePath = null;
          if (resolved && resolved.isSplit) {
            sourcePath = await ensureMergedCache(fileKey, resolved.parts, resolved.baseName);
          } else {
            let downloaded = await client.downloadMedia(msg.media, { workers: 4 });
            if (!downloaded || !downloaded.length) return null;
            fs.writeFileSync(tmpPath, downloaded);
            sourcePath = tmpPath;
          }
          if (!sourcePath || !fs.existsSync(sourcePath)) return null;

          /* Kalau nama dan mimeType tidak mengenali jenis berkasnya, isi yang
             menentukan. Berlaku untuk berkas yang datang sebagai
             application/octet-stream tanpa ekstensi — dan ternyata banyak juga
             yang berupa foto. */
          let kind = isPdfFile ? 'pdf' : (isVideoFile ? 'video' : (isImageFile ? 'image' : ''));
          if (!kind) {
            let kepala = null;
            try {
              const fd = fs.openSync(sourcePath, 'r');
              const b = Buffer.alloc(16);
              fs.readSync(fd, b, 0, 16, 0);
              fs.closeSync(fd);
              kepala = b;
            } catch (e) { kepala = null; }
            const jenis = sniffImageKind(kepala);
            if (!jenis) return null;
            kind = jenis.mime === 'application/pdf' ? 'pdf'
              : (jenis.mime.indexOf('video/') === 0 ? 'video' : 'image');
          }

          /* Video lewat ffmpeg: satu frame pada detik ~1 diubah ke WebP. Ini
             satu-satunya cara .mov HEVC muncul sebagai gambar — browser tidak
             bisa memecahkan codec-nya, dan Sharp hanya menerima gambar.

             Dilewati untuk berkas besar: mengunduh puluhan MB demi satu gambar
             tidak sepadan, dan video sebesar itu hampir selalu sudah membawa
             thumbnail Telegram sendiri di langkah di atas. */
          if (kind === 'video' && await hasFfmpeg()) {
            if (totalSize > FFMPEG_MAX_BYTES) {
              console.log(`Video ${file.filename} (${(totalSize / 1024 / 1024).toFixed(1)} MB) melewati batas frame ffmpeg.`);
              return null;
            }
            const source = fs.readFileSync(sourcePath);
            let buf = null;
            for (const at of [1, 0, 3]) {
              try {
                buf = await ffmpegThumb(source, at, thumbExt);
                break;
              } catch (e1) {
                console.log(`ffmpeg gagal di detik ${at}: ${e1.message}`);
              }
            }
            if (!buf) return null;
            fs.writeFileSync(webpPath, buf);
            db.updateFileThumb(fileKey, 'local_cached');
            return webpPath;
          }

          /* PDF: halaman pertama digambar pdftoppm lalu dijadikan WebP. Ditaruh
             sebelum cabang video karena keduanya memakai biner eksternal tapi
             alatnya berbeda. */
          if (kind === 'pdf') {
            const source = fs.readFileSync(sourcePath);
            let png = null;
            try {
              png = await pdfFirstPage(source);
            } catch (ePdf) {
              console.log(`pdftoppm gagal untuk ${file.filename}: ${ePdf.message}`);
              if (await hasFfmpeg()) {
                try { png = await ffmpegPdfThumb(source); }
                catch (e2) { console.log(`ffmpeg PDF juga gagal: ${e2.message}`); }
              }
            }
            if (!png) return null;
            try {
              const buf = await sharp(png)
                .resize(600, 600, { fit: 'inside', withoutEnlargement: true })
                .webp({ quality: 72 })
                .toBuffer();
              fs.writeFileSync(webpPath, buf);
              db.updateFileThumb(fileKey, 'local_cached');
              return webpPath;
            } catch (eSharp) {
              console.log(`Sharp gagal atas hasil render PDF ${file.filename}: ${eSharp.message}`);
              return null;
            }
          }

          const thumbSource = fs.readFileSync(sourcePath);
          /* HEIC/HEIF lewat heif-convert dulu: build sharp di npm tidak memuat
             plugin HEVC, jadi Sharp akan menolak berkasnya apa adanya. Nama
             berkas dipakai di sini karena hanya itu yang membedakan HEIC dari
             JPEG pada tahap ini. */
          let source = thumbSource;
          if (isHeifName(file.filename) || sniffImageKind(thumbSource.slice(0, 16))?.exts?.[0] === '.heic') {
            const png = await decodeHeifToPng(thumbSource, thumbExt);
            if (png) source = png;
          }

          const buf = await sharp(source)
            .resize(400, 400, { fit: 'cover', position: 'centre' })
            .webp({ quality: 70 })
            .toBuffer();
          fs.writeFileSync(webpPath, buf);
          db.updateFileThumb(fileKey, 'local_cached');
          return webpPath;
        } finally {
          try { fs.unlinkSync(tmpPath); } catch {}
        }
      } finally {
        releaseThumbSlot();
      }
    });

    if (!built) {
      thumbMisses.set(fileKey, Date.now());
      return sendNoThumb(res);
    }
    return sendCachedThumb(res, built);
  } catch (err) {
    console.error('Thumbnail error:', err.message);
    thumbMisses.set(fileKey, Date.now());
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

    // Every branch below answers with these. `inline` is what lets a PDF render
    // inside the preview frame instead of becoming a download in Firefox and
    // Safari, and the cached original behind a file_key never changes, so an
    // hour of private caching removes the re-fetch when the pane is reopened.
    res.setHeader('Content-Disposition', "inline; filename*=UTF-8''" + encodeURIComponent(baseName));
    res.setHeader('Cache-Control', 'private, max-age=3600');

    // For images, use compressed preview if available
    if (category === 'image') {
      const compressedPath = path.join(cacheDir, `${fileKey}.webp`);
      // Check if compressed version already exists
      if (fs.existsSync(compressedPath)) {
        res.setHeader('Content-Type', 'image/webp');
        return res.sendFile(compressedPath);
      }

      // Compress the image with Sharp. Ini juga jalur yang membuat HEIC/HEIF
      // bisa tampil: browser tidak punya decoder-nya, jadi harus keluar sebagai
      // WebP dari sini — bukan sebagai berkas asli.
      try {
        const originalBuffer = fs.readFileSync(targetPath);
        const compressedBuffer = await compressImage(originalBuffer, 1920, 80, baseName);
        const isHeif = isHeifName(baseName);
        if (compressedBuffer.length < originalBuffer.length || isHeif) {
          // Kompresi menguntungkan, atau ini HEIC yang wajib dikonversi walau
          // hasilnya sedikit lebih besar.
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

// 7a. Text preview — bounded.
//
// The old text branch pointed the client at /api/preview and read the whole
// body, so a 200 MB log became a 200 MB fetch that the browser then tried to
// lay out inside one <pre>. This returns at most TEXT_PREVIEW_BYTES and reports
// what it left out, so the pane can say "256 KB pertama dari 1,2 GB" instead of
// freezing. The original still comes down from Telegram in full — a ranged
// MTProto read is a far larger change — so the client keeps its own ceiling on
// which files are worth opening as text at all.
const TEXT_PREVIEW_BYTES = 256 * 1024;

app.get('/api/text/:fileKey', checkConfig, async (req, res) => {
  const { fileKey } = req.params;
  try {
    const resolved = await resolveFileParts(fileKey);
    if (!resolved) return res.status(404).json({ error: 'File tidak ditemukan.' });

    const { file, parts, baseName, isSplit } = resolved;
    if (!file.telegram_media_id) {
      return res.status(400).json({ error: 'Berkas lama tidak didukung pada skema login MTProto baru.' });
    }

    const targetPath = isSplit
      ? await ensureMergedCache(fileKey, parts, baseName)
      : await ensureCachedOriginal(file, fileKey, baseName, 'text-preview');

    const stat = fs.statSync(targetPath);
    const limit = Math.min(TEXT_PREVIEW_BYTES, stat.size);
    const buf = Buffer.alloc(limit);
    const fd = fs.openSync(targetPath, 'r');
    try { fs.readSync(fd, buf, 0, limit, 0); } finally { fs.closeSync(fd); }

    let text = buf.toString('utf8');
    const truncated = stat.size > limit;
    // A multi-byte character straddling the cut renders as a replacement glyph,
    // so when there is more to come the tail is trimmed to the last newline.
    if (truncated) {
      const nl = text.lastIndexOf('\n');
      if (nl > limit / 2) text = text.slice(0, nl);
    }

    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.json({ text, truncated, bytes: limit, totalBytes: stat.size });
  } catch (err) {
    console.error('Text preview error:', err.message);
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
// Last run's tally, surfaced through /api/sync-status so the UI can say what a
// sync actually did instead of only that it finished.
let syncProgress = { added: 0, skipped: 0, scanned: 0, errors: 0, finishedAt: null, aborted: null };

app.post('/api/sync', checkConfig, async (req, res) => {
  if (syncInProgress) {
    return res.json({ success: true, message: 'Sync sudah berjalan...' });
  }
  syncInProgress = true;
  syncProgress = { added: 0, skipped: 0, scanned: 0, errors: 0, finishedAt: null, aborted: null };
  res.json({ success: true, message: 'Memulai sinkronisasi...' });

  // Continue in background
  syncAllFromChannel().then(result => {
    syncInProgress = false;
    console.log(`Sync selesai: ${result.added} file baru ditambahkan, ${result.skipped} sudah ada.`);
  }).catch(err => {
    syncInProgress = false;
    syncProgress.aborted = err.message;
    syncProgress.finishedAt = new Date().toISOString();
    console.error('Sync error:', err.message);
    db.logActivity('Sync', `Sinkronisasi gagal: ${err.message}`, 'error');
  });
});

const SYNC_BATCH = 100;
const SYNC_MAX_RETRIES = 3;      // per batch, for errors that are not FLOOD_WAIT
const SYNC_MAX_FLOOD_WAIT = 300; // seconds; longer than this and we give up rather than hang

async function syncAllFromChannel() {
  let added = 0;
  let skipped = 0;
  let scanned = 0;
  let errors = 0;
  let offsetId = 0;
  let retries = 0;

  console.log('Memulai sinkronisasi dari channel Telegram...');
  db.logActivity('Sync', 'Memulai sinkronisasi dari channel Telegram...');

  await ensureConnection();

  while (true) {
    let messages;
    try {
      const result = await client.invoke(new Api.messages.GetHistory({
        peer: config.chatId,
        offsetId: offsetId,
        offsetDate: 0,
        addOffset: 0,
        limit: SYNC_BATCH,
        maxId: 0,
        minId: 0,
        hash: 0
      }));
      messages = result.messages || [];
      retries = 0;
    } catch (err) {
      const wait = floodWaitSeconds(err);
      if (wait > 0 && wait <= SYNC_MAX_FLOOD_WAIT) {
        console.log(`Sync: FLOOD_WAIT ${wait}s — menunggu lalu melanjutkan dari offset ${offsetId}.`);
        db.logActivity('Sync', `Telegram meminta jeda ${wait}s; sinkronisasi dilanjutkan setelah itu.`);
        await new Promise(r => setTimeout(r, (wait + 1) * 1000));
        continue; // same offsetId — this batch was never read
      }
      if (++retries <= SYNC_MAX_RETRIES) {
        console.error(`Sync batch error (percobaan ${retries}/${SYNC_MAX_RETRIES}): ${err.message}`);
        await new Promise(r => setTimeout(r, 1000 * retries));
        continue;
      }
      // Out of retries. Fail loudly instead of returning a partial tally that
      // reads like a complete one.
      throw new Error(`gagal membaca riwayat pada offset ${offsetId}: ${err.message}`);
    }

    if (messages.length === 0) break;

    for (const msg of messages) {
      scanned++;
      try {
        const info = describeSyncMedia(msg);
        if (!info) continue;

        const fileKey = `sync_${msg.id}`;
        let existing;
        try { existing = db.getFile(fileKey); } catch { existing = null; }
        if (existing) {
          skipped++;
          continue;
        }

        /* Pesan yang sama dengan id berbeda (dikirim ulang, atau diunggah dua
           kali) menghasilkan entri ganda yang isinya identik. Nama + ukuran
           adalah pasangan yang cukup untuk mengenalinya tanpa membaca isi
           berkas, dan sudah dipakai jalur unggah. */
        let kembar = null;
        try { kembar = db.getFileByNameAndSize(info.filename, info.totalSize); } catch { kembar = null; }
        if (kembar) {
          skipped++;
          continue;
        }

        const category = getCategory(info.filename, info.mimeType);
        db.saveFile(
          fileKey,
          info.filename,
          info.mimeType,
          category,
          info.totalSize,
          msg.id.toString(),
          info.accessHash,
          info.fileReference,
          null,
          info.dcId
        );
        added++;
      } catch (msgErr) {
        errors++;
        console.error(`Error syncing message ID ${msg.id}:`, msgErr.message);
      }
    }

    syncProgress.added = added;
    syncProgress.skipped = skipped;
    syncProgress.scanned = scanned;
    syncProgress.errors = errors;

    // GetHistory returns newest → oldest, so the last entry is the oldest one
    // read; offsetId walks backwards from there.
    offsetId = messages[messages.length - 1].id;

    if (messages.length < SYNC_BATCH) break;

    // Small delay to avoid rate limiting
    await new Promise(r => setTimeout(r, 200));
  }

  const result = { added, skipped, scanned, errors };
  syncProgress = { ...result, finishedAt: new Date().toISOString(), aborted: null };
  db.logActivity(
    'Sync',
    `Sinkronisasi selesai: ${added} file baru, ${skipped} sudah ada, ${scanned} pesan diperiksa` +
    (errors ? `, ${errors} gagal disimpan.` : '.'),
    errors ? 'error' : 'success'
  );
  return result;
}

// 14. Sync status
app.get('/api/sync-status', (req, res) => {
  res.json({ syncing: syncInProgress, progress: syncProgress });
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
