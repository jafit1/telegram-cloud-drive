const crypto = require('crypto');

// ============================================================
// AUTHENTICATION
// ------------------------------------------------------------
// Gate every /api/* route behind a single shared password taken
// from DRIVE_PASSWORD. Sessions are stateless: an HMAC-signed
// cookie that survives restarts as long as DRIVE_SECRET is set.
// ============================================================

const PASSWORD = process.env.DRIVE_PASSWORD || '';
const COOKIE_NAME = 'drive_session';
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// Signing secret. If not provided we generate an ephemeral one, which
// means every restart invalidates outstanding sessions (safe, just less
// convenient). Warn loudly so production sets a stable value.
let SECRET = process.env.DRIVE_SECRET || '';
if (!SECRET) {
  SECRET = crypto.randomBytes(32).toString('hex');
  if (PASSWORD) {
    console.warn('WARNING: DRIVE_SECRET is not set — sessions reset on every restart. Set DRIVE_SECRET to a long random string.');
  }
}

if (!PASSWORD) {
  console.error('');
  console.error('  ============================================================');
  console.error('  FATAL: DRIVE_PASSWORD is not set.');
  console.error('');
  console.error('  This drive exposes your Telegram account. Running it without');
  console.error('  a password would let anyone read, upload, delete, or hijack');
  console.error('  the session. Refusing to start.');
  console.error('');
  console.error('  Set it before launching:');
  console.error('    Railway  ->  Variables  ->  DRIVE_PASSWORD = <a long password>');
  console.error('    Local    ->  $env:DRIVE_PASSWORD="..."   (PowerShell)');
  console.error('                 export DRIVE_PASSWORD="..." (bash)');
  console.error('');
  console.error('  Also set DRIVE_SECRET to a long random string to keep');
  console.error('  sessions alive across restarts.');
  console.error('  ============================================================');
  console.error('');
  process.exit(1);
}

// ── Brute-force throttle ────────────────────────────────────
// Per-IP failure counter with exponential lockout.
const failures = new Map(); // ip -> { count, lockedUntil }
const MAX_ATTEMPTS = 5;
const BASE_LOCKOUT_MS = 30 * 1000;

function clientIp(req) {
  // trust proxy is enabled in server.js, so req.ip already reflects
  // X-Forwarded-For when running behind Railway's edge.
  return req.ip || req.connection?.remoteAddress || 'unknown';
}

function isLockedOut(ip) {
  const entry = failures.get(ip);
  if (!entry) return 0;
  const remaining = entry.lockedUntil - Date.now();
  return remaining > 0 ? remaining : 0;
}

function recordFailure(ip) {
  const entry = failures.get(ip) || { count: 0, lockedUntil: 0 };
  entry.count++;
  if (entry.count >= MAX_ATTEMPTS) {
    // 30s, 60s, 120s, 240s ... capped at 15 minutes
    const overage = entry.count - MAX_ATTEMPTS;
    entry.lockedUntil = Date.now() + Math.min(BASE_LOCKOUT_MS * Math.pow(2, overage), 15 * 60 * 1000);
  }
  failures.set(ip, entry);
}

function clearFailures(ip) {
  failures.delete(ip);
}

// Drop stale throttle entries hourly so the map cannot grow without bound.
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of failures) {
    if (entry.lockedUntil < now - 60 * 60 * 1000) failures.delete(ip);
  }
}, 60 * 60 * 1000).unref();

// ── Constant-time password comparison ───────────────────────
function passwordMatches(candidate) {
  if (typeof candidate !== 'string' || candidate.length === 0) return false;
  // Hash both sides first so timingSafeEqual always gets equal-length
  // buffers and the comparison leaks nothing about password length.
  const a = crypto.createHash('sha256').update(candidate).digest();
  const b = crypto.createHash('sha256').update(PASSWORD).digest();
  return crypto.timingSafeEqual(a, b);
}

// ── Token issue / verify ────────────────────────────────────
function sign(payload) {
  return crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');
}

function issueToken() {
  const expiry = Date.now() + SESSION_TTL_MS;
  const nonce = crypto.randomBytes(12).toString('base64url');
  const payload = `${expiry}.${nonce}`;
  return `${payload}.${sign(payload)}`;
}

function verifyToken(token) {
  if (typeof token !== 'string') return false;
  const parts = token.split('.');
  if (parts.length !== 3) return false;

  const [expiryRaw, nonce, providedSig] = parts;
  const payload = `${expiryRaw}.${nonce}`;
  const expectedSig = sign(payload);

  const provided = Buffer.from(providedSig);
  const expected = Buffer.from(expectedSig);
  if (provided.length !== expected.length) return false;
  if (!crypto.timingSafeEqual(provided, expected)) return false;

  const expiry = parseInt(expiryRaw, 10);
  if (!Number.isFinite(expiry) || Date.now() > expiry) return false;

  return true;
}

// ── Cookie helpers ──────────────────────────────────────────
function parseCookies(header) {
  const out = {};
  if (!header) return out;
  header.split(';').forEach(pair => {
    const idx = pair.indexOf('=');
    if (idx < 0) return;
    const key = pair.slice(0, idx).trim();
    const val = pair.slice(idx + 1).trim();
    if (key) out[key] = decodeURIComponent(val);
  });
  return out;
}

function setSessionCookie(res, token) {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  res.setHeader('Set-Cookie',
    `${COOKIE_NAME}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}${secure}`);
}

function clearSessionCookie(res) {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secure}`);
}

function isAuthenticated(req) {
  const cookies = parseCookies(req.headers.cookie);
  const token = cookies[COOKIE_NAME];
  if (token && verifyToken(token)) return true;

  // Allow a bearer token too, so curl / scripts can talk to the API.
  const auth = req.headers.authorization || '';
  if (auth.startsWith('Bearer ')) return verifyToken(auth.slice(7).trim());

  return false;
}

// ── Middleware ──────────────────────────────────────────────
function requireAuth(req, res, next) {
  if (isAuthenticated(req)) return next();
  res.status(401).json({ error: 'Tidak terautentikasi. Silakan masuk terlebih dahulu.', unauthenticated: true });
}

// ── Route handlers ──────────────────────────────────────────
function loginHandler(req, res) {
  const ip = clientIp(req);

  const lockRemaining = isLockedOut(ip);
  if (lockRemaining > 0) {
    const seconds = Math.ceil(lockRemaining / 1000);
    return res.status(429).json({ error: `Terlalu banyak percobaan gagal. Coba lagi dalam ${seconds} detik.` });
  }

  const { password } = req.body || {};
  if (!passwordMatches(password)) {
    recordFailure(ip);
    console.log(`Failed login attempt from ${ip}`);
    return res.status(401).json({ error: 'Password salah.' });
  }

  clearFailures(ip);
  setSessionCookie(res, issueToken());
  console.log(`Successful login from ${ip}`);
  res.json({ success: true });
}

function logoutHandler(req, res) {
  clearSessionCookie(res);
  res.json({ success: true });
}

function statusHandler(req, res) {
  res.json({ authenticated: isAuthenticated(req) });
}

module.exports = {
  requireAuth,
  loginHandler,
  logoutHandler,
  statusHandler,
  isAuthenticated
};
