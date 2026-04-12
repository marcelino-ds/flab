const $ = id => document.getElementById(id);

// Load saved prefs
chrome.storage.local.get(['prompt', 'runMode'], d => {
  if (d.prompt) $('prompt').value = d.prompt;
  if (d.runMode) $('runMode').value = d.runMode;
});

// Send
$('sendBtn').addEventListener('click', async () => {
  const prompt = $('prompt').value.trim();
  const runMode = $('runMode').value;
  chrome.storage.local.set({ prompt, runMode });

  $('sendBtn').disabled = true;
  setStatus('Menyiapkan...');

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });

    await chrome.storage.local.set({ isBatching: true, activeMode: runMode, batchTabId: tab.id, batchPrompt: prompt, batchScreenshots: [] });

    chrome.tabs.sendMessage(tab.id, {
      action : 'START',
      ai     : 'gemini',
      mode   : runMode,
      prompt
    });

    setStatus('Berjalan otomatis...', 'ok');
    setTimeout(() => window.close(), 1000);

  } catch(e) {
    setStatus('Error: Buka halaman web dulu', 'err');
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
