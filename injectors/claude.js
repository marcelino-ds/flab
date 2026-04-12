// ── Claude.ai injector ────────────────────────────────────────────────────────

(async () => {
  const session = await chrome.storage.session.get(['prelabPayload','pendingTabId']);
  const payload  = session.prelabPayload;

  if (!payload) return;
  if (payload.ai !== 'claude') return;

  // Clear
  await chrome.storage.session.remove(['prelabPayload','pendingTabId']);

  // Tunggu ProseMirror editor siap
  const inputEl = await waitFor(() =>
    document.querySelector('.ProseMirror[contenteditable="true"]') ||
    document.querySelector('div[contenteditable="true"][data-placeholder]') ||
    document.querySelector('div[contenteditable="true"]')
  , 15000);

  if (!inputEl) { console.warn('[PrelabAI] Claude input not found'); return; }

  if (payload.type === 'text') {
    await injectText(inputEl, buildPromptText(payload));
  } else {
    await injectImage(inputEl, payload.dataUrl, payload.prompt);
  }

  await sleep(700);
  clickSend();
})();

// ── Text injection ─────────────────────────────────────────────────────────────
async function injectText(el, text) {
  el.focus();
  await sleep(200);
  // Clear existing content
  document.execCommand('selectAll', false);
  document.execCommand('delete', false);
  // Paste via clipboard
  await writeClipboard(text);
  document.execCommand('paste', false);
  // Trigger React's synthetic events
  el.dispatchEvent(new InputEvent('input', { bubbles: true, data: text }));
  await sleep(400);
}

// ── Image injection ────────────────────────────────────────────────────────────
async function injectImage(inputEl, dataUrl, promptText) {
  const blob = dataURLtoBlob(dataUrl);
  const file = new File([blob], 'soal.png', { type: 'image/png' });

  // Cari file input attachment claude.ai
  const fileInput = await waitFor(() => {
    const inputs = [...document.querySelectorAll('input[type="file"]')];
    return inputs.find(i => i.accept?.includes('image') || i.multiple !== false) || inputs[0];
  }, 8000);

  if (fileInput) {
    const dt = new DataTransfer();
    dt.items.add(file);
    fileInput.files = dt.files;
    fileInput.dispatchEvent(new Event('change', { bubbles: true }));
    await sleep(2000); // tunggu upload preview muncul
  } else {
    // Fallback: paste image dari clipboard
    await writeClipboardImage(blob);
    inputEl.focus();
    await sleep(300);
    inputEl.dispatchEvent(new ClipboardEvent('paste', {
      clipboardData: await buildClipboardData(blob),
      bubbles: true
    }));
    await sleep(1500);
  }

  // Tambah teks prompt setelah gambar
  const promptLine = buildPromptPrefix(promptText);
  inputEl.focus();
  await sleep(200);
  await writeClipboard(promptLine);
  document.execCommand('paste', false);
  await sleep(300);
}

// ── Klik Send ──────────────────────────────────────────────────────────────────
function clickSend() {
  const selectors = [
    'button[aria-label="Send message"]',
    'button[data-testid="send-button"]',
    'button[aria-label*="Send" i]',
    'button[type="submit"]',
  ];
  for (const sel of selectors) {
    const btn = document.querySelector(sel);
    if (btn && !btn.disabled && btn.offsetParent !== null) {
      btn.click();
      return;
    }
  }
  // Fallback: Enter
  const inputEl =
    document.querySelector('.ProseMirror[contenteditable="true"]') ||
    document.querySelector('div[contenteditable="true"]');
  if (inputEl) {
    inputEl.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Enter', keyCode: 13, which: 13, bubbles: true
    }));
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────────
function buildPromptText({ text, prompt }) {
  const prefix = prompt
    ? prompt + '\n\nBerikut soalnya:\n\n'
    : 'Tolong jawab soal berikut dengan lengkap, sertakan rumus dan langkah penyelesaian:\n\n';
  return prefix + text;
}

function buildPromptPrefix(prompt) {
  return '\n\n' + (prompt
    ? prompt + '\n\nTolong analisis gambar soal di atas dan jawab dengan lengkap.'
    : 'Tolong analisis gambar soal di atas dan jawab dengan lengkap, sertakan rumus dan langkah penyelesaian.');
}

function dataURLtoBlob(dataUrl) {
  const [header, data] = dataUrl.split(',');
  const mime = header.match(/:(.*?);/)[1];
  const bytes = atob(data);
  const buf   = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) buf[i] = bytes.charCodeAt(i);
  return new Blob([buf], { type: mime });
}

async function writeClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text; ta.style.cssText = 'position:fixed;opacity:0';
    document.body.appendChild(ta);
    ta.select(); document.execCommand('copy'); ta.remove();
  }
}

async function writeClipboardImage(blob) {
  try {
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
  } catch(e) { console.warn('[PrelabAI] clipboard image write failed', e); }
}

async function buildClipboardData(blob) {
  try {
    const dt = new DataTransfer();
    dt.items.add(new File([blob], 'soal.png', { type: 'image/png' }));
    return dt;
  } catch { return new DataTransfer(); }
}

function waitFor(fn, timeout = 10000, interval = 300) {
  return new Promise(res => {
    const start = Date.now();
    const id = setInterval(() => {
      const v = fn();
      if (v) { clearInterval(id); res(v); }
      else if (Date.now() - start > timeout) { clearInterval(id); res(null); }
    }, interval);
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
