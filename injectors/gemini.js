// ── Gemini injector ─────────────────────────────────────────────────────────
'use strict';

// ── Bootstrap ─────────────────────────────────────────────────────────────────
(async () => {
  const session = await chrome.storage.local.get(['prelabPayload', 'pendingTabId']);
  const payload = session.prelabPayload;
  const myTabId = await getMyTabId();

  if (!payload)                              { console.log('[PrelabAI] No payload – skip.'); return; }
  if (payload.ai !== 'gemini')               { return; }
  if (session.pendingTabId !== myTabId)      { console.log('[PrelabAI] Tab ID mismatch – skip.'); return; }

  await chrome.storage.local.remove(['prelabPayload', 'pendingTabId']);
  console.log('[PrelabAI] Payload received, type:', payload.type);

  // ── Status-UI overlay ──────────────────────────────────────────────────────
  const ui = buildGeminiUI();
  let aborted = false;

  ui.stopBtn.addEventListener('click', () => {
    aborted = true;
    setGStatus('❌ Dibatalkan.', 100, '#ff453a');
    setTimeout(() => ui.root.remove(), 3000);
  });

  const setGStatus = (msg, pct = null, barColor = null) => {
    if (aborted) return;
    ui.status.innerHTML = msg;
    if (pct !== null) ui.bar.style.width = pct + '%';
    if (barColor) ui.bar.style.background = barColor;
  };

  // ── Wait for Gemini editor ─────────────────────────────────────────────────
  const inputEl = await waitFor(() =>
    document.querySelector('rich-textarea .ql-editor[contenteditable="true"]') ||
    document.querySelector('.ql-editor[contenteditable="true"]') ||
    document.querySelector('div[aria-label*="message" i][contenteditable="true"]') ||
    document.querySelector('rich-textarea div[contenteditable="true"]') ||
    document.querySelector('div[contenteditable="true"]')
  , 20000);

  if (!inputEl) {
    setGStatus('❌ Editor Gemini tidak ditemukan.', 100, '#ff453a');
    setTimeout(() => ui.root.remove(), 5000);
    return;
  }
  if (aborted) return;
  setGStatus('✅ Editor siap…', 10);

  // ── Dispatch payload type ──────────────────────────────────────────────────
  const autoSolveRules = buildAutoSolveRules();

  if (payload.type === 'text') {
    setGStatus('Menempelkan teks…', 50);
    await injectText(inputEl, buildTextPrompt(payload));
  } else if (payload.type === 'batch_images') {
    setGStatus(`Memuat ${payload.dataUrls.length} gambar…`, 20);
    await injectMultipleImages(inputEl, payload.dataUrls, payload.prompt, setGStatus, () => aborted);
  } else if (payload.type === 'solve_image') {
    setGStatus('Mode Jawab Otomatis – memuat gambar…', 30);
    await injectImage(inputEl, payload.dataUrl, (payload.prompt || '') + autoSolveRules, setGStatus, () => aborted);
  } else {
    setGStatus('Memuat gambar tunggal…', 30);
    await injectImage(inputEl, payload.dataUrl, payload.prompt || '', setGStatus, () => aborted);
  }

  if (aborted) return;
  setGStatus('🚀 Mengirim…', 85);
  await sleep(600);

  const sent = clickSend();
  if (!sent) {
    setGStatus('❌ Gagal klik tombol Send.', 100, '#ff453a');
    setTimeout(() => ui.root.remove(), 5000);
    return;
  }

  setGStatus('⏳ Menunggu respons AI…', 90);
  if (payload.type === 'solve_image') {
    await observeAndExtractJson(setGStatus, () => aborted);
  } else {
    setTimeout(() => ui.root.remove(), 4000);
  }
})();

// ── Auto-solve prompt rules ────────────────────────────────────────────────────
function buildAutoSolveRules() {
  return `

INSTRUKSI WAJIB – HANYA BALAS DENGAN 1 BLOK JSON INI, TIDAK ADA TEKS LAIN:
\`\`\`json
{ "jawaban": "[TEKS_JAWABAN]", "index_pilihan": [NOMOR] }
\`\`\`
Aturan pengisian:
- Soal PILIHAN GANDA → "jawaban": teks opsi PERSIS seperti tertulis (tanpa huruf "A."), "index_pilihan": urutan opsi dari atas (1/2/3/4/5).
- Soal ISIAN / KODING → "jawaban": isi/kode lengkap persis (gunakan \\n untuk baris baru), "index_pilihan": 0.
DILARANG menulis analisis, penjelasan, atau teks apapun di luar blok JSON.`;
}

// ── JSON extractor (waits for AI streaming to finish) ─────────────────────────
async function observeAndExtractJson(setGStatus, isAborted) {
  let ticks = 0;
  const MAX_TICKS = 240; // 4 menit
  
  return new Promise(resolve => {
    const timer = setInterval(() => {
      if (isAborted?.()) { clearInterval(timer); resolve(); return; }

      // Ambil bubble respons AI terakhir (bukan seluruh page agar tidak nyangkut di history)
      const bubbles = document.querySelectorAll(
        'model-response, .model-response-text, [data-message-author-role="model"], message-content'
      );
      const node  = bubbles.length > 0 ? bubbles[bubbles.length - 1] : document.body;
      const text  = node.innerText || node.textContent || '';
      if (text.length < 5) return;

      // Cari pasangan kurung kurawal paling luar
      const s = text.indexOf('{');
      const e = text.lastIndexOf('}');
      if (s === -1 || e <= s) { tick(); return; }

      const block = text.slice(s, e + 1);
      // Pastikan block mengandung kata "jawaban" dan bukan blok prompt kita sendiri
      if (!block.includes('jawaban') || block.includes('TEKS_JAWABAN') || block.includes('[NOMOR]')) { tick(); return; }

      // Normalise smart-quotes before JSON.parse
      let safe = block
        .replace(/[""]/g, '"')
        .replace(/['']/g, "'")
        .replace(/\\'/g, "'");

      let jawaban = '', index_pilihan = 0, ok = false;

      try {
        const obj = JSON.parse(safe);
        jawaban        = String(obj.jawaban ?? '').trim();
        index_pilihan  = Number(obj.index_pilihan ?? 0);
        ok             = true;
      } catch {
        // Fallback regex jika JSON.parse gagal (misal trailing comma, dll)
        const jm = block.match(/jawaban["'\s]*:\s*([^\n,}]{1,500})/i);
        const im = block.match(/index_pilihan["'\s]*:\s*(\d+)/i);
        if (jm) {
          jawaban       = jm[1].replace(/^["'\u201c\u2018]|["'\u201d\u2019]$/g, '').trim();
          index_pilihan = im ? parseInt(im[1]) : 0;
          ok            = true;
        }
      }

      if (ok && jawaban && jawaban.toLowerCase() !== 'null' && jawaban.toLowerCase() !== 'undefined') {
        clearInterval(timer);
        const preview = jawaban.length > 25 ? '(koding/isian panjang)' : jawaban;
        setGStatus(`🧩 Jawaban: <b>${preview}</b>${index_pilihan ? ` · opsi ke-${index_pilihan}` : ''}`, 100);
        chrome.runtime.sendMessage({ action: 'SOLVER_JSON_RESULT', data: { jawaban, index_pilihan } });
        resolve();
        return;
      }

      tick();
      function tick() {
        ticks++;
        // Live countdown tiap 30 detik agar user tahu bot masih hidup
        if (ticks % 30 === 0 && ticks < MAX_TICKS) {
          const mnt = Math.floor(ticks / 60);
          const dtk = ticks % 60;
          setGStatus(`⏳ AI sedang berpikir... ${mnt}m ${dtk}s / 4m`, Math.round(ticks / MAX_TICKS * 85));
        }
        if (ticks > MAX_TICKS) {
          clearInterval(timer);
          setGStatus('⏰ Timeout! Meminta LMS untuk retry soal ini...', 100, '#ff9f0a');
          // Kirim sinyal timeout ke background → background relay ke LMS → LMS retry soal
          chrome.runtime.sendMessage({ action: 'SOLVER_TIMEOUT' });
          setTimeout(() => resolve(), 1500);
        }
      }
    }, 1000);
  });
}

// ── Text injection (3-method fallback) ────────────────────────────────────────
async function injectText(el, text) {
  el.focus();
  await sleep(200);

  // Method 1: Paste event
  try {
    const dt = new DataTransfer();
    dt.setData('text/plain', text);
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true }));
    await sleep(350);
    if (el.textContent.trim().length > 0) return true;
  } catch { /**/ }

  // Method 2: execCommand
  try {
    document.execCommand('insertText', false, text);
    el.dispatchEvent(new InputEvent('input', { bubbles: true, data: text, inputType: 'insertText' }));
    await sleep(350);
    if (el.textContent.trim().length > 0) return true;
  } catch { /**/ }

  // Method 3: Direct DOM (last resort)
  try {
    el.textContent = text;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  } catch { /**/ }

  console.warn('[PrelabAI] All text-inject methods failed.');
  return false;
}

// ── Single image injection ─────────────────────────────────────────────────────
async function injectImage(inputEl, dataUrl, promptText, setGStatus = () => {}, isAborted = () => false) {
  const blob = dataURLtoBlob(dataUrl);
  const ext  = blob.type === 'image/jpeg' ? 'jpg' : 'png';
  const dt   = new DataTransfer();
  dt.items.add(new File([blob], `soal.${ext}`, { type: blob.type }));

  if (isAborted()) return;
  setGStatus('Mencari jalur upload gambar…', 40);

  const fileInput = await waitFor(
    () => document.querySelector('input[type="file"][accept*="image"]') || document.querySelector('input[type="file"]'),
    4000
  );

  if (fileInput) {
    setGStatus('Mengunggah gambar via file input…', 60);
    fileInput.files = dt.files;
    fileInput.dispatchEvent(new Event('change', { bubbles: true }));
  } else {
    setGStatus('Menyisipkan gambar via paste…', 60);
    inputEl.focus();
    inputEl.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true }));
  }
  await sleep(2000);

  if (isAborted()) return;
  if (promptText) {
    setGStatus('Menambahkan prompt…', 80);
    const freshEl = await waitFor(
      () => document.querySelector('rich-textarea .ql-editor[contenteditable="true"]') ||
            document.querySelector('.ql-editor[contenteditable="true"]'),
      5000
    );
    if (freshEl) await injectText(freshEl, '\n' + promptText);
  }
}

// ── Bulk image injection ───────────────────────────────────────────────────────
async function injectMultipleImages(inputEl, dataUrls, promptText, setGStatus, isAborted) {
  const dt = new DataTransfer();

  for (let i = 0; i < dataUrls.length; i++) {
    if (isAborted?.()) return;
    setGStatus(`Memuat gambar ${i + 1}/${dataUrls.length}…`, 20 + Math.floor((i / dataUrls.length) * 30));
    const blob = dataURLtoBlob(dataUrls[i]);
    const ext  = blob.type === 'image/jpeg' ? 'jpg' : 'png';
    dt.items.add(new File([blob], `soal_${i + 1}.${ext}`, { type: blob.type }));
  }

  if (isAborted?.()) return;
  setGStatus(`Mengirim ${dataUrls.length} gambar ke Gemini…`, 55);

  const fileInput = await waitFor(
    () => document.querySelector('input[type="file"][accept*="image"]') || document.querySelector('input[type="file"]'),
    4000
  );

  if (fileInput) {
    fileInput.files = dt.files;
    fileInput.dispatchEvent(new Event('change', { bubbles: true }));
  } else {
    inputEl.focus();
    inputEl.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true }));
  }
  await sleep(3000);

  if (isAborted?.()) return;
  if (promptText) {
    setGStatus('Menambahkan prompt akhir…', 80);
    const freshEl = await waitFor(
      () => document.querySelector('rich-textarea .ql-editor[contenteditable="true"]') ||
            document.querySelector('.ql-editor[contenteditable="true"]'),
      5000
    );
    if (freshEl) await injectText(freshEl, '\n' + promptText);
  }
}

// ── Click send button ──────────────────────────────────────────────────────────
function clickSend() {
  const selectors = [
    'button[aria-label="Send message"]',
    'button[aria-label="Kirim pesan"]',
    'button[aria-label*="Send" i]',
    'button[aria-label*="Kirim" i]',
    'button[data-mat-icon-name="send"]',
    'button[jsname][data-ogsr-up]',
    'button.send-button',
    '[data-test-id="send-button"]',
  ];

  for (const sel of selectors) {
    for (const btn of document.querySelectorAll(sel)) {
      if (!btn.disabled && !btn.hasAttribute('disabled') && btn.offsetParent !== null) {
        btn.click();
        return true;
      }
    }
  }

  // Fallback: Enter key on editor
  const editor =
    document.querySelector('rich-textarea .ql-editor') ||
    document.querySelector('.ql-editor[contenteditable="true"]') ||
    document.querySelector('div[contenteditable="true"]');
  if (editor) {
    editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, bubbles: true }));
    return true;
  }
  return false;
}

// ── UI helpers ────────────────────────────────────────────────────────────────
function buildGeminiUI() {
  const root = document.createElement('div');
  Object.assign(root.style, {
    position: 'fixed', bottom: '20px', left: '20px',
    background: 'rgba(20,20,22,0.92)', backdropFilter: 'blur(16px)',
    border: '1px solid rgba(255,255,255,0.1)', borderRadius: '14px',
    padding: '14px 18px', zIndex: '2147483647', color: '#fff',
    fontFamily: 'Inter, -apple-system, sans-serif', fontSize: '13px',
    boxShadow: '0 16px 48px rgba(0,0,0,0.7)', width: '270px',
  });
  root.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">
      <span style="font-weight:700;font-size:14px;color:#32d74b;text-shadow:0 0 10px rgba(50,215,75,0.35);">🚀 PrelabAI</span>
      <button id="_gem-stop" style="background:rgba(255,69,58,.15);border:1px solid #ff453a;border-radius:6px;color:#ff453a;padding:3px 9px;font-size:11px;font-weight:700;cursor:pointer;">🛑 STOP</button>
    </div>
    <div id="_gem-status" style="color:#e5e5ea;font-size:12px;line-height:1.5;margin-bottom:10px;"><i>⏳ Menyiapkan…</i></div>
    <div style="background:rgba(255,255,255,0.1);border-radius:4px;height:5px;overflow:hidden;">
      <div id="_gem-bar" style="background:linear-gradient(90deg,#0A84FF,#32d74b);height:100%;width:0%;transition:width .3s ease;"></div>
    </div>`;
  document.body.appendChild(root);
  return {
    root,
    status: root.querySelector('#_gem-status'),
    bar:    root.querySelector('#_gem-bar'),
    stopBtn:root.querySelector('#_gem-stop'),
  };
}

// ── Utilities ─────────────────────────────────────────────────────────────────
function buildTextPrompt({ text, prompt }) {
  return (prompt ? prompt + '\n\nBerikut soalnya:\n\n' : 'Jawab soal berikut secara lengkap:\n\n') + text;
}

function dataURLtoBlob(dataUrl) {
  if (!dataUrl?.includes(',')) return new Blob([], { type: 'image/png' });
  const [header, data] = dataUrl.split(',');
  const mime = header.match(/:(.*?);/)?.[1] ?? 'image/png';
  const bytes = atob(data);
  const buf   = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) buf[i] = bytes.charCodeAt(i);
  return new Blob([buf], { type: mime });
}

function waitFor(fn, timeout = 10000, interval = 300) {
  return new Promise(res => {
    const id    = setInterval(() => { const v = fn(); if (v) { clearInterval(id); res(v); } }, interval);
    setTimeout(() => { clearInterval(id); res(null); }, timeout);
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function getMyTabId() {
  return new Promise(res =>
    chrome.runtime.sendMessage({ action: '__GET_TAB_ID__' }, r => res(r?.tabId ?? null))
  ).catch(() => null);
}
