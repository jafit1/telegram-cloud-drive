/* ============================================================================
   Drive Uyee — Frontend Application
   ----------------------------------------------------------------------------
   Modern minimalis UI logic. Works with index.html + css/nexus.css (built from src/input.css).
   Aligned with server.js API endpoints.
   ========================================================================== */

(function () {
'use strict';

/* ─────────────────────────────────────────────────────────────
   STATE
   ───────────────────────────────────────────────────────────── */
var state = {
  loggedIn: false,
  setupNeeded: false,
  authId: null,
  files: [],
  filteredFiles: [],
  selectedIds: new Set(),
  activeCategory: 'all',
  searchQuery: '',
  sortBy: 'newest',
  sizeFilter: 'all',
  extensionFilter: '',
  layout: localStorage.getItem('drive-layout') || 'grid',
  theme: localStorage.getItem('drive-theme') || (document.documentElement.classList.contains('dark') ? 'dark' : 'light'),
  connectionState: 'connected',
  isBulkMode: false,
  lightboxIndex: -1,
  lightboxList: [],
  uploads: [],
  contextFile: null,
  logs: [],
  tempmailAddress: null,
  tempmailMessages: [],
  tempmailPoll: null,
};

/* ─────────────────────────────────────────────────────────────
   UTILITIES
   ───────────────────────────────────────────────────────────── */
function $(id) { return document.getElementById(id); }
function $$(sel, ctx) { return Array.prototype.slice.call((ctx || document).querySelectorAll(sel)); }

function formatBytes(bytes) {
  if (!bytes || bytes <= 0) return '0 B';
  var units = ['B', 'KB', 'MB', 'GB', 'TB'];
  var i = Math.floor(Math.log(bytes) / Math.log(1024));
  if (i >= units.length) i = units.length - 1;
  return (bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1) + ' ' + units[i];
}

function formatDate(ts) {
  if (!ts) return '-';
  var d = new Date(ts);
  if (isNaN(d.getTime())) return '-';
  var now = new Date();
  var diff = (now - d) / 1000;
  if (diff < 60) return 'Baru saja';
  if (diff < 3600) return Math.floor(diff / 60) + ' menit lalu';
  if (diff < 86400) return Math.floor(diff / 3600) + ' jam lalu';
  if (diff < 2592000) return Math.floor(diff / 86400) + ' hari lalu';
  return d.toLocaleDateString('id-ID', { day: 'numeric', month: 'short', year: 'numeric' });
}

function getFileExt(name) {
  var parts = (name || '').split('.');
  return parts.length > 1 ? parts.pop().toLowerCase() : '';
}

function getFileCategory(file) {
  if (file.category === 'folder') return 'folder';
  var ext = getFileExt(file.filename || file.name || '');
  var mime = file.mime_type || '';
  // MIME diperiksa lebih dulu: sebagian berkas tidak punya ekstensi sama sekali,
  // dan menebak dari nama saja akan menaruh foto ke dalam Dokumen.
  if (mime.indexOf('image/') === 0) return 'image';
  if (mime.indexOf('video/') === 0) return 'video';
  if (mime.indexOf('audio/') === 0) return 'audio';
  if (['jpg','jpeg','png','gif','webp','svg','bmp','ico','tiff','tif','heic','heif','avif'].indexOf(ext) >= 0) return 'image';
  if (['mp4','mkv','avi','mov','webm','flv','wmv','m4v','mpg','mpeg','3gp','ts'].indexOf(ext) >= 0) return 'video';
  if (['mp3','wav','flac','aac','ogg','m4a','opus'].indexOf(ext) >= 0) return 'audio';
  return 'document';
}

// Whether to point an <img> at /api/thumb for this row.
//
// `telegram_thumb_id` only gets written once a thumbnail has already been
// cached, so gating on it alone meant nothing synced from the channel ever
// showed a preview — every one of those rows carries null and the grid was a
// wall of grey generic icons. The endpoint builds a thumbnail on demand (native
// Telegram thumb first, Sharp on the original as a fallback) and answers 404
// when it truly cannot, so asking for one is safe: `loading="lazy"` keeps it to
// the cards actually on screen, and every <img> below has an onerror that swaps
// the file-type icon back in.
// PDFs are worth asking for too: Telegram attaches a rendered first-page thumb
// to the document itself, so the endpoint answers from `.thumbs` without ever
// touching the original. Everything else stays on its icon — a 404 per card is
// cheap but not free, and the negative cache only helps after the first miss.
var THUMB_DOC_EXTS = ['pdf'];

// HEIC/HEIF tidak punya thumbnail bawaan yang bisa dirender, jadi kartunya
// harus tetap meminta /api/thumb — server yang mengubahnya ke WebP.
var IMAGE_EXT_ALWAYS_THUMB = ['jpg','jpeg','png','gif','webp','bmp','heic','heif','avif','tiff','tif'];

function shouldTryThumb(file, cat) {
  if (file.telegram_thumb_id) return true;
  if (cat === 'video') return true;
  if (cat === 'image') return true;
  // PDF dirender halaman pertamanya oleh server, jadi kartunya punya isi yang
  // bisa dikenali alih-alih ikon generik.
  return THUMB_DOC_EXTS.indexOf(getFileExt(file.filename || file.name || '')) >= 0;
}

// Builds a thumbnail cell: the <img>, with the file-type icon sitting beside it
// as a real element that the error handler reveals.
//
// It used to inline getFileIconSvg() into the onerror attribute itself. That
// could never have worked — the SVG that function returns is full of double
// quotes (class="w-8 h-8", viewBox="0 0 24 24") and the attribute was
// double-quoted too, so the browser ended the handler at the first inner quote
// and scattered the remainder of the SVG across the tag as stray attributes. A
// thumbnail that 404'd left an empty box. Swapping the `hidden` class between
// two siblings keeps the handler free of quote characters altogether.
//
// The fallback carries `hidden flex` on purpose: .hidden is emitted after .flex
// in the generated utilities, so it wins until the class is removed and the
// element then lays out as a centred flex box. Same idiom as the forms in
// index.html.
function thumbCell(file, cat, ext, wrapClass, iconColor) {
  var fallback = '<div class="hidden flex w-full h-full items-center justify-center" style="color:' + iconColor + '">' +
    getFileIconSvg(cat, ext) + '</div>';

  if (!shouldTryThumb(file, cat)) {
    return '<div class="' + wrapClass + '" style="color:' + iconColor + '">' + getFileIconSvg(cat, ext) + '</div>';
  }

  return '<div class="' + wrapClass + '">' +
    '<img src="/api/thumb/' + encodeURIComponent(file.file_key) + '" class="w-full h-full object-cover" alt="" loading="lazy" decoding="async"' +
    " onerror=\"this.classList.add('hidden');this.nextElementSibling.classList.remove('hidden')\">" +
    fallback +
    '</div>';
}

var extColors = {
  pdf: '#d93025', doc: '#1a73e8', docx: '#1a73e8', xls: '#1e8e3e', xlsx: '#1e8e3e',
  ppt: '#f9ab00', pptx: '#f9ab00', zip: '#f9ab00', rar: '#f9ab00', '7z': '#f9ab00',
  txt: '#5f6368', md: '#5f6368', json: '#5f6368', js: '#f9ab00', ts: '#1a73e8',
  apk: '#1e8e3e', exe: '#d93025', dmg: '#5f6368', iso: '#5f6368',
};

function getExtColor(ext) { return extColors[ext] || '#5f6368'; }

function escapeHtml(s) {
  if (!s) return '';
  return String(s).replace(/[&<>"']/g, function (c) {
    return { '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c];
  });
}

function showToast(msg, kind) {
  var t = $('toast');
  if (!t) return;
  $('toast-msg').textContent = msg;
  var dot = $('toast-dot');
  if (dot) {
    dot.style.backgroundColor = kind === 'error' ? 'rgb(var(--c-danger))'
      : kind === 'success' ? 'rgb(var(--c-success))'
      : 'rgb(var(--c-accent))';
  }
  t.classList.remove('hidden');
  clearTimeout(t._timer);
  t._timer = setTimeout(function () { t.classList.add('hidden'); }, kind === 'error' ? 6000 : 3500);
}

function showConfirm(message, onConfirm, title) {
  var modal = $('confirm-modal');
  if (!modal) return;
  $('confirm-title').textContent = title || 'Konfirmasi';
  $('confirm-message').textContent = message;
  modal.classList.remove('hidden');

  var okBtn = $('confirm-btn-ok');
  var cancelBtn = $('confirm-btn-cancel');
  var closeBtn = $('confirm-close');

  function cleanup() {
    modal.classList.add('hidden');
    okBtn.removeEventListener('click', handleOk);
    cancelBtn.removeEventListener('click', handleClose);
    closeBtn.removeEventListener('click', handleClose);
  }
  function handleOk() { cleanup(); if (onConfirm) onConfirm(); }
  function handleClose() { cleanup(); }

  okBtn.addEventListener('click', handleOk);
  cancelBtn.addEventListener('click', handleClose);
  closeBtn.addEventListener('click', handleClose);
}

/* ─────────────────────────────────────────────────────────────
   API
   ───────────────────────────────────────────────────────────── */
function api(path, opts) {
  opts = opts || {};
  if (opts.body && typeof opts.body === 'object' && !(opts.body instanceof FormData)) {
    opts.headers = opts.headers || {};
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(opts.body);
  }
  return fetch(path, opts).then(function (res) {
    if (res.status === 401) { handleAuthRequired(); throw new Error('Unauthorized'); }
    return res.json().catch(function () { return {}; }).then(function (data) {
      if (!res.ok) throw Object.assign(new Error(data.error || 'Request failed'), { data: data, status: res.status });
      return data;
    });
  });
}

function handleAuthRequired() {
  // A 401 means the drive session is missing or expired. Every wizard endpoint
  // sits behind that same session, so showing the wizard again here would just
  // reproduce the failure that got us here — the password gate is the only
  // screen that can actually make progress.
  state.loggedIn = false;
  showLoginGate();
}

/* ─────────────────────────────────────────────────────────────
   AUTH
   ───────────────────────────────────────────────────────────── */
function showLoginGate() {
  $('login-gate').classList.remove('hidden');
  $('app-dashboard').classList.add('hidden');
  $('setup-wizard').classList.add('hidden');
  setTimeout(function () { var p = $('login-password'); if (p) p.focus(); }, 100);
}

function showSetupWizard() {
  $('setup-wizard').classList.remove('hidden');
  $('login-gate').classList.add('hidden');
  $('app-dashboard').classList.add('hidden');
  setWizardStep(1);
  applyServerCredentials();
}

/* The wizard opens with both API boxes already filled from what the server has
   stored: the ID verbatim, the Hash masked (bullets plus the last four — the real
   value never leaves the server). Leaving them untouched is the normal path and
   handleSendCode then sends neither field, so the server uses its own copy, which
   survives logout and restarts. Typing over one is what replaces it.

   This reads /api/settings rather than /api/settings/status because the status
   endpoint is deliberately unauthenticated (the gate needs it before login) and
   must not carry credential material. The wizard only ever renders after the
   password gate — see init() — so the authenticated endpoint is available here. */
function applyServerCredentials() {
  var idEl = $('api-id');
  var hashEl = $('api-hash');

  // Dropping the flag on the first keystroke is the whole mechanism that tells
  // "server value, untouched" apart from "the user typed this". Assigned as a
  // property, not addEventListener, so reopening the wizard cannot stack them.
  function markEdited() { delete this.dataset.serverFilled; }
  idEl.oninput = markEdited;
  hashEl.oninput = markEdited;

  api('/api/settings')
    .then(function (s) {
      var hasBoth = !!(s.apiId && s.apiHashSet);
      var note = $('api-creds-detected');
      var details = $('api-creds-details');
      var summary = $('api-creds-summary-text');

      if (hasBoth) {
        idEl.value = s.apiId;
        idEl.dataset.serverFilled = '1';
        hashEl.value = s.apiHashMasked || '';
        hashEl.dataset.serverFilled = '1';
        note.classList.remove('hidden');
        details.open = false;
        summary.textContent = 'Kredensial API tersimpan (buka untuk ganti)';
      } else {
        note.classList.add('hidden');
        details.open = true;
        summary.textContent = 'Kredensial API Telegram';
      }

      // Prefill the storage chat id so the user doesn't retype what's already set.
      var chatInput = $('storage-chat-id');
      if (chatInput && s.chatId && !chatInput.value) chatInput.value = s.chatId;
    })
    .catch(function () { /* wizard still works with manual entry */ });
}

function setWizardStep(step) {
  var items = document.querySelectorAll('#setup-wizard .step-item');
  Array.prototype.forEach.call(items, function (el) {
    var n = parseInt(el.dataset.step, 10);
    el.classList.toggle('active', n === step);
    el.classList.toggle('done', n < step);
  });
}

function showDashboard() {
  $('app-dashboard').classList.remove('hidden');
  $('login-gate').classList.add('hidden');
  $('setup-wizard').classList.add('hidden');
}

function handleLogin(e) {
  e.preventDefault();
  var password = $('login-password').value;
  var btn = e.target.querySelector('button[type="submit"]');
  var spin = btn.querySelector('.spin');
  var span = btn.querySelector('span');
  span.textContent = 'Memproses...';
  spin.classList.remove('hidden');

  api('/api/auth/login', { method: 'POST', body: { password: password } })
    .then(function () {
      state.loggedIn = true;
      $('login-error').classList.add('hidden');
      $('login-password').value = '';
      // The drive password and the Telegram login are two separate steps. If
      // the second one was never completed, go there instead of the dashboard.
      if (state.setupNeeded) {
        showSetupWizard();
        return;
      }
      showDashboard();
      loadFiles();
      checkConnection();
    })
    .catch(function (err) {
      var errEl = $('login-error');
      errEl.textContent = err.data && err.data.error ? err.data.error : 'Password salah';
      errEl.classList.remove('hidden');
    })
    .finally(function () {
      span.textContent = 'Masuk';
      spin.classList.add('hidden');
    });
}

/* ─────────────────────────────────────────────────────────────
   SETUP WIZARD (Step 1: Send Code, Step 2: Sign In)
   ───────────────────────────────────────────────────────────── */
function handleSendCode(e) {
  e.preventDefault();
  var phone = $('phone-number').value.trim();
  var idEl = $('api-id');
  var hashEl = $('api-hash');
  var apiId = idEl.value.trim();
  var apiHash = hashEl.value.trim();
  var errEl = $('step1-error');
  var btn = $('btn-send-otp');
  var spin = btn.querySelector('.spin');
  var span = btn.querySelector('span');

  errEl.classList.add('hidden');
  span.textContent = 'Mengirim...';
  spin.classList.remove('hidden');

  // Send a credential field only when the user actually typed over it. The boxes
  // arrive pre-filled from the server (and the Hash arrives masked), so sending
  // them back unchanged would at best be a no-op and at worst push bullets into
  // the hash validator. Untouched means: let the server use what it has stored.
  var body = { phone: phone };
  if (apiId && !idEl.dataset.serverFilled) body.apiId = apiId;
  if (apiHash && !hashEl.dataset.serverFilled) body.apiHash = apiHash;

  api('/api/auth/send-code', { method: 'POST', body: body })
    .then(function (data) {
      state.authId = data.authId;
      $('field-2fa').classList.add('hidden');
      $('setup-form-step1').classList.add('hidden');
      $('setup-form-step2').classList.remove('hidden');
      setWizardStep(2);
      setTimeout(function () { var p = $('otp-code'); if (p) p.focus(); }, 100);
    })
    .catch(function (err) {
      errEl.textContent = err.data && err.data.error ? err.data.error : 'Gagal mengirim kode OTP';
      errEl.classList.remove('hidden');
    })
    .finally(function () {
      span.textContent = 'Kirim Kode OTP';
      spin.classList.add('hidden');
    });
}

function handleSignIn(e) {
  e.preventDefault();
  var code = $('otp-code').value.trim();
  var password2fa = $('password-2fa').value;
  var chatId = $('storage-chat-id').value.trim();
  var errEl = $('step2-error');
  var successEl = $('step2-success');
  var btn = $('btn-verify-otp');
  var spin = btn.querySelector('.spin');
  var span = btn.querySelector('span');

  errEl.classList.add('hidden');
  successEl.classList.add('hidden');
  span.textContent = 'Memverifikasi...';
  spin.classList.remove('hidden');

  var body = { authId: state.authId, code: code };
  if (password2fa) body.password = password2fa;
  if (chatId) body.chatId = chatId;

  api('/api/auth/sign-in', { method: 'POST', body: body })
    .then(function (data) {
      if (data.requires2FA) {
        $('field-2fa').classList.remove('hidden');
        errEl.textContent = data.error || 'Akun dilindungi 2FA. Masukkan password 2FA.';
        errEl.classList.remove('hidden');
        var pw = $('password-2fa'); if (pw) pw.focus();
        return;
      }
      successEl.textContent = 'Login berhasil! Drive siap digunakan.';
      successEl.classList.remove('hidden');
      setTimeout(function () {
        state.setupNeeded = false;
        state.loggedIn = true;
        showDashboard();
        loadFiles();
        checkConnection();
      }, 1000);
    })
    .catch(function (err) {
      errEl.textContent = err.data && err.data.error ? err.data.error : 'Verifikasi gagal';
      errEl.classList.remove('hidden');
    })
    .finally(function () {
      span.textContent = 'Masuk';
      spin.classList.add('hidden');
    });
}

/* ─────────────────────────────────────────────────────────────
   FILES
   ───────────────────────────────────────────────────────────── */
function loadFiles() {
  $('files-loading').classList.remove('hidden');
  api('/api/files')
    .then(function (data) {
      // GET /api/files responds with a bare JSON array (server.js: res.json(
      // groupSplitFiles(...))), never an envelope. Reading data.files here gave
      // undefined on every single call, so state.files fell through to [] and
      // the drive rendered its empty state no matter how many rows the
      // database held — which is why a completed sync and a finished upload
      // both looked like they had done nothing. The array branch is the live
      // one; the envelope branch is kept only so a future wrapped response
      // does not silently blank the grid again.
      state.files = Array.isArray(data) ? data : (data && data.files) || [];
      applyFilters();
      updateStorageInfo();
    })
    .catch(function (err) {
      if (err.message !== 'Unauthorized') showToast('Gagal memuat berkas: ' + (err.message || ''));
    })
    .finally(function () {
      $('files-loading').classList.add('hidden');
    });
}

function applyFilters() {
  var files = state.files.slice();

  // Category filter
  if (state.activeCategory === 'logs') {
    showLogsView();
    return;
  }
  // A file refresh can land while the operator is looking at another panel
  // (the upload flow reloads the list on completion). Re-rendering the grid
  // then would yank the panel away, so leave whichever one is showing alone.
  if (state.activeCategory === 'tempmail') {
    showTempmailView();
    return;
  }
  if (state.activeCategory !== 'all') {
    files = files.filter(function (f) { return getFileCategory(f) === state.activeCategory; });
  }

  // Search
  if (state.searchQuery) {
    var q = state.searchQuery.toLowerCase();
    files = files.filter(function (f) { return (f.filename || f.name || '').toLowerCase().indexOf(q) >= 0; });
  }

  // Size filter
  if (state.sizeFilter !== 'all') {
    files = files.filter(function (f) {
      var sz = f.total_size || f.size || 0;
      if (state.sizeFilter === 'small') return sz < 10 * 1024 * 1024;
      if (state.sizeFilter === 'medium') return sz >= 10 * 1024 * 1024 && sz < 100 * 1024 * 1024;
      if (state.sizeFilter === 'large') return sz >= 100 * 1024 * 1024;
      return true;
    });
  }

  // Extension filter
  if (state.extensionFilter) {
    var exts = state.extensionFilter.split(',').map(function (s) { return s.trim().toLowerCase().replace(/^\./, ''); }).filter(Boolean);
    if (exts.length) {
      files = files.filter(function (f) { return exts.indexOf(getFileExt(f.filename || f.name)) >= 0; });
    }
  }

  // Sort
  switch (state.sortBy) {
    case 'newest': files.sort(function (a, b) { return new Date(b.uploaded_at || 0) - new Date(a.uploaded_at || 0); }); break;
    case 'oldest': files.sort(function (a, b) { return new Date(a.uploaded_at || 0) - new Date(b.uploaded_at || 0); }); break;
    case 'largest': files.sort(function (a, b) { return (b.total_size || 0) - (a.total_size || 0); }); break;
    case 'smallest': files.sort(function (a, b) { return (a.total_size || 0) - (b.total_size || 0); }); break;
    case 'name-asc': files.sort(function (a, b) { return (a.filename || '').localeCompare(b.filename || ''); }); break;
    case 'name-desc': files.sort(function (a, b) { return (b.filename || '').localeCompare(a.filename || ''); }); break;
  }

  state.filteredFiles = files;
  renderFiles();
}

function renderFiles() {
  var container = $('files-container');
  var empty = $('empty-state');
  var logsContainer = $('logs-container');
  var tempmailContainer = $('tempmail-container');

  logsContainer.classList.add('hidden');
  if (tempmailContainer) tempmailContainer.classList.add('hidden');
  container.classList.remove('hidden');
  container.innerHTML = '';
  container.className = state.layout === 'grid'
    // Dua kolom di HP terkecil, lalu bertambah seiring lebar layar. Batasnya
    // ditulis eksplisit supaya tidak bergantung pada urutan kelas Tailwind yang
    // kebetulan dihasilkan — itu yang dulu membuat kolom desktop muncul di HP.
    ? 'grid gap-2 sm:gap-3 grid-cols-2 min-[430px]:grid-cols-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6'
    : 'flex flex-col gap-1';

  var countEl = $('file-count-badge');
  if (countEl) {
    var shown = state.filteredFiles.length;
    var total = state.files.length;
    countEl.textContent = shown === total
      ? shown + ' berkas'
      : shown + ' dari ' + total + ' berkas';
  }

  if (state.filteredFiles.length === 0) {
    empty.classList.remove('hidden');
    container.classList.add('hidden');
    return;
  }
  empty.classList.add('hidden');

  if (state.layout === 'grid') renderGrid(container);
  else renderList(container);
}

function renderGrid(container) {
  state.filteredFiles.forEach(function (file) {
    var card = document.createElement('div');
    card.className = 'card p-3 flex flex-col gap-2 group relative cursor-pointer hover:shadow-md transition';
    card.dataset.fileKey = file.file_key;

    var isSelected = state.selectedIds.has(file.file_key);
    if (isSelected) {
      card.style.borderColor = 'rgb(var(--c-accent))';
      card.style.boxShadow = '0 0 0 3px rgb(var(--c-accent) / 0.18)';
    }

    var cat = getFileCategory(file);
    var ext = getFileExt(file.filename || file.name || '');
    var iconColor = cat === 'image' ? '#1e8e3e' : cat === 'video' ? '#d93025' : cat === 'audio' ? '#a142f4' : getExtColor(ext);
    var iconHtml = thumbCell(
      file, cat, ext,
      'aspect-square rounded-control overflow-hidden bg-paper border border-cloud flex items-center justify-center',
      iconColor
    );

    // Checkbox (bulk mode)
    var checkboxHtml = state.isBulkMode ?
      '<div class="absolute top-2 left-2 z-10">' +
      '<div class="w-5 h-5 rounded flex items-center justify-center transition" style="background:' + (isSelected ? 'rgb(var(--c-accent))' : 'rgb(var(--c-surface))') + ';border:2px solid ' + (isSelected ? 'rgb(var(--c-accent))' : 'rgb(var(--c-border))') + '">' +
      (isSelected ? '<svg viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="3" class="w-3 h-3"><polyline points="20 6 9 17 4 12"/></svg>' : '') +
      '</div></div>' : '';

    var name = escapeHtml(file.filename || file.name || 'Unnamed');
    var size = formatBytes(file.total_size || file.size);
    var date = formatDate(file.uploaded_at);

    card.innerHTML =
      checkboxHtml +
      iconHtml +
      '<div class="min-w-0">' +
      '<p class="text-xs font-medium truncate" title="' + name + '">' + name + '</p>' +
      '</div>' +
      '<div class="flex items-center justify-between text-[10px] text-textGray font-mono">' +
      '<span>' + size + '</span>' +
      '<span>' + date + '</span>' +
      '</div>';

    card.addEventListener('click', function (e) {
      e.preventDefault();
      if (state.isBulkMode) toggleSelect(file.file_key);
      else openLightboxByFile(file);
    });
    card.addEventListener('contextmenu', function (e) {
      e.preventDefault();
      showContextMenu(e, file);
    });

    container.appendChild(card);
  });
}

function renderList(container) {
  state.filteredFiles.forEach(function (file) {
    var row = document.createElement('div');
    row.className = 'flex items-center gap-3 p-2.5 rounded-control hover:bg-paper cursor-pointer transition group';
    row.dataset.fileKey = file.file_key;

    var isSelected = state.selectedIds.has(file.file_key);
    if (isSelected) {
      row.style.background = 'rgb(var(--c-accent) / 0.08)';
      row.style.borderLeft = '2px solid rgb(var(--c-accent))';
    }

    var cat = getFileCategory(file);
    var ext = getFileExt(file.filename || file.name || '');
    var iconColor = cat === 'image' ? '#1e8e3e' : cat === 'video' ? '#d93025' : cat === 'audio' ? '#a142f4' : getExtColor(ext);

    var checkboxHtml = state.isBulkMode ?
      '<div class="w-5 h-5 rounded flex items-center justify-center shrink-0 transition" style="background:' + (isSelected ? 'rgb(var(--c-accent))' : 'transparent') + ';border:2px solid ' + (isSelected ? 'rgb(var(--c-accent))' : 'rgb(var(--c-border))') + '">' +
      (isSelected ? '<svg viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="3" class="w-3 h-3"><polyline points="20 6 9 17 4 12"/></svg>' : '') +
      '</div>' : '';

    var iconHtml = thumbCell(
      file, cat, ext,
      'w-10 h-10 rounded-control overflow-hidden bg-paper border border-cloud shrink-0 flex items-center justify-center',
      iconColor
    );

    var name = escapeHtml(file.filename || file.name || 'Unnamed');
    var size = formatBytes(file.total_size || file.size);
    var date = formatDate(file.uploaded_at);

    row.innerHTML =
      checkboxHtml +
      iconHtml +
      '<div class="flex-1 min-w-0">' +
      '<p class="text-sm font-medium truncate" title="' + name + '">' + name + '</p>' +
      '<p class="text-[10px] text-textGray font-mono">' + date + '</p>' +
      '</div>' +
      '<span class="text-xs text-textGray font-mono shrink-0">' + size + '</span>' +
      '<button class="btn-icon opacity-0 group-hover:opacity-100 transition shrink-0" style="width:2rem;height:2rem">' +
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="w-4 h-4"><circle cx="12" cy="12" r="1"/><circle cx="12" cy="5" r="1"/><circle cx="12" cy="19" r="1"/></svg>' +
      '</button>';

    row.addEventListener('click', function (e) {
      e.preventDefault();
      if (state.isBulkMode) toggleSelect(file.file_key);
      else openLightboxByFile(file);
    });
    row.addEventListener('contextmenu', function (e) {
      e.preventDefault();
      showContextMenu(e, file);
    });

    container.appendChild(row);
  });
}

function getFileIconSvg(cat, ext) {
  var size = 'w-8 h-8';
  switch (cat) {
    case 'image':
      return '<svg class="' + size + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>';
    case 'video':
      return '<svg class="' + size + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2"/></svg>';
    case 'audio':
      return '<svg class="' + size + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>';
    case 'folder':
      return '<svg class="' + size + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>';
    default:
      return '<svg class="' + size + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>';
  }
}

/* ─────────────────────────────────────────────────────────────
   BULK SELECTION
   ───────────────────────────────────────────────────────────── */
function toggleSelect(fileKey) {
  if (state.selectedIds.has(fileKey)) state.selectedIds.delete(fileKey);
  else state.selectedIds.add(fileKey);
  updateBulkBar();
  applyFilters();
}

function toggleBulkMode() {
  state.isBulkMode = !state.isBulkMode;
  if (!state.isBulkMode) state.selectedIds.clear();
  updateBulkBar();
  applyFilters();
}

function updateBulkBar() {
  var bar = $('bulk-bar');
  if (state.isBulkMode && state.selectedIds.size > 0) {
    bar.classList.remove('hidden');
    $('bulk-count').textContent = state.selectedIds.size;
  } else {
    bar.classList.add('hidden');
  }
}

function selectAll() {
  state.filteredFiles.forEach(function (f) { state.selectedIds.add(f.file_key); });
  updateBulkBar();
  applyFilters();
}

function bulkDownload() {
  state.selectedIds.forEach(function (key) {
    var link = document.createElement('a');
    link.href = '/api/download/' + key;
    link.download = '';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  });
}

function bulkDelete() {
  var count = state.selectedIds.size;
  showConfirm('Hapus ' + count + ' berkas terpilih? Tindakan ini tidak dapat dibatalkan.', function () {
    var keys = Array.from(state.selectedIds);
    Promise.all(keys.map(function (key) {
      return api('/api/files/' + key, { method: 'DELETE' });
    })).then(function () {
      showToast(count + ' berkas dihapus');
      state.selectedIds.clear();
      state.isBulkMode = false;
      updateBulkBar();
      loadFiles();
    }).catch(function () {
      showToast('Gagal menghapus beberapa berkas');
    });
  }, 'Hapus Berkas');
}

/* ─────────────────────────────────────────────────────────────
   CONTEXT MENU
   ───────────────────────────────────────────────────────────── */
function showContextMenu(e, file) {
  state.contextFile = file;
  var menu = $('ctx-menu');
  menu.classList.remove('hidden');
  menu.style.left = Math.min(e.clientX, window.innerWidth - 200) + 'px';
  menu.style.top = Math.min(e.clientY, window.innerHeight - 150) + 'px';
}

function hideContextMenu() {
  var menu = $('ctx-menu');
  if (menu) menu.classList.add('hidden');
  state.contextFile = null;
}

/* ─────────────────────────────────────────────────────────────
   PREVIEW VIEWER
   ----------------------------------------------------------------
   Two things were wrong with the version this replaces, and both show up as
   "unstable" rather than as an error.

   1. No load generation. Every surface installed an onload/onerror or started a
      fetch and then trusted it. Holding → through twenty photos left twenty
      in-flight loads racing, and whichever finished last won — so the pane
      routinely ended up showing a file you had already navigated past, or a
      spinner that never cleared because the *stale* load was the one that
      hid it. pvToken makes every continuation check that it is still the
      current one before touching the DOM.

   2. It decided what it could show, then acted as though it were right. `mkv`
      and `avi` are category video, so they went to a <video> element that no
      browser can decode, and the result was a black rectangle with controls.
      Now every media surface has an error path that falls through to the
      download plate with a reason, so a failure explains itself.

   Navigation covers the whole filtered list, the way Drive does — the old list
   was pre-filtered to image/video/audio, so arrowing through a mixed folder
   silently skipped everything else.
   ───────────────────────────────────────────────────────────── */

// Text-ish extensions. The server declares all of these text/plain and the
// bounded /api/text route reads only the head of the file, so a log is safe to
// open; PV_TEXT_MAX_BYTES is the second guard, because the *original* still has
// to come down from Telegram in full before the head can be read.
var PV_TEXT_EXTS = [
  'txt','log','md','markdown','csv','tsv','json','xml','yml','yaml','toml',
  'ini','cfg','conf','env','srt','vtt','html','htm','xhtml','css','js','mjs',
  'cjs','jsx','ts','tsx','py','rb','php','java','c','h','cpp','hpp','cs','go',
  'rs','kt','swift','sh','bat','ps1','sql','dockerfile','gitignore','properties'
];
var PV_TEXT_MAX_BYTES = 5 * 1024 * 1024;
// Below this the full image arrives about as fast as its thumbnail, and a small
// original would be shown larger as a placeholder than it is as itself.
var PV_BLUR_MIN_BYTES = 512 * 1024;

// Bumped on every load. A continuation whose token no longer matches has been
// superseded and must not touch the DOM.
var pvToken = 0;
var pvAbort = null;
var pvZoom = 1;
var PV_ZOOM_STEPS = [1, 1.25, 1.5, 2, 3, 4];

var PV_SURFACES = ['lb-img', 'lb-video', 'lb-pdf', 'lb-text-wrap', 'lb-audio-container', 'lb-nopreview'];

function previewKind(file) {
  var ext = getFileExt(file.filename || file.name || '');
  var cat = getFileCategory(file);
  if (ext === 'pdf') return 'pdf';
  if (cat === 'image') return 'image';
  if (cat === 'video') return 'video';
  if (cat === 'audio') return 'audio';
  if (PV_TEXT_EXTS.indexOf(ext) >= 0) {
    return (Number(file.total_size || file.size) || 0) > PV_TEXT_MAX_BYTES ? 'none' : 'text';
  }
  return 'none';
}

// Shows exactly one surface and hides the rest, so no combination of fast
// navigation can leave two stacked on top of each other.
function showPreviewSurface(id) {
  PV_SURFACES.forEach(function (s) {
    var el = $(s);
    if (el) el.classList.toggle('hidden', s !== id);
  });
  $('lb-loading').classList.toggle('hidden', !!id);
  $('lb-zoom').classList.toggle('show', id === 'lb-img');
}

// The download plate, used both for "we cannot render this type" and for "we
// tried and the browser refused the codec".
function showPreviewFallback(file, title, sub) {
  var ext = getFileExt(file.filename || file.name || '');
  var cat = getFileCategory(file);
  $('lb-empty-icon').innerHTML = getFileIconSvg(cat, ext);
  $('lb-empty-title').textContent = title || 'Pratinjau tidak tersedia';
  $('lb-empty-sub').textContent = sub || 'Unduh berkas untuk membukanya secara lokal';
  $('lb-empty-download').href = '/api/download/' + file.file_key;
  showPreviewSurface('lb-nopreview');
}

/* ZOOM — the image is given an explicit pixel width and the stage scrolls.
   A transform + drag handler was the alternative and it is worse: the scroll
   position is not preserved, the pointer can escape the element mid-drag, and
   the transformed box does not contribute to the scrollable area, so the top of
   a zoomed portrait becomes unreachable. */
function pvApplyZoom() {
  var img = $('lb-img');
  var label = $('lb-zoom-level');
  if (label) label.textContent = Math.round(pvZoom * 100) + '%';
  if (!img || img.classList.contains('hidden')) return;

  if (pvZoom <= 1) {
    img.classList.remove('zoomed');
    img.style.width = '';
    img.style.height = '';
    return;
  }

  var stage = $('lb-stage');
  var pad = 32;
  var availW = Math.max(stage.clientWidth - pad, 80);
  var availH = Math.max(stage.clientHeight - pad, 80);
  var nw = img.naturalWidth || availW;
  var nh = img.naturalHeight || availH;
  // The zoom is relative to the *fitted* size, not to the file's own pixels, so
  // 100% means "as large as it was on screen" for a huge photo and for a small
  // one alike. Never scale a small image up past its own resolution at 100%.
  var fit = Math.min(availW / nw, availH / nh, 1);
  img.classList.add('zoomed');
  img.style.width = Math.round(nw * fit * pvZoom) + 'px';
  img.style.height = 'auto';
}

function pvSetZoom(z) {
  pvZoom = Math.max(PV_ZOOM_STEPS[0], Math.min(PV_ZOOM_STEPS[PV_ZOOM_STEPS.length - 1], z));
  pvApplyZoom();
}

function pvZoomStep(dir) {
  var i = PV_ZOOM_STEPS.indexOf(pvZoom);
  if (i < 0) {
    // Landed on a value not in the ladder (a toggle-click): snap to the nearest.
    i = 0;
    for (var k = 0; k < PV_ZOOM_STEPS.length; k++) {
      if (Math.abs(PV_ZOOM_STEPS[k] - pvZoom) < Math.abs(PV_ZOOM_STEPS[i] - pvZoom)) i = k;
    }
  }
  pvSetZoom(PV_ZOOM_STEPS[Math.max(0, Math.min(PV_ZOOM_STEPS.length - 1, i + dir))]);
}

/* ENTRY POINTS */

// Every file opens the viewer now. Previously an unsupported type triggered a
// download the moment you clicked its card, which is a surprising amount of
// traffic for a mis-click; the plate offers the download instead of performing
// it, and keeps the arrow keys working through the rest of the list.
function openLightboxByFile(file) {
  openLightbox(file);
}

function openLightbox(file) {
  var lb = $('lightbox');
  lb.classList.remove('hidden');
  // The opacity transition needs the element to be laid out at opacity 0 for one
  // frame before .active lands, or it snaps in without the fade.
  requestAnimationFrame(function () { lb.classList.add('active'); });
  document.body.style.overflow = 'hidden';

  state.lightboxList = (state.filteredFiles || []).slice();
  state.lightboxIndex = state.lightboxList.findIndex(function (f) { return f.file_key === file.file_key; });
  if (state.lightboxIndex < 0) {
    state.lightboxList = [file];
    state.lightboxIndex = 0;
  }

  var many = state.lightboxList.length > 1;
  $('lb-prev').classList.toggle('hidden', !many);
  $('lb-next').classList.toggle('hidden', !many);

  loadLightboxContent(state.lightboxList[state.lightboxIndex]);
}

function loadLightboxContent(file) {
  if (!file) return;

  // Invalidate everything still in flight from the previous file.
  var token = ++pvToken;
  if (pvAbort) { try { pvAbort.abort(); } catch (e) {} pvAbort = null; }
  pvResetMedia();
  pvZoom = 1;

  var name = file.filename || file.name || 'Pratinjau';
  var size = formatBytes(file.total_size || file.size);
  var cat = getFileCategory(file);
  var ext = getFileExt(name);
  var kind = previewKind(file);

  $('lb-title-text').textContent = name;
  $('lb-title-text').title = name;
  $('lb-title-icon').innerHTML = getFileIconSvg(cat, ext);
  $('lb-meta').textContent = size + (ext ? ' · ' + ext.toUpperCase() : '');
  $('lb-counter').textContent = state.lightboxList.length > 1
    ? (state.lightboxIndex + 1) + ' / ' + state.lightboxList.length
    : '';
  $('lb-download').href = '/api/download/' + file.file_key;
  $('lb-download-original').href = '/api/download-original/' + file.file_key;
  $('lb-newtab').href = '/api/preview/' + file.file_key;

  showPreviewSurface(null);
  $('lb-loading-text').textContent = 'Memuat…';

  if (kind === 'image') {
    var img = $('lb-img');
    var bytes = Number(file.total_size || file.size) || 0;

    // Stand the cached thumbnail in, blurred, while the full image downloads —
    // the same progressive reveal Drive does, and the reason opening a photo
    // feels immediate instead of showing a spinner over an empty stage. The
    // thumbnail shares the original's aspect ratio, so .pv-blur sizing it to the
    // stage lands on the same box the finished image will occupy: no jump.
    if (bytes >= PV_BLUR_MIN_BYTES) {
      // A file with no thumbnail 404s here, which is not worth reporting — the
      // full image is still on its way and owns the error path.
      img.onload = function () {
        if (token !== pvToken || !img.classList.contains('pv-blur')) return;
        showPreviewSurface('lb-img');
      };
      img.onerror = null;
      img.classList.add('pv-blur');
      img.src = '/api/thumb/' + encodeURIComponent(file.file_key);
    }

    // Decoded off to the side, then handed over: assigning a src the browser has
    // already loaded paints from cache in the same frame, so the swap from blur
    // to sharp never flashes an empty element.
    var full = new Image();
    full.onload = function () {
      if (token !== pvToken) return;
      img.onload = null;
      img.onerror = null;
      img.classList.remove('pv-blur');
      img.src = full.src;
      showPreviewSurface('lb-img');
      pvApplyZoom();
    };
    full.onerror = function () {
      if (token !== pvToken) return;
      img.classList.remove('pv-blur');
      showPreviewFallback(file, 'Gambar tidak dapat ditampilkan',
        'Berkas mungkin rusak atau formatnya tidak didukung browser');
    };
    full.src = '/api/preview/' + file.file_key;
    return;
  }

  if (kind === 'video' || kind === 'audio') {
    var isVideo = kind === 'video';
    var el = $(isVideo ? 'lb-video' : 'lb-audio');
    // A container that cannot be decoded (mkv, avi, wmv) reaches `error` rather
    // than throwing, and it is the only reliable signal — there is no list of
    // codecs a given browser will accept that stays true for long.
    el.onerror = function () {
      if (token !== pvToken) return;
      showPreviewFallback(file,
        (isVideo ? 'Video' : 'Audio') + ' ini tidak didukung browser',
        'Kontainer ' + (ext ? ext.toUpperCase() + ' ' : '') + 'tidak dapat diputar langsung. Unduh untuk memutarnya di pemutar lokal.');
    };
    el.onloadeddata = function () { if (token === pvToken) $('lb-loading').classList.add('hidden'); };
    if (isVideo) {
      showPreviewSurface('lb-video');
    } else {
      $('lb-audio-title').textContent = name;
      $('lb-audio-size').textContent = size;
      showPreviewSurface('lb-audio-container');
      var disc = $('lb-audio-disc');
      el.onplay = function () { disc.classList.add('playing'); };
      el.onpause = function () { disc.classList.remove('playing'); };
    }
    el.src = '/api/stream/' + file.file_key;
    el.load();
    return;
  }

  if (kind === 'pdf') {
    var frame = $('lb-pdf');
    // The frame reports load for an error page just as happily as for a PDF, so
    // there is nothing to verify here — the browser's own viewer takes over.
    frame.onload = function () { if (token === pvToken) $('lb-loading').classList.add('hidden'); };
    frame.src = '/api/preview/' + file.file_key;
    showPreviewSurface('lb-pdf');
    return;
  }

  if (kind === 'text') {
    $('lb-loading-text').textContent = 'Mengunduh berkas…';
    pvAbort = typeof AbortController === 'function' ? new AbortController() : null;
    fetch('/api/text/' + file.file_key, pvAbort ? { signal: pvAbort.signal } : undefined)
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      })
      .then(function (data) {
        if (token !== pvToken) return;
        $('lb-text').textContent = data.text || '';
        var note = $('lb-text-note');
        if (data.truncated) {
          note.textContent = 'Menampilkan ' + formatBytes(data.bytes) + ' pertama dari ' +
            formatBytes(data.totalBytes) + '. Unduh berkas untuk melihat seluruhnya.';
          note.classList.remove('hidden');
        } else {
          note.classList.add('hidden');
        }
        showPreviewSurface('lb-text-wrap');
      })
      .catch(function (err) {
        if (token !== pvToken || (err && err.name === 'AbortError')) return;
        showPreviewFallback(file, 'Gagal memuat isi berkas',
          err && err.message ? err.message : 'Coba unduh berkasnya');
      });
    return;
  }

  showPreviewFallback(file, 'Pratinjau tidak tersedia',
    ext ? 'Berkas ' + ext.toUpperCase() + ' tidak dapat ditampilkan di browser' : null);
}

// Detaching src (rather than only pausing) is what stops a half-buffered video
// from carrying on downloading in the background after you have moved on.
function pvResetMedia() {
  ['lb-video', 'lb-audio'].forEach(function (id) {
    var el = $(id);
    if (!el) return;
    el.onerror = el.onloadeddata = el.onplay = el.onpause = null;
    try { el.pause(); } catch (e) {}
    el.removeAttribute('src');
    try { el.load(); } catch (e) {}
  });
  var img = $('lb-img');
  if (img) {
    img.onload = img.onerror = null;
    img.removeAttribute('src');
    img.style.width = '';
    img.style.height = '';
    img.classList.remove('zoomed');
    img.classList.remove('pv-blur');
  }
  var frame = $('lb-pdf');
  if (frame) { frame.onload = null; frame.removeAttribute('src'); }
  var disc = $('lb-audio-disc');
  if (disc) disc.classList.remove('playing');
  var stage = $('lb-stage');
  if (stage) { stage.scrollTop = 0; stage.scrollLeft = 0; }
}

function closeLightbox() {
  var lb = $('lightbox');
  pvToken++;                 // nothing still loading may write to the DOM
  if (pvAbort) { try { pvAbort.abort(); } catch (e) {} pvAbort = null; }
  lb.classList.remove('active');
  document.body.style.overflow = '';
  setTimeout(function () {
    lb.classList.add('hidden');
    pvResetMedia();
    showPreviewSurface(null);
  }, 200);
}

function lightboxStep(dir) {
  var n = state.lightboxList.length;
  if (n === 0) return;
  state.lightboxIndex = (state.lightboxIndex + dir + n) % n;
  loadLightboxContent(state.lightboxList[state.lightboxIndex]);
}

function lightboxNext() { lightboxStep(1); }
function lightboxPrev() { lightboxStep(-1); }

function lightboxDelete() {
  if (state.lightboxList.length === 0) return;
  var file = state.lightboxList[state.lightboxIndex];
  showConfirm('Hapus "' + (file.filename || file.name || 'file') + '"?', function () {
    api('/api/files/' + file.file_key, { method: 'DELETE' })
      .then(function () {
        showToast('Berkas dihapus', 'success');
        // Stay in the viewer and move to the neighbour, which is what you want
        // when clearing several files in a row. Closing on the last one.
        state.lightboxList.splice(state.lightboxIndex, 1);
        if (state.lightboxList.length === 0) {
          closeLightbox();
        } else {
          if (state.lightboxIndex >= state.lightboxList.length) state.lightboxIndex = 0;
          var many = state.lightboxList.length > 1;
          $('lb-prev').classList.toggle('hidden', !many);
          $('lb-next').classList.toggle('hidden', !many);
          loadLightboxContent(state.lightboxList[state.lightboxIndex]);
        }
        loadFiles();
      })
      .catch(function (err) {
        showToast('Gagal menghapus berkas' + (err && err.message ? ': ' + err.message : ''), 'error');
      });
  }, 'Hapus Berkas');
}

/* ─────────────────────────────────────────────────────────────
   UPLOAD
   ───────────────────────────────────────────────────────────── */
function handleFiles(fileList) {
  var files = Array.prototype.slice.call(fileList);
  if (files.length === 0) return;

  files.forEach(function (file) {
    var upload = {
      id: 'up-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8),
      name: file.webkitRelativePath || file.name,
      size: file.size,
      progress: 0,
      status: 'pending',
      file: file,
    };
    state.uploads.push(upload);
  });

  showUploadPanel();
  renderUploadItems();
  processUploadQueue();
}

/* Panel unggahan: muncul dan menghilang dengan geser+redup, bukan berkedip.

   Dua hal yang dulu salah:
   1. `hidden` dipakai untuk menyembunyikan, jadi elemennya lenyap seketika —
      itulah kedipan yang terlihat setiap kali daftar unggahan disegarkan.
   2. Tidak ada yang menutupnya setelah semua berkas selesai, sehingga panel
      kosong menetap di layar sampai ditutup manual.

   Sekarang visibilitasnya lewat kelas `up-hidden` (opacity + transform), dan
   setelah antrean kosong panel menutup sendiri dengan jeda yang cukup untuk
   membaca "Selesai". */
var uploadPanelTimer = null;

function showUploadPanel() {
  var panel = $('upload-panel');
  if (!panel) return;
  if (uploadPanelTimer) { clearTimeout(uploadPanelTimer); uploadPanelTimer = null; }
  panel.classList.remove('hidden');
  // Satu frame sebelum transisi dimulai, supaya browser sempat menghitung
  // posisi awal; tanpa ini kelasnya dilepas dan transisinya tidak jalan.
  requestAnimationFrame(function () {
    requestAnimationFrame(function () { panel.classList.remove('up-hidden'); });
  });
}

function hideUploadPanel(segera) {
  var panel = $('upload-panel');
  if (!panel) return;
  panel.classList.add('up-hidden');
  if (uploadPanelTimer) clearTimeout(uploadPanelTimer);
  if (segera === true) {
    panel.classList.add('hidden');
    return;
  }
  // `hidden` baru dipasang setelah transisinya selesai, jadi elemennya benar
  // benar tidak ikut menerima klik selama animasi.
  uploadPanelTimer = setTimeout(function () {
    panel.classList.add('hidden');
    uploadPanelTimer = null;
  }, 240);
}

// Dipanggil setelah semua unggahan selesai: beri jeda singkat supaya status
// terakhir sempat terbaca, lalu tutup.
function jadwalkanTutupPanelUnggahan() {
  if (uploadPanelTimer) clearTimeout(uploadPanelTimer);
  uploadPanelTimer = setTimeout(function () {
    uploadPanelTimer = null;
    hideUploadPanel();
  }, 2600);
}

/* Menyegarkan daftar unggahan tanpa membangun ulang seluruh isinya.

   Versi lama mengosongkan `container.innerHTML` lalu membuat semuanya lagi.
   Setiap panggilan berarti setiap baris hilang lalu muncul kembali dalam satu
   frame — dan karena fungsi ini dipanggil tiap kali progres berubah, panelnya
   terlihat berkedip sepanjang unggahan. Sekarang barisnya dipakai ulang kalau
   sudah ada, dan hanya yang benar-benar berubah yang ditulis. */
function renderUploadItems() {
  var container = $('upload-items');
  if (!container) return;

  var active = state.uploads.filter(function (u) { return u.status === 'pending' || u.status === 'uploading'; });
  var titleEl = $('upload-panel-title');
  if (titleEl) titleEl.textContent = 'Unggah: ' + (active.length || state.uploads.length) + ' file';

  var pingEl = $('upload-panel-ping');
  if (pingEl) pingEl.classList.toggle('up-dot-idle', active.length > 0);

  if (state.uploads.length === 0) {
    if (!container.querySelector('.up-empty')) {
      container.innerHTML = '<p class="up-empty text-center text-textGray text-xs py-4">Tidak ada unggahan aktif</p>';
    }
    return;
  }

  var kosong = container.querySelector('.up-empty');
  if (kosong) kosong.remove();

  var urut = state.uploads.slice().reverse();

  /* Baris yang tidak lagi ada di daftar dibuang, sisanya dipakai ulang. */
  var idDiinginkan = {};
  urut.forEach(function (u) { idDiinginkan['up-' + u.id] = true; });
  Array.prototype.slice.call(container.children).forEach(function (child) {
    if (child.id && !idDiinginkan[child.id]) child.remove();
  });

  urut.forEach(function (up) {
    var div = $('up-' + up.id);
    if (!div) {
      div = document.createElement('div');
      div.className = 'up-item';
      div.id = 'up-' + up.id;
      div.innerHTML =
        '<div class="up-row">' +
        '<span class="up-name"></span>' +
        '<span class="up-status"></span>' +
        '</div>' +
        '<div class="up-bar"><div class="up-fill"></div></div>';
      container.appendChild(div);
    }
    updateUploadItem(up);
  });
}

function updateUploadItem(up) {
  var div = $('up-' + up.id);
  if (!div) return;
  var statusText = up.status === 'done' ? 'Selesai' : up.status === 'error' ? (up.error ? 'Gagal: ' + up.error : 'Gagal') : up.status === 'uploading' ? formatBytes(up.progress * up.size) + ' / ' + formatBytes(up.size) : 'Menunggu...';
  var fillColor = up.status === 'error' ? 'rgb(var(--c-danger))' : up.status === 'done' ? 'rgb(var(--c-success))' : 'rgb(var(--c-accent))';

  var nameEl = div.querySelector('.up-name');
  if (nameEl && nameEl.textContent !== up.name) {
    nameEl.textContent = up.name;
    nameEl.title = up.name;
  }

  // Hanya tulis bila nilainya benar-benar berubah: menulis ulang textContent
  // dengan isi yang sama tetap memicu kerja render dan ikut menyumbang kedipan.
  var statusEl = div.querySelector('.up-status');
  if (statusEl && statusEl.textContent !== statusText) statusEl.textContent = statusText;

  var fillEl = div.querySelector('.up-fill');
  if (fillEl) {
    var lebar = (up.progress * 100) + '%';
    if (fillEl.style.width !== lebar) fillEl.style.width = lebar;
    if (fillEl.style.backgroundColor !== fillColor) fillEl.style.backgroundColor = fillColor;
  }
}

var uploadInProgress = false;
function processUploadQueue() {
  if (uploadInProgress) return;
  var next = state.uploads.find(function (u) { return u.status === 'pending'; });
  if (!next) {
    uploadInProgress = false;
    // Semua berkas sudah diproses: segarkan daftar, lalu biarkan panel menutup
    // sendiri sebentar kemudian.
    var masihAdaYangGagal = state.uploads.some(function (u) { return u.status === 'error'; });
    loadFiles();
    if (!masihAdaYangGagal) jadwalkanTutupPanelUnggahan();
    return;
  }

  uploadInProgress = true;
  next.status = 'uploading';
  updateUploadItem(next);

  var formData = new FormData();
  formData.append('file', next.file, next.name);

  var xhr = new XMLHttpRequest();
  xhr.upload.addEventListener('progress', function (e) {
    if (e.lengthComputable) {
      next.progress = e.loaded / e.total;
      updateUploadItem(next);
    }
  });

  xhr.addEventListener('load', function () {
    if (xhr.status >= 200 && xhr.status < 300) {
      next.status = 'done';
      next.progress = 1;
    } else {
      next.status = 'error';
      var reason = '';
      try { reason = (JSON.parse(xhr.responseText) || {}).error || ''; } catch (e) {}
      next.error = reason;
      showToast('Gagal mengunggah ' + next.name + (reason ? ': ' + reason : ''), 'error');
    }
    updateUploadItem(next);
    uploadInProgress = false;
    setTimeout(processUploadQueue, 100);
  });

  xhr.addEventListener('error', function () {
    next.status = 'error';
    updateUploadItem(next);
    uploadInProgress = false;
    setTimeout(processUploadQueue, 100);
  });

  xhr.open('POST', '/api/upload');
  xhr.send(formData);
}

/* ─────────────────────────────────────────────────────────────
   SYNC
   ───────────────────────────────────────────────────────────── */
function handleSync() {
  var btn = $('btn-sync');
  var icon = btn.querySelector('.sync-icon');
  var text = btn.querySelector('.sync-text');
  /* Ikon sync tidak lagi diputar: animasi batang dipakai supaya seluruh
     aplikasi memakai satu bahasa gerak. Ikonnya disembunyikan, loadernya
     ditempel di sebelah teks.

     Versi netral (loader-mono) yang dipakai di sini: tombol Sync sudah berlatar
     hijau, dan lima rona di atasnya hanya akan terbaca sebagai bercak. */
  if (icon) icon.classList.add('hidden');
  var loader = btn.querySelector('.sync-loader');
  if (!loader) {
    loader = document.createElement('div');
    loader.className = 'loader loader-sm loader-5 loader-mono sync-loader';
    loader.innerHTML = '<span class="bar"></span><span class="bar"></span><span class="bar"></span><span class="bar"></span><span class="bar"></span>';
    btn.insertBefore(loader, text);
  }
  loader.classList.remove('hidden');
  text.textContent = 'Syncing...';

  function selesaiMuat() {
    if (icon) icon.classList.remove('hidden');
    if (loader) loader.classList.add('hidden');
    text.textContent = 'Sync';
  }

  api('/api/sync', { method: 'POST' })
    .then(function (data) {
      showToast(data.message || 'Sync dimulai');
      // Poll for sync completion
      var pollCount = 0;
      var pollInterval = setInterval(function () {
        api('/api/sync-status')
          .then(function (s) {
            if (!s.syncing || pollCount > 60) {
              clearInterval(pollInterval);
              selesaiMuat();
              loadFiles();
              if (s.syncing) { showToast('Sync masih berjalan...'); return; }
              // Report the tally. A silent finish was indistinguishable from a
              // sync that read nothing, which is how a run that had aborted
              // half-way still looked like a success.
              var p = s.progress || {};
              if (p.aborted) {
                showToast('Sync berhenti: ' + p.aborted, 'error');
              } else if (typeof p.scanned === 'number') {
                showToast(
                  p.added + ' berkas baru, ' + p.skipped + ' sudah ada' +
                  (p.errors ? ', ' + p.errors + ' gagal' : '') +
                  ' (' + p.scanned + ' pesan diperiksa)',
                  'success'
                );
              }
            }
          })
          .catch(function () { clearInterval(pollInterval); });
        pollCount++;
      }, 2000);
    })
    .catch(function (err) {
      showToast('Sync gagal: ' + (err && err.message ? err.message : 'kesalahan tak terduga'), 'error');
      selesaiMuat();
    });
}

/* ─────────────────────────────────────────────────────────────
   LOGS
   ───────────────────────────────────────────────────────────── */
function showLogsView() {
  $('files-container').classList.add('hidden');
  $('empty-state').classList.add('hidden');
  var tm = $('tempmail-container'); if (tm) tm.classList.add('hidden');
  $('logs-container').classList.remove('hidden');

  var tbody = $('logs-tbody');
  tbody.innerHTML = '';

  if (state.logs.length === 0) {
    tbody.innerHTML = '<tr><td colspan="4" class="p-8 text-center text-textGray text-xs">Tidak ada log aktivitas</td></tr>';
    return;
  }

  state.logs.forEach(function (log) {
    var tr = document.createElement('tr');
    tr.className = 'hover:bg-paper transition';
    var statusBadge = log.status === 'error' ?
      '<span class="text-red-600 font-semibold">ERROR</span>' :
      log.status === 'success' ?
      '<span class="text-emerald-600 font-semibold">SUCCESS</span>' :
      '<span class="text-textGray font-semibold">INFO</span>';
    tr.innerHTML =
      '<td class="p-3 font-mono text-textGray whitespace-nowrap">' + formatDate(log.timestamp) + '</td>' +
      '<td class="p-3 font-medium">' + escapeHtml(log.action || '-') + '</td>' +
      '<td class="p-3 text-textGray">' + escapeHtml(log.details || log.detail || '-') + '</td>' +
      '<td class="p-3">' + statusBadge + '</td>';
    tbody.appendChild(tr);
  });
}

function loadLogs() {
  api('/api/logs')
    .then(function (data) {
      state.logs = Array.isArray(data) ? data : (data.logs || []);
      if (state.activeCategory === 'logs') showLogsView();
    })
    .catch(function () {});
}

/* ─────────────────────────────────────────────────────────────
   TEMP MAIL
   ───────────────────────────────────────────────────────────── */
function showTempmailView() {
  $('files-container').classList.add('hidden');
  $('empty-state').classList.add('hidden');
  $('logs-container').classList.add('hidden');
  $('tempmail-container').classList.remove('hidden');
  renderTempmail();
}

function renderTempmail() {
  var addrEl = $('tempmail-address');
  addrEl.textContent = state.tempmailAddress || 'Belum ada alamat';

  var tbody = $('tempmail-tbody');
  tbody.innerHTML = '';
  var msgs = state.tempmailMessages;
  if (!msgs.length) {
    tbody.innerHTML = '<tr><td colspan="3" class="p-8 text-center text-textGray text-xs">' +
      (state.tempmailAddress ? 'Kotak masuk masih kosong. Pesan masuk akan muncul di sini.' : 'Buat alamat dulu untuk mulai menerima pesan.') +
      '</td></tr>';
    return;
  }
  msgs.forEach(function (m) {
    var tr = document.createElement('tr');
    tr.className = 'hover:bg-paper transition cursor-pointer';
    tr.innerHTML =
      '<td class="p-3 font-medium">' + escapeHtml(m.fromName || m.from || '-') + '</td>' +
      '<td class="p-3 text-textGray truncate max-w-xs">' + escapeHtml(m.subject) + '</td>' +
      '<td class="p-3 font-mono text-textGray whitespace-nowrap">' + formatDate(m.createdAt) + '</td>';
    tr.addEventListener('click', function () { openTempmailMessage(m.id); });
    tbody.appendChild(tr);
  });
}

function loadTempmail() {
  api('/api/tempmail/address')
    .then(function (d) {
      state.tempmailAddress = d.address || null;
      renderTempmail();
      if (d.address) return api('/api/tempmail/inbox').then(function (i) {
        state.tempmailMessages = i.messages || [];
        renderTempmail();
      });
      state.tempmailMessages = [];
    })
    .catch(function (err) {
      if (err.message !== 'Unauthorized') showToast('Gagal memuat temp mail: ' + (err.message || ''), 'error');
    });
}

function createTempmailAddress() {
  $('btn-tempmail-new').disabled = true;
  api('/api/tempmail/address', { method: 'POST' })
    .then(function (d) {
      state.tempmailAddress = d.address;
      state.tempmailMessages = [];
      showToast('Alamat baru dibuat: ' + d.address, 'success');
      renderTempmail();
    })
    .catch(function (err) { showToast('Gagal membuat alamat: ' + (err.message || ''), 'error'); })
    .finally(function () { $('btn-tempmail-new').disabled = false; });
}

function deleteTempmailAddress() {
  if (!state.tempmailAddress) return;
  showConfirm('Hapus alamat temp mail ini beserta semua isinya?', function () {
    api('/api/tempmail/address', { method: 'DELETE' })
      .then(function () {
        state.tempmailAddress = null;
        state.tempmailMessages = [];
        showToast('Alamat dihapus.', 'success');
        renderTempmail();
      })
      .catch(function (err) { showToast('Gagal menghapus: ' + (err.message || ''), 'error'); });
  }, 'Hapus Alamat');
}

function copyTempmailAddress() {
  if (!state.tempmailAddress) { showToast('Belum ada alamat untuk disalin.', 'error'); return; }
  navigator.clipboard.writeText(state.tempmailAddress)
    .then(function () { showToast('Alamat disalin.', 'success'); })
    .catch(function () { showToast('Gagal menyalin.', 'error'); });
}

function openTempmailMessage(id) {
  api('/api/tempmail/message/' + id)
    .then(function (m) {
      $('tempmail-reader-subject').textContent = m.subject || '(tanpa subjek)';
      var bodyEl = $('tempmail-reader-body');
      // text wins for readability; fall back to stripped html so markup never
      // reaches the DOM as nodes — this is an inbox, not a renderer.
      var shown = m.text || (m.html || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      bodyEl.textContent = shown || '(pesan kosong)';
      $('tempmail-reader').classList.remove('hidden');
    })
    .catch(function (err) { showToast('Gagal membaca pesan: ' + (err.message || ''), 'error'); });
}

function startTempmailPolling() {
  stopTempmailPolling();
  state.tempmailPoll = setInterval(function () {
    if (state.activeCategory !== 'tempmail' || !state.tempmailAddress) return;
    api('/api/tempmail/inbox')
      .then(function (i) { state.tempmailMessages = i.messages || []; renderTempmail(); })
      .catch(function () {});
  }, 15000);
}

function stopTempmailPolling() {
  if (state.tempmailPoll) { clearInterval(state.tempmailPoll); state.tempmailPoll = null; }
}

/* ─────────────────────────────────────────────────────────────
   SETTINGS
   ───────────────────────────────────────────────────────────── */
/* ─────────────────────────────────────────────────────────────
   BRAND — nama dan logo di sidebar
   ----------------------------------------------------------------
   Disimpan di localStorage, bukan di server. Keduanya murni tampilan dan hanya
   berarti bagi peramban yang membukanya; menaruhnya di server berarti satu
   permintaan jaringan setiap kali halaman dimuat demi dua potong teks.
   ------------------------------------------------------------- */
var BRAND_NAME_KEY = 'drive-brand-name';
var BRAND_LOGO_KEY = 'drive-brand-logo';
var BRAND_NAME_DEFAULT = 'Drive Uyee';

function terapkanBrand() {
  var nama = localStorage.getItem(BRAND_NAME_KEY) || BRAND_NAME_DEFAULT;
  var logo = localStorage.getItem(BRAND_LOGO_KEY) || '';

  var nameEl = $('brand-name');
  if (nameEl) nameEl.textContent = nama;
  // Judul tab ikut nama yang diset, supaya tab-nya mudah dikenali saat banyak
  // tab terbuka sekaligus.
  document.title = nama + ' — Telegram Cloud Storage';

  var img = $('brand-logo-img');
  var icon = $('brand-logo-icon');
  if (img && icon) {
    if (logo) {
      img.setAttribute('src', logo);
      img.classList.remove('hidden');
      icon.classList.add('hidden');
    } else {
      img.removeAttribute('src');
      img.classList.add('hidden');
      icon.classList.remove('hidden');
    }
  }

  terapkanIkonTab(logo);
}

/* Ikon tab mengikuti logo yang dipilih di Pengaturan.

   <link rel="icon"> hanya dibaca peramban saat halaman dimuat dan saat
   nilainya diganti, jadi cukup menunjuk elemen yang sudah ada itu ke data URL
   logonya. Kalau belum ada logo, berkas /favicon.svg bawaan yang dipakai —
   lebih baik daripada blok kosong, karena peramban akan meminta /favicon.ico
   dan menampilkan lambang generiknya sendiri kalau tautannya dilepas. */
function terapkanIkonTab(logo) {
  var link = document.querySelector('link[rel="icon"]');
  if (!link) return;
  link.setAttribute('href', logo || '/favicon.svg');
  var apple = document.querySelector('link[rel="apple-touch-icon"]');
  if (apple) apple.setAttribute('href', logo || '/favicon.svg');
}

function bacaLogoBerkas(file, cb) {
  if (!file) return cb('');
  if (file.size > 2 * 1024 * 1024) {
    showToast('Logo terlalu besar (maksimal 2 MB).', 'error');
    return cb(null);
  }
  var reader = new FileReader();
  reader.onload = function () { cb(String(reader.result || '')); };
  reader.onerror = function () { cb(null); };
  reader.readAsDataURL(file);
}

function openSettings() {
  $('settings-modal').classList.remove('hidden');
  var nameInput = $('s-brand-name');
  if (nameInput) nameInput.value = localStorage.getItem(BRAND_NAME_KEY) || '';
  perbaruiPratinjauLogo();
  api('/api/settings')
    .then(function (data) {
      $('s-chatid').value = data.chatId || '';
    })
    .catch(function () {});
}

function perbaruiPratinjauLogo() {
  var box = $('s-logo-preview');
  if (!box) return;
  var logo = localStorage.getItem(BRAND_LOGO_KEY) || '';
  if (logo) {
    box.innerHTML = '<img src="' + logo + '" alt="" class="w-full h-full object-cover">';
  } else {
    box.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="w-5 h-5 text-primary"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>';
  }
}

function closeSettings() {
  $('settings-modal').classList.add('hidden');
}

function saveSettings(e) {
  if (e) e.preventDefault();
  var chatId = $('s-chatid').value.trim();
  var btn = $('settings-save');
  var spin = btn.querySelector('.spin');
  var span = btn.querySelector('span');
  var errEl = $('settings-error');
  var successEl = $('settings-success');

  errEl.classList.add('hidden');
  successEl.classList.add('hidden');
  span.textContent = 'Menyimpan...';
  spin.classList.remove('hidden');

  /* Nama dan logo tidak menunggu server: keduanya berlaku seketika di sidebar,
     dan menyimpannya lokal berarti permintaan jaringan tidak perlu berhasil
     lebih dulu sebelum tampilannya berubah. */
  var nameInput = $('s-brand-name');
  if (nameInput) {
    var nama = nameInput.value.trim();
    if (nama) localStorage.setItem(BRAND_NAME_KEY, nama);
    else localStorage.removeItem(BRAND_NAME_KEY);
    terapkanBrand();
  }

  api('/api/settings', { method: 'POST', body: { chatId: chatId } })
    .then(function () {
      successEl.textContent = 'Pengaturan disimpan.';
      successEl.classList.remove('hidden');
    })
    .catch(function (err) {
      errEl.textContent = err.data && err.data.error ? err.data.error : 'Gagal menyimpan';
      errEl.classList.remove('hidden');
    })
    .finally(function () {
      span.textContent = 'Simpan';
      spin.classList.add('hidden');
    });
}

function lockDrive() {
  closeSettings();
  showLoginGate();
  showToast('Drive dikunci');
}

function logoutSession() {
  showConfirm('Keluar dari sesi Telegram? Anda perlu login OTP lagi untuk menggunakan drive.', function () {
    api('/api/logout', { method: 'POST' })
      .then(function () {
        state.setupNeeded = true;
        closeSettings();
        showSetupWizard();
      })
      .catch(function () { showToast('Gagal keluar sesi'); });
  }, 'Keluar Sesi');
}

/* Deliberately separate from Reset Drive: that one deletes files, this one only
   forgets the app registration. The Telegram session cannot outlive the
   credentials it was issued under, so the wizard is where this lands. */
function resetApiCredentials() {
  showConfirm('Hapus API ID dan API Hash yang tersimpan? Sesi Telegram saat ini berakhir dan Anda perlu memasukkan kredensial lagi dari my.telegram.org. Berkas tidak dihapus.', function () {
    api('/api/settings/reset-credentials', { method: 'POST' })
      .then(function () {
        showToast('Kredensial API direset');
        state.setupNeeded = true;
        closeSettings();
        showSetupWizard();
      })
      .catch(function () { showToast('Gagal mereset kredensial'); });
  }, 'Reset Kredensial API');
}

function resetDrive() {
  showConfirm('Reset drive? Semua berkas dan pengaturan akan dihapus permanen. Tindakan ini tidak dapat dibatalkan.', function () {
    api('/api/reset', { method: 'POST' })
      .then(function () {
        showToast('Drive direset');
        setTimeout(function () { location.reload(); }, 1000);
      })
      .catch(function () { showToast('Gagal mereset drive'); });
  }, 'Reset Drive');
}

/* ─────────────────────────────────────────────────────────────
   THEME
   ───────────────────────────────────────────────────────────── */
// Must match the .theme-anim duration in base.css: the class is removed a hair
// after the transition it enables has finished, so it is never left switched on.
var THEME_ANIM_MS = 460;
var themeAnimTimer = null;
var themeSpinTimer = null;

// The colour tokens live on <html>, so swapping the class is the whole theme
// change — one style recalculation, and .theme-anim turns that recalculation
// into a crossfade across every element instead of an instant repaint.
function toggleTheme() {
  var html = document.documentElement;
  var toDark = !html.classList.contains('dark');
  var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  if (!reduce) {
    html.classList.add('theme-anim');
    clearTimeout(themeAnimTimer);
    themeAnimTimer = setTimeout(function () { html.classList.remove('theme-anim'); }, THEME_ANIM_MS);

    var btn = $('btn-theme');
    if (btn) {
      // Restarting the animation needs the class gone for a frame, or a second
      // click within the duration does nothing at all.
      btn.classList.remove('theme-spin');
      void btn.offsetWidth;
      btn.classList.add('theme-spin');
      clearTimeout(themeSpinTimer);
      themeSpinTimer = setTimeout(function () { btn.classList.remove('theme-spin'); }, THEME_ANIM_MS);
    }
  }

  html.classList.toggle('dark', toDark);
  state.theme = toDark ? 'dark' : 'light';
  localStorage.setItem('drive-theme', state.theme);
  applyThemeUI();
}

// Keeps the browser's own chrome (the mobile address bar, the tab strip on some
// desktop builds) in step with the page instead of staying dark under a light UI.
function applyThemeColorMeta() {
  var meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', state.theme === 'dark' ? '#171717' : '#f7f7f8');
}

function applyThemeUI() {
  var dark = state.theme === 'dark';
  $('ic-sun').classList.toggle('hidden', dark);
  $('ic-moon').classList.toggle('hidden', !dark);
  applyThemeColorMeta();
}

/* ─────────────────────────────────────────────────────────────
   LAYOUT
   ───────────────────────────────────────────────────────────── */
function toggleLayout() {
  state.layout = state.layout === 'grid' ? 'list' : 'grid';
  localStorage.setItem('drive-layout', state.layout);
  updateLayoutUI();
  renderFiles();
}

function updateLayoutUI() {
  if (state.layout === 'grid') {
    $('ic-grid').classList.add('hidden');
    $('ic-list').classList.remove('hidden');
  } else {
    $('ic-grid').classList.remove('hidden');
    $('ic-list').classList.add('hidden');
  }
}

/* ─────────────────────────────────────────────────────────────
   CUSTOM DROPDOWN
   ───────────────────────────────────────────────────────────── */
function initCustomDropdown(dropdownId, onChange) {
  var dropdown = $(dropdownId);
  if (!dropdown) return;

  var trigger = dropdown.querySelector('.custom-dropdown-trigger');
  var menu = dropdown.querySelector('.custom-dropdown-menu');
  var label = dropdown.querySelector('.custom-dropdown-label');
  var items = dropdown.querySelectorAll('.custom-dropdown-item');

  function open() {
    dropdown.classList.add('open');
    trigger.setAttribute('aria-expanded', 'true');
    // Highlight selected
    var currentValue = dropdown.dataset.value;
    items.forEach(function (item) {
      item.classList.toggle('selected', item.dataset.value === currentValue);
    });
  }

  function close() {
    dropdown.classList.remove('open');
    trigger.setAttribute('aria-expanded', 'false');
  }

  function toggle() {
    if (dropdown.classList.contains('open')) close();
    else open();
  }

  trigger.addEventListener('click', function (e) {
    e.stopPropagation();
    toggle();
  });

  items.forEach(function (item) {
    item.addEventListener('click', function (e) {
      e.stopPropagation();
      var value = item.dataset.value;
      var text = item.textContent;
      dropdown.dataset.value = value;
      label.textContent = text;
      close();
      if (onChange) onChange(value);
    });
  });

  // Close when clicking outside
  document.addEventListener('click', function (e) {
    if (!dropdown.contains(e.target)) close();
  });

  // Close on Escape
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && dropdown.classList.contains('open')) close();
  });
}

/* ─────────────────────────────────────────────────────────────
   DRAG & DROP
   ───────────────────────────────────────────────────────────── */
function setupDragDrop() {
  var dropzone = $('dropzone');
  var dashboard = document.querySelector('#app-dashboard');
  if (!dashboard) return;

  ['dragenter','dragover'].forEach(function (evt) {
    dashboard.addEventListener(evt, function (e) {
      e.preventDefault();
      e.stopPropagation();
      dropzone.classList.add('dragover');
    });
  });

  ['dragleave','drop'].forEach(function (evt) {
    dashboard.addEventListener(evt, function (e) {
      e.preventDefault();
      e.stopPropagation();
      dropzone.classList.remove('dragover');
    });
  });

  dashboard.addEventListener('drop', function (e) {
    e.preventDefault();
    var files = e.dataTransfer.files;
    if (files && files.length > 0) handleFiles(files);
  });
}

/* ─────────────────────────────────────────────────────────────
   CONNECTION STATUS
   ───────────────────────────────────────────────────────────── */
/* Status sambungan tidak lagi punya indikator di sidebar. Yang tersisa hanya
   banner sesi di dalam area berkas, dan itu muncul sendiri saat ada yang perlu
   ditindak — jadi tidak ada elemen untuk disegarkan di sini. */
function updateConnectionStatus(status) {
  state.connectionState = status;
}

function checkConnection() {
  api('/api/settings')
    .then(function (data) {
      if (data.connected) updateConnectionStatus('connected');
      else updateConnectionStatus('disconnected');
      if (data.sessionRevoked) {
        $('session-banner').classList.remove('hidden');
      } else {
        $('session-banner').classList.add('hidden');
      }
    })
    .catch(function () {
      updateConnectionStatus('disconnected');
    });
}

/* ─────────────────────────────────────────────────────────────
   STORAGE INFO
   ───────────────────────────────────────────────────────────── */
/* Drive ini menumpang Telegram, yang tidak memberi kuota yang bisa dibaca dari
   sini. Bar-nya tetap penuh karena ruangnya memang tak terbatas — bukan
   dihitung terhadap angka karangan seperti 15 GB, yang dulu membuat bar
   bergerak dan menyiratkan ada dinding yang menghadang. Yang berubah hanya
   angka total terpakai di sebelah kiri. */
function updateStorageInfo() {
  var totalSize = state.files.reduce(function (sum, f) { return sum + (f.total_size || f.size || 0); }, 0);

  var usedEl = $('storage-used');
  var fillEl = $('storage-fill');
  var pctEl = $('storage-percent');
  if (usedEl) usedEl.textContent = formatBytes(totalSize);
  if (fillEl) fillEl.style.width = '100%';
  if (pctEl) pctEl.textContent = '\u221E';
}

/* ─────────────────────────────────────────────────────────────
   NAVIGATION
   ───────────────────────────────────────────────────────────── */
function setCategory(category) {
  state.activeCategory = category;
  $$('.nav-btn').forEach(function (btn) {
    btn.classList.toggle('active', btn.dataset.category === category);
  });

  if (category === 'logs') {
    stopTempmailPolling();
    loadLogs();
  } else if (category === 'tempmail') {
    showTempmailView();
    loadTempmail();
    startTempmailPolling();
  } else {
    stopTempmailPolling();
    applyFilters();
  }

  /* Judul kategori tidak lagi ditampilkan: satu-satunya tempat judul itu muncul
     adalah label di atas daftar berkas, dan nilainya berubah tiap kali menu
     kategori diklik tanpa memberi keterangan baru — nama berkasnya sudah
     menjelaskan isinya. Kategori aktif tetap terbaca dari sorotan di sidebar. */
}

/* ─────────────────────────────────────────────────────────────
   SEARCH
   ───────────────────────────────────────────────────────────── */
function handleSearch(e) {
  state.searchQuery = e.target.value.trim();
  var clearBtn = $('search-clear');
  if (state.searchQuery) clearBtn.classList.remove('hidden');
  else clearBtn.classList.add('hidden');
  applyFilters();
}

function clearSearch() {
  $('search-input').value = '';
  state.searchQuery = '';
  $('search-clear').classList.add('hidden');
  applyFilters();
}

/* ─────────────────────────────────────────────────────────────
   EVENT BINDING
   ───────────────────────────────────────────────────────────── */
function bindEvents() {
  // Login
  $('login-form').addEventListener('submit', handleLogin);

  // Setup wizard
  $('setup-form-step1').addEventListener('submit', handleSendCode);
  $('setup-form-step2').addEventListener('submit', handleSignIn);
  $('btn-back-step1').addEventListener('click', function () {
    $('setup-form-step2').classList.add('hidden');
    $('setup-form-step1').classList.remove('hidden');
    setWizardStep(1);
  });

  // Navigation
  $$('.nav-btn').forEach(function (btn) {
    btn.addEventListener('click', function () {
      setCategory(btn.dataset.category);
    });
  });

  // Reload the current listing
  var refreshBtn = $('btn-refresh');
  if (refreshBtn) {
    refreshBtn.addEventListener('click', function () {
      if (state.activeCategory === 'logs') loadLogs();
      else if (state.activeCategory === 'tempmail') loadTempmail();
      else loadFiles();
    });
  }

  // Search
  $('search-input').addEventListener('input', handleSearch);
  $('search-clear').addEventListener('click', clearSearch);

  // Filters
  initCustomDropdown('dd-sort', function (value) {
    state.sortBy = value;
    applyFilters();
  });
  initCustomDropdown('dd-size', function (value) {
    state.sizeFilter = value;
    applyFilters();
  });
  $('filter-extension').addEventListener('input', function (e) {
    state.extensionFilter = e.target.value;
    applyFilters();
  });

  // Upload
  $('btn-upload-file').addEventListener('click', function () { $('file-input').click(); });
  $('btn-upload-folder').addEventListener('click', function () { $('folder-input').click(); });
  $('file-input').addEventListener('change', function (e) { handleFiles(e.target.files); e.target.value = ''; });
  $('folder-input').addEventListener('change', function (e) { handleFiles(e.target.files); e.target.value = ''; });

  // Upload panel
  $('upload-panel-close').addEventListener('click', function () { hideUploadPanel(); });
  var panelCollapsed = false;
  $('upload-panel-toggle').addEventListener('click', function () {
    panelCollapsed = !panelCollapsed;
    var items = $('upload-items');
    var chevron = $('upload-chevron');
    if (panelCollapsed) {
      items.style.maxHeight = '0';
      items.style.padding = '0';
      chevron.style.transform = 'rotate(180deg)';
    } else {
      items.style.maxHeight = '';
      items.style.padding = '';
      chevron.style.transform = '';
    }
  });

  // Sync
  $('btn-sync').addEventListener('click', handleSync);

  // Temp mail
  $('btn-tempmail-copy').addEventListener('click', copyTempmailAddress);
  $('btn-tempmail-refresh').addEventListener('click', loadTempmail);
  $('btn-tempmail-new').addEventListener('click', createTempmailAddress);
  $('btn-tempmail-delete').addEventListener('click', deleteTempmailAddress);
  $('btn-tempmail-close-reader').addEventListener('click', function () {
    $('tempmail-reader').classList.add('hidden');
  });

  // Layout
  $('btn-layout').addEventListener('click', toggleLayout);

  // Theme
  $('btn-theme').addEventListener('click', toggleTheme);

  // Settings
  $('btn-settings').addEventListener('click', openSettings);
  $('settings-close').addEventListener('click', closeSettings);
  $('settings-cancel').addEventListener('click', closeSettings);
  $('settings-form').addEventListener('submit', saveSettings);

  // Brand: nama dan logo
  var pickLogo = $('btn-pick-logo');
  var logoInput = $('s-brand-logo');
  if (pickLogo && logoInput) {
    pickLogo.addEventListener('click', function () { logoInput.click(); });
    logoInput.addEventListener('change', function (e) {
      var berkas = e.target.files && e.target.files[0];
      bacaLogoBerkas(berkas, function (dataUrl) {
        if (dataUrl === null) return;            // ditolak: pesannya sudah muncul
        if (dataUrl) localStorage.setItem(BRAND_LOGO_KEY, dataUrl);
        perbaruiPratinjauLogo();
        terapkanBrand();
      });
      e.target.value = '';
    });
  }
  var clearLogo = $('btn-clear-logo');
  if (clearLogo) {
    clearLogo.addEventListener('click', function () {
      localStorage.removeItem(BRAND_LOGO_KEY);
      perbaruiPratinjauLogo();
      terapkanBrand();
    });
  }
  $('btn-lock').addEventListener('click', lockDrive);
  $('btn-logout').addEventListener('click', logoutSession);
  $('btn-reset-drive').addEventListener('click', resetDrive);
  $('btn-reset-creds').addEventListener('click', resetApiCredentials);

  // Confirm modal
  $('confirm-close').addEventListener('click', function () {
    $('confirm-modal').classList.add('hidden');
  });

  // Context menu
  document.addEventListener('click', hideContextMenu);
  document.addEventListener('contextmenu', function (e) {
    if (!e.target.closest('#files-container')) hideContextMenu();
  });
  $('ctx-download').addEventListener('click', function () {
    if (state.contextFile) window.open('/api/download/' + state.contextFile.file_key, '_blank');
    hideContextMenu();
  });
  $('ctx-preview').addEventListener('click', function () {
    if (state.contextFile) openLightboxByFile(state.contextFile);
    hideContextMenu();
  });
  $('ctx-delete').addEventListener('click', function () {
    if (state.contextFile) {
      var file = state.contextFile;
      showConfirm('Hapus "' + (file.filename || file.name || 'file') + '"?', function () {
        api('/api/files/' + file.file_key, { method: 'DELETE' })
          .then(function () { showToast('Berkas dihapus'); loadFiles(); })
          .catch(function () { showToast('Gagal menghapus'); });
      }, 'Hapus Berkas');
    }
    hideContextMenu();
  });

  // Preview viewer
  $('lb-close').addEventListener('click', closeLightbox);
  $('lb-prev').addEventListener('click', function (e) { e.stopPropagation(); lightboxPrev(); });
  $('lb-next').addEventListener('click', function (e) { e.stopPropagation(); lightboxNext(); });
  $('lb-delete').addEventListener('click', lightboxDelete);
  $('lb-zoom-in').addEventListener('click', function () { pvZoomStep(1); });
  $('lb-zoom-out').addEventListener('click', function () { pvZoomStep(-1); });

  // Click the image to toggle between fit and 2×, the way Drive does. Clicking
  // the empty stage around it closes — but only the stage itself, so a click
  // landing on a control or on the file never dismisses the viewer.
  $('lb-img').addEventListener('click', function (e) {
    e.stopPropagation();
    if (this.classList.contains('pv-blur')) return;
    pvSetZoom(pvZoom > 1 ? 1 : 2);
  });
  $('lb-stage').addEventListener('click', function (e) {
    if (e.target === $('lb-stage') || e.target === $('lb-fit')) closeLightbox();
  });

  // A zoomed image is sized in pixels against the stage, so the stage changing
  // size has to recompute it or the zoom drifts away from what the label says.
  window.addEventListener('resize', function () {
    if ($('lightbox').classList.contains('active')) pvApplyZoom();
  });

  // Bulk bar
  $('bulk-select-all').addEventListener('click', selectAll);
  $('bulk-download').addEventListener('click', bulkDownload);
  $('bulk-delete').addEventListener('click', bulkDelete);
  $('bulk-cancel').addEventListener('click', function () {
    state.isBulkMode = false;
    state.selectedIds.clear();
    updateBulkBar();
    applyFilters();
  });

  // Keyboard shortcuts
  document.addEventListener('keydown', function (e) {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

    if (e.key === 'Escape') {
      if ($('lightbox').classList.contains('active')) closeLightbox();
      else if (!$('settings-modal').classList.contains('hidden')) closeSettings();
      else if (!$('confirm-modal').classList.contains('hidden')) $('confirm-modal').classList.add('hidden');
      else if (state.isBulkMode) {
        state.isBulkMode = false;
        state.selectedIds.clear();
        updateBulkBar();
        applyFilters();
      }
      hideContextMenu();
    }

    if ($('lightbox').classList.contains('active')) {
      if (e.key === 'ArrowLeft') lightboxPrev();
      if (e.key === 'ArrowRight') lightboxNext();
      if (e.key === '+' || e.key === '=') pvZoomStep(1);
      if (e.key === '-' || e.key === '_') pvZoomStep(-1);
      if (e.key === '0') pvSetZoom(1);
    }

    if ((e.ctrlKey || e.metaKey) && e.key === 'a' && state.filteredFiles.length > 0) {
      e.preventDefault();
      if (!state.isBulkMode) state.isBulkMode = true;
      selectAll();
    }
  });

  // Drag & drop
  setupDragDrop();
}

/* ─────────────────────────────────────────────────────────────
   INIT
   ───────────────────────────────────────────────────────────── */
function init() {
  applyThemeUI();
  updateLayoutUI();
  // Nama dan logo dipasang sebelum apa pun tampil, supaya tidak ada kedipan
  // teks bawaan di sidebar saat halaman dibuka.
  terapkanBrand();
  bindEvents();

  // Check auth status
  api('/api/auth/status')
    .then(function (data) {
      if (data.authenticated) {
        state.loggedIn = true;
        showDashboard();
        loadFiles();
        checkConnection();
        setInterval(checkConnection, 30000);
      } else {
        // Not signed in. The password gate comes first either way: every setup
        // endpoint except /api/settings/status is behind requireAuth, so
        // opening the wizard here would only produce a 401 on the first submit.
        // The status probe still runs, so a successful login knows whether to
        // land on the wizard or the dashboard.
        showLoginGate();
        api('/api/settings/status')
          .then(function (s) { state.setupNeeded = !s.configured; })
          .catch(function () { /* gate is already up; treat as configured */ });
      }
    })
    .catch(function () {
      showLoginGate();
    });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}

})();
