/**
 * TEMP MAIL (mail.tm)
 * ---------------------------------------------------------------------------
 * A single throwaway mailbox for this drive's operator: generate an address,
 * poll the inbox, read a message. Backed by mail.tm's public API, which needs
 * no key and no account — the address IS the account.
 *
 * Scope, deliberately: this hands you a mailbox. It does not fill in anyone's
 * signup form, and nothing here should be pointed at a third-party site to
 * register accounts in bulk. That is a terms-of-service violation and the
 * opening move of spam, fake reviews and free-trial farming, so the module
 * stops at "here is an inbox, here is what arrived".
 *
 * Design notes:
 *
 * One mailbox at a time, kept in data/tempmail.json. Persisting matters: a
 * restart halfway through a verification flow must not orphan the address you
 * already handed to someone. Only the address and the throwaway password are
 * stored — the password exists purely so a token can be re-minted after it
 * expires, and the value is generated here, never typed in, never logged.
 *
 * Tokens are minted on demand and re-minted on a 401 rather than tracked
 * against a clock. mail.tm does not advertise a lifetime for them, so
 * bookkeeping an expiry would be guessing; a 401 is the only honest signal.
 *
 * No new dependency: Node's global fetch covers it. Every call carries a
 * timeout, because a hung upstream would otherwise wedge the Express request.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { dataDir } = require('./data-dir');

const BASE = 'https://api.mail.tm';
const TIMEOUT_MS = 15000;
const storePath = path.join(dataDir, 'tempmail.json');

// ── pure helpers (exported for test/tempmail.test.js) ───────────────────────

// mail.tm answers in JSON-LD: the array lives under 'hydra:member'. Some
// deployments and some error paths use the plain 'member' key, and an empty
// or malformed body must not throw — an inbox that fails to parse should look
// like an empty inbox, not a 500.
function hydraList(body) {
  if (!body || typeof body !== 'object') return [];
  const arr = body['hydra:member'] || body.member;
  return Array.isArray(arr) ? arr : [];
}

// A domain can be listed but switched off; registering against an inactive one
// fails. Falls back to the first entry rather than nothing, so a shape change
// upstream degrades instead of dead-ending.
function pickActiveDomain(domains) {
  const active = domains.filter(d => d && d.isActive && d.domain);
  const chosen = active[0] || domains.find(d => d && d.domain);
  return chosen ? chosen.domain : '';
}

// Both halves are random and both are long enough that a collision is not a
// case worth handling: mail.tm answers 422 for a taken address and create()
// surfaces that as an ordinary failure the caller can retry.
function newAddress(domain) {
  return crypto.randomBytes(5).toString('hex') + '@' + domain;
}

function newPassword() {
  return crypto.randomBytes(12).toString('base64url');
}

// Only the fields the UI renders. Mail.tm's message object carries JSON-LD
// noise ('@id', '@type', hydra links) that has no business reaching a browser.
function shapeMessage(m) {
  if (!m || typeof m !== 'object') return null;
  const from = m.from || {};
  return {
    id: m.id || '',
    from: from.address || '',
    fromName: from.name || '',
    subject: m.subject || '(tanpa subjek)',
    intro: m.intro || '',
    seen: !!m.seen,
    createdAt: m.createdAt || ''
  };
}

// ── state ──────────────────────────────────────────────────────────────────

let account = readStore();
let token = null;

function readStore() {
  try {
    const raw = JSON.parse(fs.readFileSync(storePath, 'utf8'));
    return raw && raw.address ? { address: raw.address, password: raw.password || '' } : null;
  } catch {
    return null; // absent, empty or corrupt — all mean "no mailbox yet"
  }
}

function writeStore() {
  try {
    if (!account) fs.rmSync(storePath, { force: true });
    else fs.writeFileSync(storePath, JSON.stringify(account), 'utf8');
  } catch (err) {
    // Losing the file costs a mailbox on restart, not data. Worth continuing.
    console.error('Temp mail: could not persist mailbox state:', err.message);
  }
}

// ── upstream calls ─────────────────────────────────────────────────────────

async function call(method, urlPath, body, bearer) {
  const headers = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (bearer) headers.Authorization = 'Bearer ' + bearer;

  const res = await fetch(BASE + urlPath, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS)
  });

  // 204 (account deleted) has no body; json() would throw on it.
  const text = await res.text();
  let parsed = null;
  if (text) { try { parsed = JSON.parse(text); } catch { parsed = null; } }
  return { status: res.status, body: parsed };
}

// mail.tm puts the human-readable reason in 'hydra:description' on a 422 and
// in 'message' elsewhere. Surfacing the upstream text is more useful than a
// generic string, and it is their error, not user input.
function upstreamError(r, fallback) {
  const b = r.body || {};
  return b['hydra:description'] || b.message || (fallback + ' (HTTP ' + r.status + ')');
}

async function mintToken() {
  const r = await call('POST', '/token', { address: account.address, password: account.password });
  if (r.status !== 200 || !r.body || !r.body.token) {
    throw new Error('Gagal mengambil token mail.tm: ' + upstreamError(r, 'ditolak'));
  }
  token = r.body.token;
  return token;
}

// Everything that reads the mailbox goes through here: mint if needed, and on
// a 401 mint once more and retry. Exactly one retry — a second 401 means the
// mailbox itself is gone upstream, and looping would just spin.
async function authed(method, urlPath, body) {
  if (!account) throw new Error('Belum ada alamat temp mail. Buat dulu.');
  if (!token) await mintToken();
  let r = await call(method, urlPath, body, token);
  if (r.status === 401) {
    token = null;
    await mintToken();
    r = await call(method, urlPath, body, token);
  }
  return r;
}

// ── public API ─────────────────────────────────────────────────────────────

// The current address without touching the network, so the UI can render the
// panel instantly. `live` verifies it still exists upstream — worth doing on
// an explicit refresh, not on every page load.
async function current({ live = false } = {}) {
  if (!account) return null;
  if (live) {
    try {
      const r = await authed('GET', '/me');
      if (r.status === 404) { await destroy(); return null; }
    } catch (err) {
      // Upstream unreachable is not proof the mailbox died. Report what we have.
      console.error('Temp mail: liveness check failed:', err.message);
    }
  }
  return { address: account.address };
}

async function create() {
  const d = await call('GET', '/domains');
  if (d.status !== 200) throw new Error('Tidak bisa mengambil daftar domain: ' + upstreamError(d, 'gagal'));
  const domain = pickActiveDomain(hydraList(d.body));
  if (!domain) throw new Error('mail.tm tidak menyediakan domain aktif saat ini.');

  const address = newAddress(domain);
  const password = newPassword();

  const a = await call('POST', '/accounts', { address, password });
  // 201 is documented, but accept any 2xx so a change there does not break us.
  if (a.status < 200 || a.status > 299) {
    throw new Error('Gagal membuat alamat ' + address + ': ' + upstreamError(a, 'ditolak'));
  }

  account = { address, password };
  token = null;
  writeStore();
  return { address };
}

async function inbox() {
  const r = await authed('GET', '/messages?page=1');
  if (r.status !== 200) throw new Error('Gagal membaca inbox: ' + upstreamError(r, 'gagal'));
  // mail.tm returns oldest-first within a page; the newest arrival is what
  // anyone opening the panel is looking for.
  return hydraList(r.body).map(shapeMessage).filter(Boolean).reverse();
}

async function message(id) {
  if (!/^[a-f0-9]{24}$/i.test(String(id || ''))) {
    // Mongo-style ids only. Stops the id becoming a path into mail.tm's API.
    throw Object.assign(new Error('Id pesan tidak valid.'), { status: 400 });
  }
  const r = await authed('GET', '/messages/' + id);
  if (r.status === 404) throw Object.assign(new Error('Pesan tidak ditemukan.'), { status: 404 });
  if (r.status !== 200) throw new Error('Gagal membaca pesan: ' + upstreamError(r, 'gagal'));

  const b = r.body || {};
  const shaped = shapeMessage(b);
  return {
    ...shaped,
    text: b.text || '',
    // An array of html strings. Joined because the UI renders one body.
    html: Array.isArray(b.html) ? b.html.join('\n') : (b.html || '')
  };
}

// Local state is always cleared, whatever the remote call does. The failure
// worth avoiding is the opposite of a leak: an address that died upstream but
// stayed in the store would leave the panel showing a mailbox that can receive
// nothing and cannot be dismissed. If mail.tm is unreachable or the account is
// already gone, minting a token throws — which says nothing about whether
// clearing locally is right. An orphaned mailbox upstream expires on its own.
// `remoteDeleted` reports the truth so the caller can say which happened.
async function destroy() {
  if (!account) return { deleted: false, remoteDeleted: false };
  let remoteDeleted = false;
  try {
    const me = await authed('GET', '/me');
    const id = me.status === 200 && me.body ? me.body.id : null;
    if (!id) remoteDeleted = true; // already gone upstream
    else {
      const r = await authed('DELETE', '/accounts/' + id);
      remoteDeleted = r.status === 204 || r.status === 200 || r.status === 404;
    }
  } catch (err) {
    console.error('Temp mail: remote delete failed, clearing locally:', err.message);
  }

  account = null;
  token = null;
  writeStore();
  return { deleted: true, remoteDeleted };
}

module.exports = {
  current,
  create,
  inbox,
  message,
  destroy,
  // pure, for tests
  hydraList,
  pickActiveDomain,
  newAddress,
  newPassword,
  shapeMessage
};
