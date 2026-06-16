// ── Popup script ──────────────────────────────────────────────────────────────
'use strict';

import { escapeHtml } from '../shared/util.js';
import { PROVIDERS, DEFAULT_PROVIDER } from '../shared/providers.js';

const $ = id => document.getElementById(id);

// Daftar KANONIK semua key state sesi (HARUS identik dengan STALE_KEYS di background.js).
// TIDAK termasuk 'errorLogs' & 'prompt' yang sengaja persisten antar sesi.
const SESSION_KEYS = [
  'isBatching', 'batchTabId', 'pendingTabId', 'flabPayload',
  'activeMode', 'batchPrompt', 'ai', 'current', 'total',
  'solveRetryCount', 'precheckError', 'precheckCode', 'precheckRetryCount', 'checkRetryCount', 'solveDispatchCount', 'sessionStats',
];

// Deteksi Moodle dengan memeriksa penanda DOM di tab aktif (lintas-kampus, bukan
// per-hostname). Dijalankan via scripting.executeScript di tab yang sedang dibuka.
async function detectPlatform() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id || !tab.url || !/^https?:/.test(tab.url)) return { platform: 'unknown', tab };
    const [res] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        const byBody = document.body && /(^|\s)(path-mod-quiz|format-|pagelayout-)/.test(document.body.className);
        const byDom = !!document.querySelector('.que, #responseform, #page-mod-quiz-attempt, [id^="question-"]');
        const byPath = location.pathname.includes('/mod/quiz/');
        return !!(byBody || byDom || byPath);
      },
    });
    return { platform: res?.result ? 'moodle' : 'unknown', tab };
  } catch {
    return { platform: 'unknown', tab: null };
  }
}

// ── Init ──────────────────────────────────────────────────────────────────────
(async () => {
  const { platform } = await detectPlatform();
  const badge = $('platformBadge');
  const btn   = $('sendBtn');

  // Platform badge
  badge.className = `platform-badge ${platform}`;
  const labels = { moodle: 'Moodle', unknown: '—' };
  badge.textContent = labels[platform];

  if (platform === 'unknown') {
    btn.disabled = true;
    btn.textContent = 'Bukan Halaman Moodle';
    setStatus('Buka halaman kuis Moodle');
  }
})();

// Custom dropdown: bangun menu dari registry, sinkronkan pilihan ke hidden
// input #providerSelect (yang dibaca handler START). Native <select> option list
// tidak bisa di-CSS, jadi kita render trigger + menu sendiri.
(function populateProviders() {
  const hidden = $('providerSelect');
  const dropdown = $('providerDropdown');
  const trigger = $('providerTrigger');
  const label = $('providerLabel');
  const menu = $('providerMenu');
  if (!hidden || !dropdown || !trigger || !label || !menu) return;

  const providers = Object.values(PROVIDERS);
  const checkSvg = '<svg class="dd-check" width="13" height="13" viewBox="0 0 13 13" aria-hidden="true"><path d="M2.5 7L5 9.5L10.5 3.5" stroke="currentColor" stroke-width="1.8" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>';

  function setValue(id) {
    const p = PROVIDERS[id] || PROVIDERS[DEFAULT_PROVIDER];
    hidden.value = p.id;
    label.textContent = p.label + (p.verified ? '' : ' (beta)');
    menu.querySelectorAll('.dd-option').forEach(el => {
      el.classList.toggle('selected', el.dataset.value === p.id);
    });
    // Beri tahu seksi Mode API agar key input & link mengikuti provider terpilih.
    window.__flabOnProviderChange?.(p.id);
  }

  menu.innerHTML = providers.map(p =>
    `<div class="dd-option" data-value="${escapeHtml(p.id)}" role="option" tabindex="0">` +
    `<span>${escapeHtml(p.label)}${p.verified ? '' : ' (beta)'}</span>${checkSvg}</div>`
  ).join('');

  const close = () => dropdown.classList.remove('open');

  trigger.addEventListener('click', e => {
    e.stopPropagation();
    dropdown.classList.toggle('open');
  });

  menu.querySelectorAll('.dd-option').forEach(opt => {
    const choose = () => { setValue(opt.dataset.value); close(); };
    opt.addEventListener('click', choose);
    opt.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); choose(); }
    });
  });

  document.addEventListener('click', e => {
    if (!dropdown.contains(e.target)) close();
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') close();
  });

  chrome.storage.local.get(['lastProvider'], d => {
    setValue(d.lastProvider && PROVIDERS[d.lastProvider] ? d.lastProvider : DEFAULT_PROVIDER);
  });
})();

// Mode API: toggle + key per-provider. Key disimpan terpisah per provider
// (apiKey_gemini/_chatgpt/_claude) agar ganti provider tak menimpa key lain.
(function setupApiMode() {
  const toggle = $('apiToggle');
  const wrap = $('apiKeyWrap');
  const keyInput = $('apiKey');
  const link = $('apiKeyLink');
  if (!toggle || !wrap || !keyInput || !link) return;

  let currentProvider = DEFAULT_PROVIDER;

  const syncVisibility = () => { wrap.style.display = toggle.checked ? 'flex' : 'none'; };

  // Dipanggil dropdown saat provider berganti — muat key & arahkan link provider itu.
  window.__flabOnProviderChange = id => {
    currentProvider = id;
    const p = PROVIDERS[id] || PROVIDERS[DEFAULT_PROVIDER];
    link.href = p.api?.keyUrl || '#';
    link.style.display = p.api ? 'inline' : 'none';
    chrome.storage.local.get([`apiKey_${id}`], d => {
      keyInput.value = d[`apiKey_${id}`] || '';
    });
  };

  toggle.addEventListener('change', () => {
    syncVisibility();
    chrome.storage.local.set({ apiMode: toggle.checked });
  });

  // Simpan key saat user selesai mengetik (per provider terpilih).
  keyInput.addEventListener('change', () => {
    chrome.storage.local.set({ [`apiKey_${currentProvider}`]: keyInput.value.trim() });
  });
  keyInput.addEventListener('blur', () => {
    chrome.storage.local.set({ [`apiKey_${currentProvider}`]: keyInput.value.trim() });
  });

  chrome.storage.local.get(['apiMode'], d => {
    toggle.checked = !!d.apiMode;
    syncVisibility();
  });
})();

// Load saved prompt
chrome.storage.local.get(['prompt'], d => {
  if (d.prompt) $('prompt').value = d.prompt;
});

// ── Send / Start ──────────────────────────────────────────────────────────────
$('sendBtn').addEventListener('click', async () => {
  const prompt = $('prompt').value.trim();
  const ai = $('providerSelect')?.value || 'gemini';
  chrome.storage.local.set({ prompt, lastProvider: ai });

  $('sendBtn').disabled = true;
  setStatus('Menyiapkan...');

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) throw new Error('Tab tidak ditemukan');

    // Bersihkan state sesi lama sebelum mulai ─ hindari state corrupt dari run sebelumnya
    await new Promise(res => chrome.storage.local.remove(SESSION_KEYS, res));

    // Inject content.js (idempotent karena ada guard window.__flabAI)
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });

    // Set state sesi baru
    await chrome.storage.local.set({
      isBatching: true,
      activeMode: 'solve',
      batchTabId: tab.id,
      batchPrompt: prompt,
      ai,
    });

    chrome.tabs.sendMessage(tab.id, {
      action : 'START',
      ai,
      mode   : 'solve',
      prompt,
    }, () => {
      // Abaikan lastError — content script mungkin belum ready, background akan relay ulang
      void chrome.runtime.lastError;
    });

    setStatus('Berjalan otomatis...', 'ok');
    setTimeout(() => window.close(), 1000);

  } catch (e) {
    console.error('[FLAB Popup] Start error:', e);
    setStatus('Error: Buka halaman LMS dulu', 'err');
    $('sendBtn').disabled = false;
  }
});

// Error dari content script
chrome.runtime.onMessage.addListener(msg => {
  if (msg.action === 'ERROR') {
    setStatus('Error: ' + msg.msg, 'err');
    $('sendBtn').disabled = false;
  }
  if (msg.action === 'PROGRESS_UPDATE') {
    setStatus(`Soal ${msg.current || '?'} dari ${msg.total || '?'}...`, 'ok');
  }
});

function setStatus(msg, type = '') {
  const el = $('status');
  el.textContent = msg;
  el.className   = 'status ' + type;
}

// ── Error log viewer ────────────────────────────────────────────────────────────
function renderLogs(logs) {
  const list = $('logList');

  if (!logs || logs.length === 0) {
    list.innerHTML = `<div style="text-align:center;color:#8E8E93;font-size:11px;padding:12px;">Belum ada log error.</div>`;
    return;
  }

  // Terbaru di atas
  const sorted = [...logs].sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));

  const head = `
    <div class="log-head">
      <span style="font-size:11px;color:#8E8E93;font-weight:600;">${sorted.length} log error</span>
      <span class="log-clear" id="logClear">Hapus Semua</span>
    </div>`;

  const entries = sorted.map(log => `
    <div class="log-entry">
      <div class="log-date">${escapeHtml(log.date || '')}</div>
      <div class="log-q">${escapeHtml(log.question || '(tanpa teks soal)')}</div>
      ${log.error ? `<div class="log-err">${escapeHtml(log.error)}</div>` : ''}
      ${log.screenshot ? `<img class="log-img" src="${escapeHtml(log.screenshot)}" alt="screenshot error" />` : ''}
    </div>`).join('');

  list.innerHTML = head + entries;

  $('logClear').addEventListener('click', () => {
    chrome.storage.local.remove(['errorLogs'], () => renderLogs([]));
  });

  list.querySelectorAll('.log-img').forEach(img => {
    img.addEventListener('click', () => img.classList.toggle('expanded'));
  });
}

$('logBtn').addEventListener('click', () => {
  const list = $('logList');
  const opening = list.style.display === 'none';

  if (opening) {
    chrome.storage.local.get(['errorLogs'], d => renderLogs(d.errorLogs || []));
    list.style.display = 'flex';
    $('logBtn').textContent = 'Sembunyikan Log';
  } else {
    list.style.display = 'none';
    $('logBtn').textContent = 'Lihat Log Error';
  }
});
