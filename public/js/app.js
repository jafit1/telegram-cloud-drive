/* ===========================================================================
   Telegram Cloud Drive — Frontend Logic (MTProto + Sequential Uploads)
   =========================================================================== */
(() => {
  'use strict';

  /* ───── State ───── */
  let allFiles = [];
  let visibleFiles = [];
  let selectedKeys = new Set();
  let currentCategory = 'all';
  let searchQuery = '';
  let isConfigured = false;
  let layoutMode = 'grid'; // 'grid' | 'list'
  let currentAuthId = null; // Temp auth session ID for OTP login

  /* ───── DOM Refs ───── */
  const $ = s => document.querySelector(s);
  const $$ = s => document.querySelectorAll(s);

  const wizardEl = $('#setup-wizard');
  const dashboardEl = $('#app-dashboard');
  const setupFormStep1 = $('#setup-form-step1');
  const setupFormStep2 = $('#setup-form-step2');
  const settingsModal = $('#settings-modal');
  const settingsForm = $('#settings-form');
  const searchInput = $('#search-input');
  const searchClear = $('#search-clear');
  const filesContainer = $('#files-container');
  const logsContainer = $('#logs-container');
  const logsTbody = $('#logs-tbody');
  const filesLoading = $('#files-loading');
  const emptyState = $('#empty-state');
  const uploadPanel = $('#upload-panel');
  const uploadItems = $('#upload-items');
  const fileInput = $('#file-input');
  const ctxMenu = $('#ctx-menu');
  const lightbox = $('#lightbox');
  const toastEl = $('#toast');

  let ctxTarget = null; // File data for context menu
  let lightboxFile = null;

  /* ===================================================================
     HELPERS
     =================================================================== */
  function formatSize(b) {
    if (!b) return '0 B';
    const u = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(b) / Math.log(1024));
    return (b / Math.pow(1024, i)).toFixed(i ? 1 : 0) + ' ' + u[i];
  }

  function formatDate(iso) {
    if (!iso) return '-';
    const d = new Date(iso);
    return d.toLocaleDateString('id-ID', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
  }

  function catIconSvg(cat) {
    const c = `cat-${cat}`;
    switch (cat) {
      case 'image': return `<svg class="${c}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="18" height="18"><rect width="18" height="18" x="3" y="3" rx="2" ry="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/></svg>`;
      case 'video': return `<svg class="${c}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="18" height="18"><path d="m22 8-6 4 6 4V8Z"/><rect width="14" height="12" x="2" y="6" rx="2" ry="2"/></svg>`;
      case 'audio': return `<svg class="${c}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="18" height="18"><path d="M3 18v-6a9 9 0 0 1 18 0v6"/><path d="M21 19a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3zM3 19a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-3a2 2 0 0 0-2-2H3z"/></svg>`;
      default: return `<svg class="${c}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="18" height="18"><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/></svg>`;
    }
  }

  function getExt(name) {
    const d = name.lastIndexOf('.');
    return d === -1 ? '' : name.substring(d + 1).toUpperCase();
  }

  function toast(msg) {
    $('#toast-msg').textContent = msg;
    toastEl.classList.remove('hidden');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => toastEl.classList.add('hidden'), 3500);
  }

  function showConfirm(title, message) {
    return new Promise(resolve => {
      const modal = $('#confirm-modal');
      $('#confirm-title').textContent = title;
      $('#confirm-message').textContent = message;
      modal.classList.remove('hidden');

      const onOk = () => {
        cleanup();
        resolve(true);
      };
      const onCancel = () => {
        cleanup();
        resolve(false);
      };
      const cleanup = () => {
        modal.classList.add('hidden');
        $('#confirm-btn-ok').removeEventListener('click', onOk);
        $('#confirm-btn-cancel').removeEventListener('click', onCancel);
        $('#confirm-close').removeEventListener('click', onCancel);
      };

      $('#confirm-btn-ok').addEventListener('click', onOk);
      $('#confirm-btn-cancel').addEventListener('click', onCancel);
      $('#confirm-close').addEventListener('click', onCancel);
    });
  }


  /* ===================================================================
     INIT — check config
     =================================================================== */
  async function init() {
    // Pre-fill custom API ID & Hash from localStorage if available
    const savedApiId = localStorage.getItem('drive-custom-api-id');
    const savedApiHash = localStorage.getItem('drive-custom-api-hash');
    if (savedApiId) {
      $('#api-id').value = savedApiId;
      $('.adv-details').open = true; // Auto-expand advanced options
    }
    if (savedApiHash) {
      $('#api-hash').value = savedApiHash;
    }

    try {
      const res = await fetch('/api/settings');
      const data = await res.json();
      if (data.configured && data.connected) {
        if (data.chatId) {
          isConfigured = true;
          wizardEl.classList.add('hidden');
          dashboardEl.classList.remove('hidden');
          loadFiles();
          loadStats();
          syncBackgroundUploads();
          setInterval(syncBackgroundUploads, 3000);
        } else {
          // Connected but missing Storage Chat ID, go to Step 3
          wizardEl.classList.remove('hidden');
          dashboardEl.classList.add('hidden');
          setupFormStep1.classList.add('hidden');
          setupFormStep2.classList.add('hidden');
          const setupFormStep3 = $('#setup-form-step3');
          setupFormStep3.classList.remove('hidden');
        }
      } else {
        wizardEl.classList.remove('hidden');
        dashboardEl.classList.add('hidden');
        setupFormStep1.classList.remove('hidden');
        setupFormStep2.classList.add('hidden');
        $('#setup-form-step3').classList.add('hidden');
      }
    } catch {
      wizardEl.classList.remove('hidden');
    }
  }

  /* ===================================================================
     SETUP WIZARD (OTP LOGIN FLOW)
     =================================================================== */
  
  // Step 1: Send OTP Code
  setupFormStep1.addEventListener('submit', async e => {
    e.preventDefault();
    const errEl = $('#step1-error');
    const spinEl = setupFormStep1.querySelector('.spin');
    const btnText = setupFormStep1.querySelector('span');

    errEl.classList.add('hidden');
    spinEl.classList.remove('hidden');
    btnText.textContent = 'Mengirim Kode...';

    try {
      const rawApiId = $('#api-id').value.trim();
      const rawApiHash = $('#api-hash').value.trim();

      // Save custom credentials to localStorage so the user never has to re-enter them
      if (rawApiId) localStorage.setItem('drive-custom-api-id', rawApiId);
      else localStorage.removeItem('drive-custom-api-id');

      if (rawApiHash) localStorage.setItem('drive-custom-api-hash', rawApiHash);
      else localStorage.removeItem('drive-custom-api-hash');

      const body = {
        apiId: rawApiId ? parseInt(rawApiId) : null,
        apiHash: rawApiHash ? rawApiHash : null,
        phone: $('#phone-number').value.trim()
      };

      const res = await fetch('/api/auth/send-code', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      const data = await res.json();

      if (data.success) {
        currentAuthId = data.authId;
        // Swap forms
        setupFormStep1.classList.add('hidden');
        setupFormStep2.classList.remove('hidden');
        toast('OTP Code dikirim ke Telegram Anda!');
      } else {
        errEl.textContent = data.error || 'Gagal mengirim OTP.';
        errEl.classList.remove('hidden');
      }
    } catch (err) {
      errEl.textContent = 'Kesalahan jaringan: ' + err.message;
      errEl.classList.remove('hidden');
    } finally {
      spinEl.classList.add('hidden');
      btnText.textContent = 'Kirim Kode OTP';
    }
  });

  // Step 2: Verify OTP and login
  setupFormStep2.addEventListener('submit', async e => {
    e.preventDefault();
    const errEl = $('#step2-error');
    const sucEl = $('#step2-success');
    const spinEl = setupFormStep2.querySelector('.spin');
    const btnText = setupFormStep2.querySelector('span');

    errEl.classList.add('hidden');
    sucEl.classList.add('hidden');
    spinEl.classList.remove('hidden');
    btnText.textContent = 'Memverifikasi...';

    try {
      const body = {
        authId: currentAuthId,
        code: $('#otp-code').value.trim(),
        password: $('#password-2fa').value.trim()
      };

      const res = await fetch('/api/auth/sign-in', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      const data = await res.json();

      if (data.success) {
        sucEl.textContent = 'Berhasil Terhubung!';
        sucEl.classList.remove('hidden');
        
        // Fetch settings to check if Chat ID is configured
        const setRes = await fetch('/api/settings');
        const setData = await setRes.json();
        
        setTimeout(() => {
          if (setData.chatId) {
            isConfigured = true;
            wizardEl.classList.add('hidden');
            dashboardEl.classList.remove('hidden');
            loadFiles();
            loadStats();
          } else {
            // Chat ID not set, show Step 3
            setupFormStep2.classList.add('hidden');
            $('#setup-form-step3').classList.remove('hidden');
          }
        }, 1200);
      } else if (data.requires2FA) {
        // Reveal 2FA password field since Telegram needs it
        $('#field-2fa').classList.remove('hidden');
        errEl.textContent = data.error;
        errEl.classList.remove('hidden');
      } else {
        errEl.textContent = data.error || 'OTP tidak valid.';
        errEl.classList.remove('hidden');
      }
    } catch (err) {
      errEl.textContent = err.message;
      errEl.classList.remove('hidden');
    } finally {
      spinEl.classList.add('hidden');
      btnText.textContent = 'Masuk';
    }
  });

  // Step 3: Configure Storage Chat ID
  const setupFormStep3 = $('#setup-form-step3');
  setupFormStep3.addEventListener('submit', async e => {
    e.preventDefault();
    const errEl = $('#step3-error');
    const sucEl = $('#step3-success');
    const spinEl = setupFormStep3.querySelector('.spin');
    const btnText = setupFormStep3.querySelector('span');

    errEl.classList.add('hidden');
    sucEl.classList.add('hidden');
    spinEl.classList.remove('hidden');
    btnText.textContent = 'Menyimpan...';

    try {
      const body = { chatId: $('#storage-chat-id').value.trim() };
      const res = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      const data = await res.json();

      if (data.success) {
        sucEl.textContent = 'Penyimpanan terhubung!';
        sucEl.classList.remove('hidden');
        isConfigured = true;
        setTimeout(() => {
          wizardEl.classList.add('hidden');
          dashboardEl.classList.remove('hidden');
          loadFiles();
          loadStats();
          // Reset setup wizard forms
          setupFormStep1.classList.remove('hidden');
          setupFormStep2.classList.add('hidden');
          setupFormStep3.classList.add('hidden');
          setupFormStep1.reset();
          setupFormStep2.reset();
          setupFormStep3.reset();
        }, 1200);
      } else {
        errEl.textContent = data.error || 'Gagal menyimpan.';
        errEl.classList.remove('hidden');
      }
    } catch (err) {
      errEl.textContent = err.message;
      errEl.classList.remove('hidden');
    } finally {
      spinEl.classList.add('hidden');
      btnText.textContent = 'Simpan & Masuk ke Drive';
    }
  });

  // Back Button
  $('#btn-back-step1').addEventListener('click', () => {
    setupFormStep2.classList.add('hidden');
    setupFormStep1.classList.remove('hidden');
  });

  /* ===================================================================
     SETTINGS MODAL
     =================================================================== */
  $('#btn-settings').addEventListener('click', async () => {
    settingsModal.classList.remove('hidden');
    try {
      const res = await fetch('/api/settings');
      const d = await res.json();
      $('#s-chatid').value = d.chatId || '';
    } catch { /* ignore */ }
  });

  $('#settings-close').addEventListener('click', () => settingsModal.classList.add('hidden'));
  $('#settings-cancel').addEventListener('click', () => settingsModal.classList.add('hidden'));
  settingsModal.addEventListener('click', e => { if (e.target === settingsModal) settingsModal.classList.add('hidden'); });

  settingsForm.addEventListener('submit', async e => {
    e.preventDefault();
    const errEl = $('#settings-error');
    const sucEl = $('#settings-success');
    errEl.classList.add('hidden');
    sucEl.classList.add('hidden');

    try {
      const body = { chatId: $('#s-chatid').value.trim() };
      const res = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      const data = await res.json();
      if (data.success) {
        sucEl.textContent = 'Penyimpanan berhasil diperbarui!';
        sucEl.classList.remove('hidden');
        setTimeout(() => settingsModal.classList.add('hidden'), 800);
        loadFiles();
      } else {
        errEl.textContent = data.error || 'Gagal menyimpan.';
        errEl.classList.remove('hidden');
      }
    } catch (err) {
      errEl.textContent = err.message;
      errEl.classList.remove('hidden');
    }
  });

  // Logout / Keluar
  $('#btn-logout').addEventListener('click', () => {
    if (!confirm('Yakin ingin keluar? Semua sesi Telegram di perangkat ini akan ditutup.')) return;
    fetch('/api/logout', { method: 'POST' }).catch(() => {});
    settingsModal.classList.add('hidden');
    dashboardEl.classList.add('hidden');
    wizardEl.classList.remove('hidden');
    isConfigured = false;
    allFiles = [];
    toast('Berhasil keluar sesi.');
  });

  /* ===================================================================
     FILE LIST & ACTIVITY LOG LOADING
     =================================================================== */
  async function loadFiles() {
    if (currentCategory === 'logs') {
      loadLogs();
      return;
    }
    filesLoading.classList.remove('hidden');
    emptyState.classList.add('hidden');
    filesContainer.innerHTML = '';
    try {
      const res = await fetch('/api/files');
      allFiles = await res.json();
      render();
    } catch { toast('Gagal memuat daftar berkas.'); }
    filesLoading.classList.add('hidden');
  }

  async function loadStats() {
    try {
      const res = await fetch('/api/stats');
      const s = await res.json();
      const bytes = s.totalSize || s.total_size || 0;
      $('#storage-used').textContent = formatSize(bytes);
      const pct = Math.min(100, (bytes / (15 * 1024 * 1024 * 1024)) * 100);
      $('#storage-fill').style.width = pct + '%';
    } catch { /* ignore */ }
  }

  async function loadLogs() {
    filesLoading.classList.remove('hidden');
    logsTbody.innerHTML = '';
    try {
      const res = await fetch('/api/logs');
      const logs = await res.json();
      if (logs.length === 0) {
        logsTbody.innerHTML = `<tr><td colspan="4" class="p-8 text-center text-textGray font-mono">Belum ada catatan aktivitas.</td></tr>`;
      } else {
        logs.forEach(log => {
          let badgeClass = '';
          if (log.status === 'error') {
            badgeClass = 'bg-red-500/15 text-red-500 dark:text-red-400';
          } else if (log.action === 'Auth' || log.action === 'Config') {
            badgeClass = 'bg-blue-500/15 text-blue-500 dark:text-blue-400';
          } else {
            badgeClass = 'bg-emerald-500/15 text-emerald-500 dark:text-emerald-400';
          }
          
          const statusColor = log.status === 'error' ? 'text-red-500' : 'text-emerald-500';
          
          logsTbody.insertAdjacentHTML('beforeend', `
            <tr class="border-b border-neutral-100 dark:border-borderDark/20 hover:bg-neutral-50 dark:hover:bg-black/25 transition duration-150">
              <td class="p-3 text-textGray font-mono">${formatDate(log.timestamp)}</td>
              <td class="p-3"><span class="px-2 py-0.5 rounded text-[10px] font-mono font-bold uppercase ${badgeClass}">${log.action}</span></td>
              <td class="p-3 text-textDark dark:text-white max-w-sm truncate" title="${log.details}">${log.details}</td>
              <td class="p-3 font-mono font-bold ${statusColor}">${log.status.toUpperCase()}</td>
            </tr>
          `);
        });
      }
    } catch (err) {
      console.error(err);
      toast('Gagal memuat log aktivitas.');
    }
    filesLoading.classList.add('hidden');
  }

  /* ===================================================================
     RENDER FILES
     =================================================================== */
  /* ===================================================================
     RENDER FILES
     =================================================================== */
  function render() {
    let list = allFiles;
    if (currentCategory !== 'all') {
      list = list.filter(f => f.category === currentCategory);
    }
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      list = list.filter(f => f.filename.toLowerCase().includes(q));
    }

    // 1. Sort Filter
    const sortVal = $('#filter-sort').value;
    if (sortVal === 'newest') {
      list.sort((a, b) => new Date(b.uploaded_at) - new Date(a.uploaded_at));
    } else if (sortVal === 'oldest') {
      list.sort((a, b) => new Date(a.uploaded_at) - new Date(b.uploaded_at));
    } else if (sortVal === 'largest') {
      list.sort((a, b) => b.total_size - a.total_size);
    } else if (sortVal === 'smallest') {
      list.sort((a, b) => a.total_size - b.total_size);
    } else if (sortVal === 'name-asc') {
      list.sort((a, b) => a.filename.localeCompare(b.filename));
    } else if (sortVal === 'name-desc') {
      list.sort((a, b) => b.filename.localeCompare(a.filename));
    }

    // 2. Size Filter
    const sizeVal = $('#filter-size').value;
    if (sizeVal === 'small') {
      list = list.filter(f => f.total_size < 10 * 1024 * 1024); // < 10MB
    } else if (sizeVal === 'medium') {
      list = list.filter(f => f.total_size >= 10 * 1024 * 1024 && f.total_size <= 100 * 1024 * 1024); // 10MB-100MB
    } else if (sizeVal === 'large') {
      list = list.filter(f => f.total_size > 100 * 1024 * 1024); // > 100MB
    }

    // 3. Extension Filter
    const extVal = $('#filter-extension').value.trim().toLowerCase();
    if (extVal) {
      list = list.filter(f => getExt(f.filename).toLowerCase() === extVal);
    }

    visibleFiles = list;

    // Prune selectedKeys of elements no longer in allFiles
    const fileKeys = new Set(allFiles.map(f => f.file_key));
    for (const key of selectedKeys) {
      if (!fileKeys.has(key)) selectedKeys.delete(key);
    }

    filesContainer.innerHTML = '';
    emptyState.classList.toggle('hidden', list.length > 0);

    if (layoutMode === 'grid') {
      filesContainer.className = 'grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-3';
    } else {
      filesContainer.className = 'flex flex-col border border-neutral-200 dark:border-borderDark/30 rounded-control overflow-hidden divide-y divide-neutral-100 dark:divide-borderDark/30 bg-white dark:bg-surface/40';
      if (list.length > 0) {
        const header = document.createElement('div');
        header.className = 'flex items-center justify-between p-3.5 bg-neutral-50 dark:bg-black/30 text-textGray font-mono text-[10px] font-bold uppercase tracking-wider border-b border-neutral-200 dark:border-borderDark/30 select-none';
        header.innerHTML = `
          <div class="w-5 mr-3 shrink-0"></div>
          <div class="flex-1 pr-4">Nama File</div>
          <div class="w-20 shrink-0 text-right pr-4">Ukuran</div>
          <div class="w-24 shrink-0 text-right hidden sm:block pr-4">Diunggah</div>
          <div class="w-8 shrink-0"></div>
        `;
        filesContainer.appendChild(header);
      }
    }

    list.forEach(f => {
      const html = layoutMode === 'grid' ? gridCard(f) : listRow(f);
      const temp = document.createElement('div');
      temp.innerHTML = html.trim();
      const el = temp.firstChild;

      // Click to open preview modal instantly
      el.addEventListener('click', () => openLightbox(f));

      // Right click context menu
      el.addEventListener('contextmenu', e => {
        e.preventDefault();
        showCtx(e, f);
      });

      // Actions dots click (List View)
      const dots = el.querySelector('.fc-dots');
      if (dots) {
        dots.addEventListener('click', e => {
          e.stopPropagation();
          showCtx(e, f);
        });
      }

      // Checkbox event binding
      const cb = el.querySelector('.fc-checkbox, .fr-checkbox');
      if (cb) {
        cb.addEventListener('change', e => {
          const key = cb.dataset.key;
          const wrapper = cb.closest('label');
          const span = wrapper.querySelector('span');
          if (cb.checked) {
            selectedKeys.add(key);
            wrapper.classList.remove('opacity-0');
            wrapper.classList.add('opacity-100', 'border-primary', 'bg-primary');
            if (span) span.className = 'w-2 h-2 bg-black rounded-[1px] transition scale-100';
            el.classList.add('ring-2', 'ring-primary', 'border-primary', 'bg-primary/5');
          } else {
            selectedKeys.delete(key);
            wrapper.classList.remove('opacity-100', 'border-primary', 'bg-primary');
            wrapper.classList.add('opacity-0');
            if (span) span.className = 'w-2 h-2 bg-primary rounded-[1px] transition scale-0';
            el.classList.remove('ring-2', 'ring-primary', 'border-primary', 'bg-primary/5');
          }
          updateBulkBar();
        });
      }

      filesContainer.appendChild(el);
    });

    updateBulkBar();
  }

  function updateBulkBar() {
    const bulkBar = $('#bulk-bar');
    const bulkCount = $('#bulk-count');
    const selectAllBtn = $('#bulk-select-all');

    if (selectedKeys.size === 0) {
      bulkBar.classList.add('hidden');
      return;
    }

    bulkBar.classList.remove('hidden');
    bulkCount.textContent = selectedKeys.size;

    // Check if all visible files are selected
    const allSelected = visibleFiles.length > 0 && visibleFiles.every(f => selectedKeys.has(f.file_key));
    selectAllBtn.textContent = allSelected ? 'Kosongkan Pilihan' : 'Pilih Semua';
  }

  function gridCard(f) {
    const ext = getExt(f.filename);
    const isChecked = selectedKeys.has(f.file_key) ? 'checked' : '';
    const wrapperClass = selectedKeys.has(f.file_key) 
      ? 'opacity-100 border-primary bg-primary' 
      : 'opacity-0 group-hover:opacity-100 border-neutral-300 dark:border-borderDark/80';
    const spanClass = selectedKeys.has(f.file_key) ? 'scale-100 bg-black' : 'scale-0 bg-primary';
    const selectedCardClass = selectedKeys.has(f.file_key) ? 'ring-2 ring-primary border-primary bg-primary/5' : '';

    let thumbHtml = '';
    if (f.telegram_thumb_id) {
      thumbHtml = `<img src="/api/thumb/${f.file_key}" loading="lazy" class="w-full h-full object-cover transition duration-300 group-hover:scale-105" alt="${f.filename}">`;
    } else {
      thumbHtml = `<span class="font-mono text-[10px] font-bold tracking-wider text-textGray dark:text-neutral-400 select-none">${ext || 'FILE'}</span>`;
    }

    return `
    <div class="relative bg-neutral-50 dark:bg-black/30 border border-neutral-200/60 dark:border-borderDark/40 rounded-card p-2.5 hover:shadow-md transition-all duration-300 group hover:scale-[1.02] flex flex-col gap-2 cursor-pointer select-none ${selectedCardClass}" data-key="${f.file_key}">
      <label class="absolute top-2 left-2 z-10 w-4 h-4 bg-white dark:bg-neutral-800 border rounded flex items-center justify-center cursor-pointer transition ${wrapperClass}" onclick="event.stopPropagation();">
        <input type="checkbox" class="fc-checkbox sr-only" data-key="${f.file_key}" ${isChecked}>
        <span class="w-2 h-2 rounded-[1px] transition ${spanClass}"></span>
      </label>
      <div class="w-full aspect-square bg-neutral-100 dark:bg-black/20 rounded-control flex items-center justify-center overflow-hidden border border-neutral-200/40 dark:border-borderDark/20">
        ${thumbHtml}
      </div>
      <div class="flex items-center justify-between gap-1.5 mt-0.5">
        <div class="flex items-center gap-1.5 overflow-hidden flex-1">
          <span class="w-3.5 h-3.5 text-primary shrink-0">${catIconSvg(f.category)}</span>
          <span class="text-[11px] font-semibold truncate text-textDark dark:text-white" title="${f.filename}">${f.filename}</span>
        </div>
        <span class="text-[8px] font-mono text-textGray shrink-0">${formatSize(f.total_size)}</span>
      </div>
    </div>`;
  }

  function listRow(f) {
    const ext = getExt(f.filename);
    const isChecked = selectedKeys.has(f.file_key) ? 'checked' : '';
    const wrapperClass = selectedKeys.has(f.file_key) 
      ? 'border-primary bg-primary' 
      : 'border-neutral-300 dark:border-borderDark/80';
    const spanClass = selectedKeys.has(f.file_key) ? 'scale-100 bg-black' : 'scale-0 bg-primary';
    const selectedCardClass = selectedKeys.has(f.file_key) ? 'bg-primary/5 border-l-4 border-l-primary' : '';

    let thumbHtml = '';
    if (f.telegram_thumb_id) {
      thumbHtml = `<img src="/api/thumb/${f.file_key}" loading="lazy" class="w-8 h-8 rounded-control object-cover shrink-0 border border-neutral-200/50 dark:border-borderDark/30" alt="">`;
    } else {
      thumbHtml = `<div class="w-8 h-8 rounded-control bg-neutral-100 dark:bg-black/30 border border-neutral-200/50 dark:border-borderDark/30 flex items-center justify-center text-[9px] font-mono font-bold text-textGray shrink-0 select-none">${ext || 'FILE'}</div>`;
    }

    return `
    <div class="flex items-center justify-between p-3.5 hover:bg-neutral-50 dark:hover:bg-black/40 transition duration-150 cursor-pointer select-none text-xs ${selectedCardClass}" data-key="${f.file_key}">
      <label class="w-4.5 h-4.5 shrink-0 bg-white dark:bg-neutral-800 border-2 rounded-control flex items-center justify-center cursor-pointer transition mr-3 ${wrapperClass}" onclick="event.stopPropagation();">
        <input type="checkbox" class="fr-checkbox sr-only" data-key="${f.file_key}" ${isChecked}>
        <span class="w-2 h-2 rounded-[2px] transition ${spanClass}"></span>
      </label>
      <div class="flex items-center gap-2.5 overflow-hidden flex-1 pr-4">
        ${thumbHtml}
        <span class="w-4 h-4 text-primary shrink-0">${catIconSvg(f.category)}</span>
        <span class="text-xs font-semibold text-textDark dark:text-white truncate" title="${f.filename}">${f.filename}</span>
      </div>
      <span class="w-20 shrink-0 text-right font-mono text-textGray pr-4">${formatSize(f.total_size)}</span>
      <span class="w-24 shrink-0 text-right text-textGray/80 hidden sm:block pr-4">${formatDate(f.uploaded_at)}</span>
      <span class="w-8 shrink-0 flex justify-center text-textGray hover:text-primary transition fc-dots"><svg viewBox="0 0 24 24" fill="currentColor" width="18" height="18"><circle cx="12" cy="5" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="12" cy="19" r="1.5"/></svg></span>
    </div>`;
  }


  /* ===================================================================
     SIDEBAR NAV + SEARCH
     =================================================================== */
  $$('.nav-btn').forEach(btn => btn.addEventListener('click', () => {
    $$('.nav-btn').forEach(b => {
      b.className = 'nav-btn bg-neutral-100 dark:bg-black/30 text-textGray dark:text-neutral-400 px-4 py-1.5 rounded-full text-xs border border-neutral-200 dark:border-borderDark/30 hover:border-primary/50 transition';
    });
    btn.className = 'nav-btn bg-primary text-black font-semibold px-4 py-1.5 rounded-full text-xs border border-primary transition';
    currentCategory = btn.dataset.category;

    const titles = {
      all: 'Drive Saya',
      image: 'Gambar',
      video: 'Video',
      audio: 'Audio',
      document: 'Dokumen',
      logs: 'Log Aktivitas'
    };
    $('#ws-title').textContent = titles[currentCategory] || 'Drive Saya';

    if (currentCategory === 'logs') {
      filesContainer.classList.add('hidden');
      emptyState.classList.add('hidden');
      logsContainer.classList.remove('hidden');
      loadLogs();
    } else {
      logsContainer.classList.add('hidden');
      filesContainer.classList.remove('hidden');
      loadFiles();
    }
  }));

  searchInput.addEventListener('input', () => {
    searchQuery = searchInput.value.trim();
    searchClear.classList.toggle('hidden', !searchQuery);
    render();
  });
  searchClear.addEventListener('click', () => {
    searchInput.value = '';
    searchQuery = '';
    searchClear.classList.add('hidden');
    render();
  });

  /* ===================================================================
     LAYOUT TOGGLE
     =================================================================== */
  $('#btn-layout').addEventListener('click', () => {
    layoutMode = layoutMode === 'grid' ? 'list' : 'grid';
    $('#ic-list').classList.toggle('hidden', layoutMode === 'list');
    $('#ic-grid').classList.toggle('hidden', layoutMode === 'grid');
    render();
  });

  /* ===================================================================
     THEME TOGGLE
     =================================================================== */
  const savedTheme = localStorage.getItem('drive-theme') || 'dark';
  if (savedTheme === 'light') {
    document.documentElement.classList.remove('dark');
  } else {
    document.documentElement.classList.add('dark');
  }
  updateThemeIcon();

  $('#btn-theme').addEventListener('click', () => {
    document.documentElement.classList.toggle('dark');
    const isDark = document.documentElement.classList.contains('dark');
    localStorage.setItem('drive-theme', isDark ? 'dark' : 'light');
    updateThemeIcon();
  });

  function updateThemeIcon() {
    const isDark = document.documentElement.classList.contains('dark');
    $('#ic-sun').classList.toggle('hidden', !isDark);
    $('#ic-moon').classList.toggle('hidden', isDark);
  }

  /* ===================================================================
     SEQUENTIAL UPLOADS QUEUE
     =================================================================== */
  // Upload File action
  $('#btn-upload-file').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    if (fileInput.files.length) uploadFiles(fileInput.files);
    fileInput.value = '';
  });

  // Upload Folder action
  const folderInput = $('#folder-input');
  $('#btn-upload-folder').addEventListener('click', () => folderInput.click());
  folderInput.addEventListener('change', () => {
    if (folderInput.files.length) uploadFiles(folderInput.files);
    folderInput.value = '';
  });

  // Drag & Drop
  const ws = document.body;
  const dropzone = $('#dropzone');
  let dragCount = 0;
  ws.addEventListener('dragenter', e => { e.preventDefault(); dragCount++; dropzone.classList.add('dragover'); });
  ws.addEventListener('dragleave', e => { e.preventDefault(); dragCount--; if (dragCount <= 0) { dragCount = 0; dropzone.classList.remove('dragover'); } });
  ws.addEventListener('dragover', e => e.preventDefault());
  ws.addEventListener('drop', e => { e.preventDefault(); dragCount = 0; dropzone.classList.remove('dragover'); if (e.dataTransfer.files.length) uploadFiles(e.dataTransfer.files); });

  let uploadQueue = [];
  let isUploadingActive = false;

  function uploadFiles(fileList) {
    uploadPanel.classList.remove('hidden');
    [...fileList].forEach(f => uploadQueue.push(f));
    processNextUpload();
  }

  function processNextUpload() {
    if (isUploadingActive || uploadQueue.length === 0) return;
    isUploadingActive = true;
    const file = uploadQueue.shift();

    const displayName = file.webkitRelativePath || file.name;
    const exists = allFiles.some(f => f.filename === displayName && f.total_size === file.size);

    if (exists) {
      toast(`Dilewati: "${displayName}" sudah ada.`);
      const uploadId = 'up-skip-' + Date.now() + '-' + Math.random().toString(36).substr(2, 5);
      uploadItems.insertAdjacentHTML('beforeend', `
        <div class="up-item" id="${uploadId}">
          <div class="up-row"><span class="up-name">${displayName}</span><span class="up-status">Dilewati (sudah ada)</span></div>
          <div class="up-bar"><div class="up-fill" style="width: 100%; background: var(--border-color);"></div></div>
        </div>
      `);
      setTimeout(() => {
        isUploadingActive = false;
        processNextUpload();
      }, 400);
      return;
    }

    uploadSingle(file, () => {
      isUploadingActive = false;
      processNextUpload();
    });
  }

  function uploadSingle(file, onComplete) {
    const uploadId = 'up-' + Date.now() + '-' + Math.random().toString(36).substr(2, 5);
    const displayName = file.webkitRelativePath || file.name;
    uploadItems.insertAdjacentHTML('beforeend', `
      <div class="up-item" id="${uploadId}">
        <div class="up-row"><span class="up-name">${displayName}</span><span class="up-status">Mengantre...</span></div>
        <div class="up-bar"><div class="up-fill" style="width: 0%;"></div></div>
      </div>
    `);

    const form = new FormData();
    form.append('file', file, displayName);

    const xhr = new XMLHttpRequest();
    const itemEl = document.getElementById(uploadId);
    let sse = null;

    xhr.upload.addEventListener('progress', e => {
      if (e.lengthComputable) {
        const pct = Math.round((e.loaded / e.total) * 100);
        itemEl.querySelector('.up-fill').style.width = (pct * 0.1) + '%'; // Browser-to-server represents 10%
        itemEl.querySelector('.up-status').textContent = `Mengunggah ke Server: ${pct}%`;
      }
    });

    xhr.addEventListener('load', () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        itemEl.querySelector('.up-status').textContent = 'Memproses di Telegram...';
        sse = new EventSource(`/api/upload-progress/${uploadId}`);
        sse.onmessage = ev => {
          try {
            const data = JSON.parse(ev.data);
            if (data.status === 'uploading') {
              const pct = Math.round(data.uploaded); // uploaded is 0-100 from GramJS
              itemEl.querySelector('.up-fill').style.width = (10 + (pct * 0.9)) + '%'; // Telegram upload represents 90%
              itemEl.querySelector('.up-status').textContent = `Mengirim ke Telegram: ${pct}%`;
            } else if (data.status === 'done') {
              itemEl.querySelector('.up-status').textContent = '✓ Selesai';
              itemEl.querySelector('.up-fill').style.width = '100%';
              itemEl.querySelector('.up-fill').style.background = 'var(--success)';
              sse.close();
              loadFiles();
              loadStats();
              if (onComplete) onComplete();
            } else if (data.status === 'error') {
              itemEl.querySelector('.up-status').textContent = 'Upload gagal ke Telegram';
              itemEl.querySelector('.up-fill').style.background = 'var(--danger)';
              sse.close();
              if (onComplete) onComplete();
            }
          } catch (err) {}
        };
        sse.onerror = () => {
          sse.close();
          if (onComplete) onComplete();
        };
      } else {
        itemEl.querySelector('.up-status').textContent = 'Gagal upload ke server';
        itemEl.querySelector('.up-fill').style.background = 'var(--danger)';
        if (onComplete) onComplete();
      }
    });

    xhr.addEventListener('error', () => {
      itemEl.querySelector('.up-status').textContent = 'Koneksi error';
      itemEl.querySelector('.up-fill').style.background = 'var(--danger)';
      if (onComplete) onComplete();
    });

    xhr.open('POST', '/api/upload');
    xhr.setRequestHeader('X-Upload-Id', uploadId);
    xhr.send(form);
  }

  $('#upload-panel-close').addEventListener('click', () => {
    uploadPanel.classList.add('hidden');
    uploadItems.innerHTML = '';
  });

  async function syncBackgroundUploads() {
    try {
      const res = await fetch('/api/uploads');
      const uploads = await res.json();
      
      const keys = Object.keys(uploads);
      if (keys.length === 0) return;

      uploadPanel.classList.remove('hidden');

      keys.forEach(uploadId => {
        const data = uploads[uploadId];
        let itemEl = document.getElementById(uploadId);
        
        if (!itemEl) {
          uploadItems.insertAdjacentHTML('beforeend', `
            <div class="up-item" id="${uploadId}">
              <div class="up-row"><span class="up-name">${data.filename}</span><span class="up-status">Mengantre...</span></div>
              <div class="up-bar"><div class="up-fill" style="width: 0%;"></div></div>
            </div>
          `);
          itemEl = document.getElementById(uploadId);
        }

        const fillEl = itemEl.querySelector('.up-fill');
        const statusEl = itemEl.querySelector('.up-status');

        if (data.status === 'uploading') {
          const pct = Math.round(data.uploaded);
          fillEl.style.width = (10 + (pct * 0.9)) + '%';
          statusEl.textContent = `Mengirim ke Telegram: ${pct}%`;
        } else if (data.status === 'done') {
          statusEl.textContent = '✓ Selesai';
          fillEl.style.width = '100%';
          fillEl.style.background = 'var(--success)';
        } else if (data.status === 'error') {
          statusEl.textContent = 'Upload gagal ke Telegram';
          fillEl.style.background = 'var(--danger)';
        }
      });
    } catch (err) {
      console.log("Failed to sync background uploads:", err);
    }
  }


  /* ===================================================================
     CONTEXT MENU
     =================================================================== */
  function showCtx(e, file) {
    ctxTarget = file;
    ctxMenu.classList.remove('hidden');
    let x = e.clientX || e.pageX;
    let y = e.clientY || e.pageY;
    ctxMenu.style.left = Math.min(x, window.innerWidth - 190) + 'px';
    ctxMenu.style.top = Math.min(y, window.innerHeight - 140) + 'px';
  }
  document.addEventListener('click', () => ctxMenu.classList.add('hidden'));
  document.addEventListener('contextmenu', e => { if (!e.target.closest('[data-key]')) ctxMenu.classList.add('hidden'); });

  $('#ctx-download').addEventListener('click', () => { if (ctxTarget) downloadFile(ctxTarget); });
  $('#ctx-preview').addEventListener('click', () => { if (ctxTarget) openLightbox(ctxTarget); });
  $('#ctx-delete').addEventListener('click', () => { if (ctxTarget) deleteFile(ctxTarget); });

  /* ===================================================================
     DOWNLOAD & DELETE
     =================================================================== */
  function downloadFile(f) {
    const a = document.createElement('a');
    a.href = `/api/download/${f.file_key}`;
    a.download = f.filename;
    a.click();
  }

  async function deleteFile(f) {
    if (!await showConfirm('Hapus Berkas', `Apakah Anda yakin ingin menghapus "${f.filename}" secara permanen?`)) return;
    try {
      const res = await fetch(`/api/files/${f.file_key}`, { method: 'DELETE' });
      const d = await res.json();
      if (d.success) {
        toast('Berkas dihapus.');
        if (lightboxFile && lightboxFile.file_key === f.file_key) {
          closeLightbox();
        }
        loadFiles();
        loadStats();
      } else toast(d.error || 'Gagal menghapus.');
    } catch { toast('Error menghapus berkas.'); }
  }

  /* ===================================================================
     LIGHTBOX (Preview with Progressive Loading & Sliding Navigation)
     ================================================================== */
  function openLightbox(f) {
    if (!f) return;
    
    // Stop any currently playing media before loading new
    const oldVid = $('#lb-video'); oldVid.pause(); oldVid.removeAttribute('src');
    const oldAud = $('#lb-audio'); oldAud.pause(); oldAud.removeAttribute('src');
    $('#lb-img').removeAttribute('src');
    $('#lb-pdf').removeAttribute('src');
    $('#lb-text').textContent = '';

    lightboxFile = f;
    lightbox.classList.remove('hidden');
    document.body.style.overflow = 'hidden';

    // Reset lightbox loader elements
    $('#lb-loading').classList.remove('hidden');
    $('#lb-img').classList.add('hidden');
    $('#lb-video').classList.add('hidden');
    $('#lb-audio').classList.add('hidden');
    $('#lb-pdf').classList.add('hidden');
    $('#lb-text').classList.add('hidden');
    $('#lb-nopreview').classList.add('hidden');

    $('#lb-name').textContent = f.filename;
    $('#lb-size').textContent = formatSize(f.total_size);
    $('#lb-download').href = `/api/download/${f.file_key}`;
    $('#lb-download-original').href = `/api/download-original/${f.file_key}`;

    // Show/hide Slider Buttons
    const idx = visibleFiles.findIndex(item => item.file_key === f.file_key);
    const prevBtn = $('#lb-prev');
    const nextBtn = $('#lb-next');

    if (idx > 0) {
      prevBtn.classList.remove('hidden');
    } else {
      prevBtn.classList.add('hidden');
    }

    if (idx !== -1 && idx < visibleFiles.length - 1) {
      nextBtn.classList.remove('hidden');
    } else {
      nextBtn.classList.add('hidden');
    }

    const previewUrl = `/api/preview/${f.file_key}`;
    const streamUrl = `/api/stream/${f.file_key}`;
    const ext = getExt(f.filename).toLowerCase();

    if (f.category === 'image') {
      const img = $('#lb-img');
      // 1. Show low-res thumbnail instantly if available
      if (f.telegram_thumb_id) {
        img.src = `/api/thumb/${f.file_key}`;
        img.classList.remove('hidden');
        $('#lb-loading').classList.add('hidden');
      }

      // 2. Load high-res preview progressively in background
      const highRes = new Image();
      highRes.src = previewUrl;
      highRes.onload = () => {
        if (lightboxFile && lightboxFile.file_key === f.file_key) {
          img.src = previewUrl;
          img.classList.remove('hidden');
          $('#lb-loading').classList.add('hidden');
        }
      };
      highRes.onerror = () => {
        if (!f.telegram_thumb_id) {
          $('#lb-loading').classList.add('hidden');
          $('#lb-nopreview').classList.remove('hidden');
        }
      };
    } else if (f.category === 'video') {
      const vid = $('#lb-video');
      vid.src = streamUrl;
      vid.onloadeddata = () => { $('#lb-loading').classList.add('hidden'); vid.classList.remove('hidden'); };
      vid.onerror = () => { $('#lb-loading').classList.add('hidden'); $('#lb-nopreview').classList.remove('hidden'); };
    } else if (f.category === 'audio') {
      const aud = $('#lb-audio');
      aud.src = streamUrl;
      aud.onloadeddata = () => { $('#lb-loading').classList.add('hidden'); aud.classList.remove('hidden'); };
      aud.onerror = () => { $('#lb-loading').classList.add('hidden'); $('#lb-nopreview').classList.remove('hidden'); };
    } else if (ext === 'pdf') {
      const pdf = $('#lb-pdf');
      pdf.src = previewUrl;
      pdf.onload = () => { $('#lb-loading').classList.add('hidden'); pdf.classList.remove('hidden'); };
      pdf.onerror = () => { $('#lb-loading').classList.add('hidden'); $('#lb-nopreview').classList.remove('hidden'); };
    } else if (['txt', 'js', 'json', 'css', 'html', 'md', 'xml', 'log'].includes(ext)) {
      fetch(previewUrl)
        .then(res => res.text())
        .then(txt => {
          if (lightboxFile && lightboxFile.file_key === f.file_key) {
            $('#lb-loading').classList.add('hidden');
            const pre = $('#lb-text');
            pre.textContent = txt.length > 50000 ? txt.substring(0, 50000) + '\n\n...[File Terlalu Besar, Dipotong]...' : txt;
            pre.classList.remove('hidden');
          }
        })
        .catch(() => {
          $('#lb-loading').classList.add('hidden');
          $('#lb-nopreview').classList.remove('hidden');
        });
    } else {
      $('#lb-loading').classList.add('hidden');
      $('#lb-nopreview').classList.remove('hidden');
    }
  }

  function closeLightbox() {
    lightbox.classList.add('hidden');
    document.body.style.overflow = '';
    
    // Cleanup media elements to halt playback
    const vid = $('#lb-video'); vid.pause(); vid.removeAttribute('src'); vid.load();
    const aud = $('#lb-audio'); aud.pause(); aud.removeAttribute('src'); aud.load();
    $('#lb-img').removeAttribute('src');
    $('#lb-pdf').removeAttribute('src');
    $('#lb-text').textContent = '';
    lightboxFile = null;
  }

  $('#lb-close').addEventListener('click', closeLightbox);
  lightbox.addEventListener('click', e => { if (e.target === lightbox || e.target.classList.contains('lb-content')) closeLightbox(); });

  // Keyboard navigation shortcuts
  document.addEventListener('keydown', e => {
    if (lightbox.classList.contains('hidden')) return;

    if (e.key === 'Escape') {
      closeLightbox();
    } else if (e.key === 'ArrowLeft') {
      if (!lightboxFile) return;
      const idx = visibleFiles.findIndex(item => item.file_key === lightboxFile.file_key);
      if (idx > 0) openLightbox(visibleFiles[idx - 1]);
    } else if (e.key === 'ArrowRight') {
      if (!lightboxFile) return;
      const idx = visibleFiles.findIndex(item => item.file_key === lightboxFile.file_key);
      if (idx !== -1 && idx < visibleFiles.length - 1) openLightbox(visibleFiles[idx + 1]);
    }
  });

  // Slider buttons listeners
  $('#lb-prev').addEventListener('click', e => {
    e.stopPropagation();
    if (!lightboxFile) return;
    const idx = visibleFiles.findIndex(item => item.file_key === lightboxFile.file_key);
    if (idx > 0) openLightbox(visibleFiles[idx - 1]);
  });

  $('#lb-next').addEventListener('click', e => {
    e.stopPropagation();
    if (!lightboxFile) return;
    const idx = visibleFiles.findIndex(item => item.file_key === lightboxFile.file_key);
    if (idx !== -1 && idx < visibleFiles.length - 1) openLightbox(visibleFiles[idx + 1]);
  });

  $('#lb-delete').addEventListener('click', () => {
    if (lightboxFile) {
      deleteFile(lightboxFile);
    }
  });

  // Filter controls listeners
  $('#filter-sort').addEventListener('change', render);
  $('#filter-size').addEventListener('change', render);
  $('#filter-extension').addEventListener('input', render);

  /* ===================================================================
     BULK ACTIONS EVENTS
     =================================================================== */
  $('#bulk-cancel').addEventListener('click', () => {
    selectedKeys.clear();
    // Reset classes and states
    $$('.fc-checkbox, .fr-checkbox').forEach(cb => {
      cb.checked = false;
      const label = cb.closest('label');
      if (label) label.classList.remove('active');
      const card = cb.closest('.file-card, .list-row');
      if (card) card.classList.remove('selected');
    });
    updateBulkBar();
  });

  $('#bulk-select-all').addEventListener('click', () => {
    const allSelected = visibleFiles.length > 0 && visibleFiles.every(f => selectedKeys.has(f.file_key));
    if (allSelected) {
      visibleFiles.forEach(f => selectedKeys.delete(f.file_key));
    } else {
      visibleFiles.forEach(f => selectedKeys.add(f.file_key));
    }
    render();
  });

  $('#bulk-download').addEventListener('click', () => {
    if (selectedKeys.size === 0) return;
    const keys = Array.from(selectedKeys);
    const filesToDownload = allFiles.filter(f => selectedKeys.has(f.file_key));
    
    toast(`Mengunduh ${filesToDownload.length} berkas...`);

    filesToDownload.forEach((f, index) => {
      setTimeout(() => {
        const a = document.createElement('a');
        a.href = `/api/download/${f.file_key}`;
        a.download = f.filename;
        a.click();
      }, index * 400); // 400ms delay to prevent browser blockages
    });
  });

  $('#bulk-delete').addEventListener('click', async () => {
    if (selectedKeys.size === 0) return;
    if (!await showConfirm('Hapus Berkas Terpilih', `Apakah Anda yakin ingin menghapus ${selectedKeys.size} berkas yang terpilih secara permanen?`)) return;

    const keys = Array.from(selectedKeys);
    let successCount = 0;
    let failCount = 0;

    toast(`Menghapus ${keys.length} berkas...`);

    await Promise.all(keys.map(async key => {
      try {
        const res = await fetch(`/api/files/${key}`, { method: 'DELETE' });
        const d = await res.json();
        if (d.success) successCount++;
        else failCount++;
      } catch {
        failCount++;
      }
    }));

    selectedKeys.clear();
    toast(`Berhasil menghapus ${successCount} berkas.${failCount > 0 ? ` Gagal: ${failCount}` : ''}`);
    loadFiles();
    loadStats();
  });

  // Reset drive listener
  $('#btn-reset-drive').addEventListener('click', async () => {
    if (!await showConfirm('Reset Drive', 'PERINGATAN: Tindakan ini akan menghapus seluruh berkas Anda secara permanen dari basis data dan cache lokal. Apakah Anda yakin ingin melanjutkan?')) return;
    
    try {
      $('#btn-reset-drive').disabled = true;
      const res = await fetch('/api/reset', { method: 'POST' });
      const d = await res.json();
      if (d.success) {
        toast('Drive berhasil direset bersih.');
        settingsModal.classList.add('hidden');
        selectedKeys.clear();
        loadFiles();
        loadStats();
      } else {
        toast(d.error || 'Gagal melakukan reset.');
      }
    } catch {
      toast('Eror saat mereset drive.');
    } finally {
      $('#btn-reset-drive').disabled = false;
    }
  });

  /* ===================================================================
     BOOT
     =================================================================== */
  init();
})();
