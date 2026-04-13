const $ = id => document.getElementById(id);

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
  const { platform, tab } = await detectPlatform();
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

// Load saved prefs
chrome.storage.local.get(['prompt'], d => {
  if (d.prompt) $('prompt').value = d.prompt;
});

// Send
$('sendBtn').addEventListener('click', async () => {
  const prompt = $('prompt').value.trim();
  chrome.storage.local.set({ prompt });

  $('sendBtn').disabled = true;
  setStatus('Menyiapkan...');

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });

    await chrome.storage.local.set({ isBatching: true, activeMode: 'solve', batchTabId: tab.id, batchPrompt: prompt });

    chrome.tabs.sendMessage(tab.id, {
      action : 'START',
      ai     : 'gemini',
      mode   : 'solve',
      prompt
    });

    setStatus('Berjalan otomatis...', 'ok');
    setTimeout(() => window.close(), 1000);

  } catch(e) {
    setStatus('Error: Buka halaman LMS dulu', 'err');
    $('sendBtn').disabled = false;
  }
});

// Konfirmasi dari content script
chrome.runtime.onMessage.addListener(msg => {
  if (msg.action === 'ERROR') { setStatus('Error: ' + msg.msg, 'err'); $('sendBtn').disabled = false; }
});

function setStatus(msg, type = '') {
  const el = $('status');
  el.textContent = msg;
  el.className   = 'status ' + type;
}
