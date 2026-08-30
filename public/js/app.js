/* ============================================================================
   Nexus Drive — Frontend Application
   ----------------------------------------------------------------------------
   Modern minimalis UI logic. Works with index.html + app.css.
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
  if (['jpg','jpeg','png','gif','webp','svg','bmp','ico','tiff'].indexOf(ext) >= 0 || mime.indexOf('image/') === 0) return 'image';
  if (['mp4','mkv','avi','mov','webm','flv','wmv','m4v','mpg','mpeg'].indexOf(ext) >= 0 || mime.indexOf('video/') === 0) return 'video';
  if (['mp3','wav','flac','aac','ogg','m4a','opus'].indexOf(ext) >= 0 || mime.indexOf('audio/') === 0) return 'audio';
  return 'document';
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

function showToast(msg) {
  var t = $('toast');
  if (!t) return;
  $('toast-msg').textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(t._timer);
  t._timer = setTimeout(function () { t.classList.add('hidden'); }, 3500);
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
  if (state.setupNeeded) showSetupWizard();
  else showLoginGate();
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
  var apiId = $('api-id').value.trim();
  var apiHash = $('api-hash').value.trim();
  var errEl = $('step1-error');
  var btn = $('btn-send-otp');
  var spin = btn.querySelector('.spin');
  var span = btn.querySelector('span');

  errEl.classList.add('hidden');
  span.textContent = 'Mengirim...';
  spin.classList.remove('hidden');

  api('/api/auth/send-code', { method: 'POST', body: { phone: phone, apiId: apiId, apiHash: apiHash } })
    .then(function (data) {
      state.authId = data.authId;
      $('field-2fa').classList.add('hidden');
      $('setup-form-step1').classList.add('hidden');
      $('setup-form-step2').classList.remove('hidden');
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
      state.files = data.files || [];
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

  logsContainer.classList.add('hidden');
  container.classList.remove('hidden');
  container.innerHTML = '';
  container.className = state.layout === 'grid'
    ? 'grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-3'
    : 'flex flex-col gap-1';

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
    if (isSelected) card.style.borderColor = 'rgb(var(--c-primary))';

    var cat = getFileCategory(file);
    var ext = getFileExt(file.filename || file.name || '');
    var iconHtml = '';

    // Thumbnail or icon
    if (file.telegram_thumb_id) {
      var thumbUrl = '/api/thumb/' + file.file_key;
      iconHtml = '<div class="aspect-square rounded-control overflow-hidden bg-paper border border-cloud flex items-center justify-center">' +
        '<img src="' + thumbUrl + '" class="w-full h-full object-cover" alt="" loading="lazy" onerror="this.parentElement.innerHTML=\'<div style=color:' + getExtColor(ext) + '>' + getFileIconSvg(cat, ext) + '</div>\'">' +
        '</div>';
    } else {
      var iconColor = cat === 'image' ? '#1e8e3e' : cat === 'video' ? '#d93025' : cat === 'audio' ? '#a142f4' : getExtColor(ext);
      iconHtml = '<div class="aspect-square rounded-control bg-paper border border-cloud flex items-center justify-center">' +
        '<div style="color:' + iconColor + '">' + getFileIconSvg(cat, ext) + '</div>' +
        '</div>';
    }

    // Checkbox (bulk mode)
    var checkboxHtml = state.isBulkMode ?
      '<div class="absolute top-2 left-2 z-10">' +
      '<div class="w-5 h-5 rounded flex items-center justify-center transition" style="background:' + (isSelected ? 'rgb(var(--c-primary))' : 'rgb(var(--c-surface))') + ';border:2px solid ' + (isSelected ? 'rgb(var(--c-primary))' : 'rgb(var(--c-border))') + '">' +
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
      row.style.background = 'rgb(var(--c-primary) / 0.06)';
      row.style.borderLeft = '2px solid rgb(var(--c-primary))';
    }

    var cat = getFileCategory(file);
    var ext = getFileExt(file.filename || file.name || '');
    var iconColor = cat === 'image' ? '#1e8e3e' : cat === 'video' ? '#d93025' : cat === 'audio' ? '#a142f4' : getExtColor(ext);

    var checkboxHtml = state.isBulkMode ?
      '<div class="w-5 h-5 rounded flex items-center justify-center shrink-0 transition" style="background:' + (isSelected ? 'rgb(var(--c-primary))' : 'transparent') + ';border:2px solid ' + (isSelected ? 'rgb(var(--c-primary))' : 'rgb(var(--c-border))') + '">' +
      (isSelected ? '<svg viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="3" class="w-3 h-3"><polyline points="20 6 9 17 4 12"/></svg>' : '') +
      '</div>' : '';

    var iconHtml = file.telegram_thumb_id ?
      '<div class="w-10 h-10 rounded-control overflow-hidden bg-paper border border-cloud shrink-0"><img src="/api/thumb/' + file.file_key + '" class="w-full h-full object-cover" alt="" loading="lazy"></div>' :
      '<div class="w-10 h-10 rounded-control bg-paper border border-cloud flex items-center justify-center shrink-0" style="color:' + iconColor + '">' + getFileIconSvg(cat, ext) + '</div>';

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
   LIGHTBOX
   ───────────────────────────────────────────────────────────── */
function openLightboxByFile(file) {
  var cat = getFileCategory(file);
  if (cat === 'document' || cat === 'folder') {
    var ext = getFileExt(file.filename || file.name || '');
    if (ext === 'pdf' || ext === 'txt' || ext === 'md' || ext === 'json') {
      openLightbox(file);
    } else {
      window.open('/api/download/' + file.file_key, '_blank');
    }
  } else {
    openLightbox(file);
  }
}

function openLightbox(file) {
  var lb = $('lightbox');
  lb.classList.remove('hidden');
  lb.classList.add('active');

  state.lightboxList = state.filteredFiles.filter(function (f) {
    var c = getFileCategory(f);
    return c === 'image' || c === 'video' || c === 'audio';
  });
  state.lightboxIndex = state.lightboxList.findIndex(function (f) { return f.file_key === file.file_key; });

  loadLightboxContent(file);

  var prevBtn = $('lb-prev');
  var nextBtn = $('lb-next');
  if (state.lightboxList.length > 1) {
    prevBtn.classList.remove('hidden');
    nextBtn.classList.remove('hidden');
  } else {
    prevBtn.classList.add('hidden');
    nextBtn.classList.add('hidden');
  }
}

function loadLightboxContent(file) {
  $('lb-loading').classList.remove('hidden');
  ['lb-img','lb-video','lb-pdf','lb-text','lb-audio-container','lb-nopreview'].forEach(function (id) {
    $(id).classList.add('hidden');
  });

  var name = file.filename || file.name || 'Pratinjau';
  $('lb-title-text').textContent = name;
  $('lb-name').textContent = name;
  $('lb-size').textContent = formatBytes(file.total_size || file.size);
  $('lb-download').href = '/api/download/' + file.file_key;

  var orig = $('lb-download-original');
  orig.href = '/api/download-original/' + file.file_key;
  orig.classList.remove('hidden'); // always show; server handles non-split gracefully

  var cat = getFileCategory(file);
  var ext = getFileExt(file.filename || file.name || '');

  if (cat === 'image') {
    var img = $('lb-img');
    img.onload = function () {
      $('lb-loading').classList.add('hidden');
      img.classList.remove('hidden');
    };
    img.onerror = function () {
      $('lb-loading').classList.add('hidden');
      $('lb-nopreview').classList.remove('hidden');
    };
    img.src = '/api/preview/' + file.file_key;
  } else if (cat === 'video') {
    $('lb-loading').classList.add('hidden');
    var vid = $('lb-video');
    vid.src = '/api/stream/' + file.file_key;
    vid.classList.remove('hidden');
    vid.load();
    vid.play().catch(function () {});
  } else if (cat === 'audio') {
    $('lb-loading').classList.add('hidden');
    $('lb-audio-title').textContent = name;
    $('lb-audio-size').textContent = formatBytes(file.total_size || file.size);
    var aud = $('lb-audio');
    aud.src = '/api/stream/' + file.file_key;
    $('lb-audio-container').classList.remove('hidden');
    aud.load();
    aud.play().catch(function () {});
  } else if (ext === 'pdf') {
    $('lb-loading').classList.add('hidden');
    var iframe = $('lb-pdf');
    iframe.src = '/api/preview/' + file.file_key;
    iframe.classList.remove('hidden');
  } else if (ext === 'txt' || ext === 'md' || ext === 'json') {
    $('lb-loading').classList.remove('hidden');
    fetch('/api/preview/' + file.file_key)
      .then(function (res) { return res.text(); })
      .then(function (text) {
        $('lb-loading').classList.add('hidden');
        $('lb-text').textContent = text;
        $('lb-text').classList.remove('hidden');
      })
      .catch(function () {
        $('lb-loading').classList.add('hidden');
        $('lb-nopreview').classList.remove('hidden');
      });
  } else {
    $('lb-loading').classList.add('hidden');
    $('lb-nopreview').classList.remove('hidden');
  }
}

function closeLightbox() {
  var lb = $('lightbox');
  lb.classList.remove('active');
  setTimeout(function () {
    lb.classList.add('hidden');
    var vid = $('lb-video');
    var aud = $('lb-audio');
    if (vid) { vid.pause(); vid.removeAttribute('src'); vid.load(); }
    if (aud) { aud.pause(); aud.removeAttribute('src'); aud.load(); }
  }, 250);
}

function lightboxNext() {
  if (state.lightboxList.length === 0) return;
  state.lightboxIndex = (state.lightboxIndex + 1) % state.lightboxList.length;
  loadLightboxContent(state.lightboxList[state.lightboxIndex]);
}

function lightboxPrev() {
  if (state.lightboxList.length === 0) return;
  state.lightboxIndex = (state.lightboxIndex - 1 + state.lightboxList.length) % state.lightboxList.length;
  loadLightboxContent(state.lightboxList[state.lightboxIndex]);
}

function lightboxDelete() {
  if (state.lightboxList.length === 0) return;
  var file = state.lightboxList[state.lightboxIndex];
  showConfirm('Hapus "' + (file.filename || file.name || 'file') + '"?', function () {
    api('/api/files/' + file.file_key, { method: 'DELETE' })
      .then(function () {
        showToast('Berkas dihapus');
        closeLightbox();
        loadFiles();
      })
      .catch(function () { showToast('Gagal menghapus berkas'); });
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

function showUploadPanel() {
  $('upload-panel').classList.remove('hidden');
}

function hideUploadPanel() {
  $('upload-panel').classList.add('hidden');
}

function renderUploadItems() {
  var container = $('upload-items');
  container.innerHTML = '';

  var active = state.uploads.filter(function (u) { return u.status === 'pending' || u.status === 'uploading'; });
  $('upload-panel-title').textContent = 'Unggah: ' + (active.length || state.uploads.length) + ' file';

  if (state.uploads.length === 0) {
    container.innerHTML = '<p class="text-center text-textGray text-xs py-4">Tidak ada unggahan aktif</p>';
    return;
  }

  state.uploads.slice().reverse().forEach(function (up) {
    var div = document.createElement('div');
    div.className = 'up-item';
    div.id = 'up-' + up.id;

    var statusText = up.status === 'done' ? 'Selesai' : up.status === 'error' ? 'Gagal' : up.status === 'uploading' ? formatBytes(up.progress * up.size) + ' / ' + formatBytes(up.size) : 'Menunggu...';
    var fillColor = up.status === 'error' ? 'rgb(var(--c-danger))' : up.status === 'done' ? 'rgb(var(--c-success))' : 'rgb(var(--c-primary))';

    div.innerHTML =
      '<div class="up-row">' +
      '<span class="up-name">' + escapeHtml(up.name) + '</span>' +
      '<span class="up-status">' + statusText + '</span>' +
      '</div>' +
      '<div class="up-bar"><div class="up-fill" style="width:' + (up.progress * 100) + '%;background-color:' + fillColor + '"></div></div>';

    container.appendChild(div);
  });
}

function updateUploadItem(up) {
  var div = $('up-' + up.id);
  if (!div) return;
  var statusText = up.status === 'done' ? 'Selesai' : up.status === 'error' ? 'Gagal' : up.status === 'uploading' ? formatBytes(up.progress * up.size) + ' / ' + formatBytes(up.size) : 'Menunggu...';
  var fillColor = up.status === 'error' ? 'rgb(var(--c-danger))' : up.status === 'done' ? 'rgb(var(--c-success))' : 'rgb(var(--c-primary))';

  var statusEl = div.querySelector('.up-status');
  var fillEl = div.querySelector('.up-fill');
  if (statusEl) statusEl.textContent = statusText;
  if (fillEl) {
    fillEl.style.width = (up.progress * 100) + '%';
    fillEl.style.backgroundColor = fillColor;
  }
}

var uploadInProgress = false;
function processUploadQueue() {
  if (uploadInProgress) return;
  var next = state.uploads.find(function (u) { return u.status === 'pending'; });
  if (!next) {
    uploadInProgress = false;
    loadFiles();
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
  icon.classList.add('animate-spin');
  text.textContent = 'Syncing...';

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
              icon.classList.remove('animate-spin');
              text.textContent = 'Sync';
              loadFiles();
              if (s.syncing) showToast('Sync masih berjalan...');
            }
          })
          .catch(function () { clearInterval(pollInterval); });
        pollCount++;
      }, 2000);
    })
    .catch(function () {
      showToast('Sync gagal');
      icon.classList.remove('animate-spin');
      text.textContent = 'Sync';
    });
}

/* ─────────────────────────────────────────────────────────────
   LOGS
   ───────────────────────────────────────────────────────────── */
function showLogsView() {
  $('files-container').classList.add('hidden');
  $('empty-state').classList.add('hidden');
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
   SETTINGS
   ───────────────────────────────────────────────────────────── */
function openSettings() {
  $('settings-modal').classList.remove('hidden');
  api('/api/settings')
    .then(function (data) {
      $('s-chatid').value = data.chatId || '';
    })
    .catch(function () {});
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
function toggleTheme() {
  var html = document.documentElement;
  if (html.classList.contains('dark')) {
    html.classList.remove('dark');
    state.theme = 'light';
    localStorage.setItem('drive-theme', 'light');
    $('ic-sun').classList.remove('hidden');
    $('ic-moon').classList.add('hidden');
  } else {
    html.classList.add('dark');
    state.theme = 'dark';
    localStorage.setItem('drive-theme', 'dark');
    $('ic-sun').classList.add('hidden');
    $('ic-moon').classList.remove('hidden');
  }
}

function applyThemeUI() {
  if (state.theme === 'dark') {
    $('ic-sun').classList.add('hidden');
    $('ic-moon').classList.remove('hidden');
  } else {
    $('ic-sun').classList.remove('hidden');
    $('ic-moon').classList.add('hidden');
  }
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
function updateConnectionStatus(status) {
  state.connectionState = status;
  var dot = document.querySelector('#conn-dot .dot');
  var text = document.querySelector('#conn-dot span:last-child');
  if (!dot || !text) return;

  var colors = {
    connected: 'rgb(var(--c-success))',
    connecting: 'rgb(var(--c-warning))',
    disconnected: 'rgb(var(--c-danger))',
  };
  var labels = {
    connected: 'TERHUBUNG',
    connecting: 'MENGHUBUNGKAN...',
    disconnected: 'TERPUTUS',
  };

  dot.style.backgroundColor = colors[status] || colors.disconnected;
  text.textContent = labels[status] || labels.disconnected;
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
function updateStorageInfo() {
  var totalSize = state.files.reduce(function (sum, f) { return sum + (f.total_size || f.size || 0); }, 0);
  var maxBytes = 15 * 1024 * 1024 * 1024;
  var percent = Math.min((totalSize / maxBytes) * 100, 100);

  var usedEl = $('storage-used');
  var fillEl = $('storage-fill');
  if (usedEl) usedEl.textContent = formatBytes(totalSize);
  if (fillEl) fillEl.style.width = percent + '%';
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
    loadLogs();
  } else {
    applyFilters();
  }

  var titles = {
    all: 'Drive Saya',
    image: 'Gambar',
    video: 'Video',
    audio: 'Audio',
    document: 'Dokumen',
    folder: 'Folder',
    logs: 'Log Sistem',
  };
  var titleEl = $('ws-title');
  if (titleEl) titleEl.textContent = titles[category] || 'Drive Saya';
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
  });

  // Navigation
  $$('.nav-btn').forEach(function (btn) {
    btn.addEventListener('click', function () {
      setCategory(btn.dataset.category);
    });
  });

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
  $('upload-panel-close').addEventListener('click', hideUploadPanel);
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

  // Layout
  $('btn-layout').addEventListener('click', toggleLayout);

  // Theme
  $('btn-theme').addEventListener('click', toggleTheme);

  // Settings
  $('btn-settings').addEventListener('click', openSettings);
  $('settings-close').addEventListener('click', closeSettings);
  $('settings-cancel').addEventListener('click', closeSettings);
  $('settings-form').addEventListener('submit', saveSettings);
  $('btn-lock').addEventListener('click', lockDrive);
  $('btn-logout').addEventListener('click', logoutSession);
  $('btn-reset-drive').addEventListener('click', resetDrive);

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

  // Lightbox
  $('lb-close').addEventListener('click', closeLightbox);
  $('lb-prev').addEventListener('click', lightboxPrev);
  $('lb-next').addEventListener('click', lightboxNext);
  $('lb-delete').addEventListener('click', lightboxDelete);
  $('lightbox').addEventListener('click', function (e) {
    if (e.target === $('lightbox')) closeLightbox();
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
        // Check if setup is needed (public endpoint — no auth required)
        api('/api/settings/status')
          .then(function (s) {
            if (!s.configured) {
              state.setupNeeded = true;
              showSetupWizard();
            } else {
              showLoginGate();
            }
          })
          .catch(function () {
            showLoginGate();
          });
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
