// ── Popup script ──────────────────────────────────────────────────────────────
'use strict';

const $ = id => document.getElementById(id);

// Keys sesi yang harus di-reset saat memulai proses baru
const SESSION_KEYS = [
  'solveRetryCount', 'precheckError', 'precheckCode',
  'precheckRetryCount', 'pendingTabId', 'prelabPayload',
];

// ── Platform detection ────────────────────────────────────────────────────────
const LMS_HOSTS = {
  'praktikum.gunadarma.ac.id': 'ilab',
  'v-class.gunadarma.ac.id':   'vclass',
};

async function detectPlatform() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.url) return { platform: 'unknown', tab };
    const host = new URL(tab.url).hostname;
    return { platform: LMS_HOSTS[host] || 'unknown', tab };
  } catch {
    return { platform: 'unknown', tab: null };
  }
}

// ── Init ──────────────────────────────────────────────────────────────────────
(async () => {
  const { platform } = await detectPlatform();
  const badge = $('platformBadge');
  const info  = $('infoBox');
  const btn   = $('sendBtn');

  // Platform badge
  badge.className = `platform-badge ${platform}`;
  const labels = { ilab: 'iLab', vclass: 'vClass', unknown: '—' };
  badge.textContent = labels[platform];

  if (platform === 'unknown') {
    info.style.display = 'block';
    info.textContent = 'Buka halaman quiz di praktikum.gunadarma.ac.id terlebih dahulu.';
    btn.disabled = true;
    btn.textContent = 'Bukan halaman LMS';
  } else if (platform === 'vclass') {
    info.style.display = 'block';
    info.innerHTML = 'vClass belum dioptimasi, pakai logika iLab sebagai fallback.';
  }
})();

// Load saved prompt
chrome.storage.local.get(['prompt'], d => {
  if (d.prompt) $('prompt').value = d.prompt;
});

// ── Send / Start ──────────────────────────────────────────────────────────────
$('sendBtn').addEventListener('click', async () => {
  const prompt = $('prompt').value.trim();
  chrome.storage.local.set({ prompt });

  $('sendBtn').disabled = true;
  setStatus('Menyiapkan...');

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) throw new Error('Tab tidak ditemukan');

    // Bersihkan state sesi lama sebelum mulai ─ hindari state corrupt dari run sebelumnya
    await new Promise(res => chrome.storage.local.remove(SESSION_KEYS, res));

    // Inject content.js (idempotent karena ada guard window.__prelabAI)
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });

    // Set state sesi baru
    await chrome.storage.local.set({
      isBatching: true,
      activeMode: 'solve',
      batchTabId: tab.id,
      batchPrompt: prompt,
      ai: 'gemini',
    });

    chrome.tabs.sendMessage(tab.id, {
      action : 'START',
      ai     : 'gemini',
      mode   : 'solve',
      prompt,
    }, () => {
      // Abaikan lastError — content script mungkin belum ready, background akan relay ulang
      void chrome.runtime.lastError;
    });

    setStatus('Berjalan otomatis...', 'ok');
    setTimeout(() => window.close(), 1000);

  } catch (e) {
    console.error('[Prelab Popup] Start error:', e);
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
});

function setStatus(msg, type = '') {
  const el = $('status');
  el.textContent = msg;
  el.className   = 'status ' + type;
}
