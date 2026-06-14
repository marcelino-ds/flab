// ── Gemini injector ─────────────────────────────────────────────────────────
'use strict';

import { escapeHtml, sleep } from '../shared/util.js';

const MAX_TICKS = 240;
const TICK_INTERVAL_MS = 1000;
const INITIAL_DELAY_MS = 600;
const UI_REMOVE_DELAY_MS = 4000;
const FILE_INPUT_WAIT_MS = 4000;
const EDITOR_WAIT_MS = 20000;
const TEXT_INJECT_DELAY_MS = 350;
const IMAGE_LOAD_DELAY_MS = 2000;
const PASTE_DELAY_MS = 3000;
const PROMPT_WAIT_MS = 5000;
const BUBBLE_SELECTOR = 'model-response, .model-response-text, [data-message-author-role="model"], message-content';
(async () => {
  let session = await chrome.storage.local.get(['flabPayload', 'pendingTabId']);
  const payload = session.flabPayload;
  const myTabId = await getMyTabId();

  if (!payload)                              { console.log('[FLAB] No payload – skip.'); return; }
  if (payload.ai !== 'gemini')               { return; }

  // Race fix (H1): background menulis pendingTabId di callback SETELAH tab dibuat.
  // Bila tab Gemini ready lebih dulu, pendingTabId bisa belum ada → retry baca singkat
  // sebelum menyatakan mismatch, agar payload tidak menggantung.
  for (let i = 0; i < 10 && session.pendingTabId == null; i++) {
    await sleep(150);
    session = await chrome.storage.local.get(['flabPayload', 'pendingTabId']);
  }
  if (session.pendingTabId !== myTabId)      { console.log('[FLAB] Tab ID mismatch – skip.'); return; }

  await chrome.storage.local.remove(['flabPayload', 'pendingTabId']);
  console.log('[FLAB] Payload received, type:', payload.type);

  // ── Status-UI overlay ──────────────────────────────────────────────────────
  const ui = buildGeminiUI();
  let aborted = false;

  // setGStatus definisikan lebih awal agar siap digunakan di stop handler
  const setGStatus = (msg, pct = null, barColor = null) => {
    if (aborted) return;
    ui.status.innerHTML = msg;
    if (pct !== null) ui.bar.style.width = pct + '%';
    if (barColor) ui.bar.style.background = barColor;
  };

  ui.stopBtn.addEventListener('click', () => {
    aborted = true;
    setGStatus('[Sistem] Dibatalkan paksa. Sinyal sinkron dikirim ke LMS.', 100, '#ff453a');
    chrome.runtime.sendMessage({ action: 'STOP_PROCESS' }); // Matikan LMS di tab sebelah
    setTimeout(() => ui.root.remove(), 3000);
  });

  // ── Wait for Gemini editor ─────────────────────────────────────────────────
  const inputEl = await waitFor(() =>
    document.querySelector('rich-textarea .ql-editor[contenteditable="true"]') ||
    document.querySelector('.ql-editor[contenteditable="true"]') ||
    document.querySelector('div[aria-label*="message" i][contenteditable="true"]') ||
    document.querySelector('rich-textarea div[contenteditable="true"]') ||
    document.querySelector('div[contenteditable="true"]')
  , EDITOR_WAIT_MS);

  if (!inputEl) {
    setGStatus('[Sistem] Gagal mengikat elemen editor teks Gemini UI.', 100, '#ff453a');
    setTimeout(() => ui.root.remove(), 5000);
    return;
  }
  if (aborted) return;
  setGStatus('[DOM] Editor input dikunci. Memulai injeksi...', 10);

  // ── Dispatch payload type ──────────────────────────────────────────────────
  const autoSolveRules = buildAutoSolveRules();

  if (payload.type === 'solve_text') {
    setGStatus('[Injeksi] Mentransmisi prompt tekstual dengan aturan penyelesaian...', 50);
    const textPrompt = (payload.prompt || '') + '\n\nBerikut soalnya:\n\n' + payload.text + '\n' + autoSolveRules;
    await injectText(inputEl, textPrompt);
  } else if (payload.type === 'text') {
    setGStatus('[Injeksi] Memasukkan string kontekstual bebas tanpa aturan spesifik...', 50);
    const textPrompt = (payload.prompt ? payload.prompt + '\n\nBerikut soalnya:\n\n' : 'Jawab soal berikut secara lengkap:\n\n') + payload.text;
    await injectText(inputEl, textPrompt);
  } else if (payload.type === 'batch_images') {
    setGStatus(`[Aliran] Menyiapkan unggahan massal untuk ${payload.dataUrls.length} blob grafis...`, 20);
    await injectMultipleImages(inputEl, payload.dataUrls, payload.prompt, setGStatus, () => aborted);
  } else if (payload.type === 'solve_image') {
    setGStatus('[Operasi] Mode Ekstraksi Gambar & Parsing JSON otomatis...', 30);
    await injectImage(inputEl, payload.dataUrl, (payload.prompt || '') + autoSolveRules, setGStatus, () => aborted);
  } else {
    setGStatus('[Operasi] Menginisiasi transmisi blob gambar tunggal...', 30);
    await injectImage(inputEl, payload.dataUrl, payload.prompt || '', setGStatus, () => aborted);
  }

  if (aborted) return;
  setGStatus('[Jaringan] Memantik event pengiriman antarmuka Gemini...', 85);
  await sleep(INITIAL_DELAY_MS);

  // Ambil jumlah bubble SEBELUM klik send agar tahu mana bubble respons yang baru
  const initialBubbleCount = document.querySelectorAll(BUBBLE_SELECTOR).length;

  const sent = clickSend();
  if (!sent) {
    setGStatus('[Error] Kegagalan menemukan elemen pemicu pengiriman.', 100, '#ff453a');
    setTimeout(() => ui.root.remove(), 5000);
    return;
  }

  setGStatus('[Agen] Menggantung status, menunggu perakitan struktur JSON dan resolusi AI...', 90);
  const needsJsonResponse = payload.type === 'solve_image' || payload.type === 'solve_text';
  if (needsJsonResponse) {
    await observeAndExtractJson(setGStatus, () => aborted, initialBubbleCount);
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
- Soal PILIHAN GANDA (1 jawaban) → Opsi sudah DIBERI NOMOR di daftar "Opsi" pada soal. "index_pilihan": WAJIB nomor opsi yang benar PERSIS dari daftar itu (1/2/3/...). "jawaban": salin teks opsi tersebut apa adanya. NOMOR adalah penentu utama — pastikan nomornya benar.
- Soal PILIHAN GANDA MULTI-SELECT (Pilih satu atau lebih!) → "jawaban": ["teks opsi 1", "teks opsi 2"] (salin persis dari daftar Opsi), "index_pilihan": 0.
- Soal TRUE/FALSE → "jawaban": "True" atau "False", "index_pilihan": nomor opsi sesuai daftar (biasanya 1 atau 2).
- Soal ISIAN SINGKAT / NUMERIK / CLOZE (Banyak Kolom) → "jawaban": jawaban presisi. JIKA soal memiliki LEBIH DARI SATU kotak isian kosong, WAJIB jadikan "jawaban" sebagai Array of Strings sesuai urutan kotak, misal: ["isi 1", "isi 2"]. Jika hanya 1 kotak, cukup string biasa. "index_pilihan": 0.
- Soal KODING/CODING → "jawaban": SELURUH kode program LENGKAP dari baris pertama sampai terakhir (gunakan \\n untuk baris baru), "index_pilihan": 0.
  PENTING untuk KODING: Jika ada kode template, SERTAKAN juga template tersebut dalam jawaban. Jangan hapus kode template-nya.
- Soal ESSAY → "jawaban": jawaban lengkap, "index_pilihan": 0.
PENTING: Untuk pilihan ganda 1 jawaban, "index_pilihan" HARUS cocok dengan nomor opsi di daftar "Opsi" dan "jawaban" HARUS sama dengan teks opsi pada nomor itu. Jangan sampai nomor dan teks merujuk opsi berbeda.
DILARANG menulis analisis atau penjelasan teks apapun di luar blok JSON.`;
}

// ── JSON extractor (waits for AI streaming to finish) ─────────────────────────
async function observeAndExtractJson(setGStatus, isAborted, initialBubbleCount = -1) {
  let ticks = 0;

  const existingBubbleCount = initialBubbleCount !== -1 ? initialBubbleCount : document.querySelectorAll(BUBBLE_SELECTOR).length;

  return new Promise(resolve => {
    const timer = setInterval(() => {
      if (isAborted?.()) { clearInterval(timer); resolve(); return; }

      const bubbles = document.querySelectorAll(BUBBLE_SELECTOR);
      if (bubbles.length <= existingBubbleCount) { tick(); return; }
      const node  = bubbles[bubbles.length - 1];
      const text  = node.innerText || node.textContent || '';
      if (text.length < 5) return;

      if (text.includes('[TEKS_JAWABAN]') || text.includes('[NOMOR]')) { tick(); return; }

      const jPos = text.lastIndexOf('"jawaban"');
      if (jPos === -1) { tick(); return; }

      const s = text.lastIndexOf('{', jPos);
      if (s === -1) { tick(); return; }

      // Balanced brace-matching dari `s`, sadar string & escape. lastIndexOf('}')
      // global salah untuk jawaban KODING (penuh '{}') atau teks setelah blok JSON.
      const e = matchClosingBrace(text, s);
      if (e === -1 || e <= s) { tick(); return; }

      const block = text.slice(s, e + 1);

      let safe = block
        .replace(/[\u201C\u201D\u201F]/g, '"')
        .replace(/[\u2018\u2019]/g, "'");

      let jawaban = '', index_pilihan = 0, ok = false;
      try {
         let obj;
         try {
             obj = JSON.parse(safe);
         } catch(err) {
             const matchArr = safe.match(/"jawaban"\s*:\s*\[([\s\S]*?)\]\s*(?:,\s*"index_pilihan"|\})/i);
             const matchStr = safe.match(/"jawaban"\s*:\s*"([\s\S]*?)"\s*(?:,\s*"index_pilihan"|\})/i);
             const matchIdx = safe.match(/"index_pilihan"\s*:\s*(\d+)/i);
             
             if (matchArr) {
                obj = {
                   jawaban: [...matchArr[1].matchAll(/"([\s\S]*?)"/g)].map(m => m[1].replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\')),
                   index_pilihan: matchIdx ? parseInt(matchIdx[1]) : 0
                };
             } else if (matchStr) {
                obj = {
                   jawaban: matchStr[1].replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\'),
                   index_pilihan: matchIdx ? parseInt(matchIdx[1]) : 0
                };
             } else {
                throw new Error("Fallback failed");
             }
         }

         jawaban = Array.isArray(obj.jawaban) ? obj.jawaban : String(obj.jawaban ?? '').trim();
         index_pilihan = Number(obj.index_pilihan ?? 0);
         ok = true;
      } catch (e2) {
         // Silently fail, loop again until parsing succeeds
      }

      const isNullish = typeof jawaban === 'string' && (jawaban.toLowerCase() === 'null' || jawaban.toLowerCase() === 'undefined');
      if (ok && jawaban && !isNullish) {
        clearInterval(timer);
        const displayJaw = Array.isArray(jawaban) ? jawaban.join(', ') : jawaban;
        const preview = displayJaw.length > 40 ? '(jawaban multiselect / format panjang)' : displayJaw;
        setGStatus(`[Kompilasi] Blok JSON berhasil diesktrak: <b>${escapeHtml(preview)}</b>${index_pilihan ? ` · opsi ke-${index_pilihan}` : ''}`, 100);
        chrome.runtime.sendMessage({ action: 'SOLVER_JSON_RESULT', data: { jawaban, index_pilihan } });
        resolve();
        return;
      }

      tick();

      function tick() {
        ticks++;
        if (ticks < MAX_TICKS) {
          const mnt = Math.floor(ticks / 60);
          const dtk = ticks % 60;
          const pct = Math.min(90, 10 + Math.round(ticks / MAX_TICKS * 80));
          setGStatus(`[AI] Proses komputasi iteratif berjalan... Membaca respons (${mnt}m ${String(dtk).padStart(2, '0')}s / 4m)`, pct);
        }
        if (ticks > MAX_TICKS) {
          clearInterval(timer);
          setGStatus('[Timeout] Interval polling terpenuhi. Menginisiasi mode pemulihan otomatis via LMS...', 100, '#ff9f0a');
          chrome.runtime.sendMessage({ action: 'SOLVER_TIMEOUT' });
          setTimeout(() => resolve(), INITIAL_DELAY_MS + 900);
        }
      }
    }, TICK_INTERVAL_MS);
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
    await sleep(TEXT_INJECT_DELAY_MS);
    if (el.textContent.trim().length > 0) return true;
  } catch (e) { console.debug('[FLAB] injectText method 1 (paste) gagal:', e); }

  // Method 2: Input event
  try {
    el.dispatchEvent(new InputEvent('input', { bubbles: true, data: text, inputType: 'insertText' }));
    await sleep(TEXT_INJECT_DELAY_MS);
    if (el.textContent.trim().length > 0) return true;
  } catch (e) { console.debug('[FLAB] injectText method 2 (input event) gagal:', e); }

  // Method 3: Direct DOM (last resort)
  try {
    el.textContent = text;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  } catch (e) { console.debug('[FLAB] injectText method 3 (direct DOM) gagal:', e); }

  console.warn('[FLAB] All text-inject methods failed.');
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
    FILE_INPUT_WAIT_MS
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
  await sleep(IMAGE_LOAD_DELAY_MS);

  if (isAborted()) return;
  if (promptText) {
    setGStatus('Menambahkan prompt…', 80);
    const freshEl = await waitFor(
      () => document.querySelector('rich-textarea .ql-editor[contenteditable="true"]') ||
            document.querySelector('.ql-editor[contenteditable="true"]'),
      PROMPT_WAIT_MS
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
    FILE_INPUT_WAIT_MS
  );

  if (fileInput) {
    fileInput.files = dt.files;
    fileInput.dispatchEvent(new Event('change', { bubbles: true }));
  } else {
    inputEl.focus();
    inputEl.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true }));
  }
  await sleep(PASTE_DELAY_MS);

  if (isAborted?.()) return;
  if (promptText) {
    setGStatus('Menambahkan prompt akhir…', 80);
    const freshEl = await waitFor(
      () => document.querySelector('rich-textarea .ql-editor[contenteditable="true"]') ||
            document.querySelector('.ql-editor[contenteditable="true"]'),
      PROMPT_WAIT_MS
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
    fontFamily: 'Inter, -apple-system, sans-serif', fontSize: '12px', /* reduced from 13 */
    boxShadow: '0 16px 48px rgba(0,0,0,0.7)', width: '310px', /* increased width to accommodate detailed logs */
  });
  root.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">
      <span style="font-weight:700;font-size:14px;color:#32d74b;text-shadow:0 0 10px rgba(50,215,75,0.35);">FLAB <span style="font-size:11px;color:#8E8E93">GEMINI INJECTOR</span></span>
      <button id="_gem-stop" style="background:rgba(255,69,58,.15);border:1px solid #ff453a;border-radius:6px;color:#ff453a;padding:3px 9px;font-size:11px;font-weight:700;cursor:pointer;">BATALKAN</button>
    </div>
    <div id="_gem-status" style="color:#e5e5ea;font-size:11px;line-height:1.5;margin-bottom:10px;"><i>[Sistem] Menyiapkan environment injeksi...</i></div>
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

// Cari index '}' yang menutup '{' di posisi `start`, dengan balanced depth dan
// sadar string JSON + escape. Kembalikan -1 bila tidak ada penutup seimbang.
function matchClosingBrace(text, start) {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escaped) { escaped = false; continue; }
    if (ch === '\\') { if (inString) escaped = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) return i; }
  }
  return -1;
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

function getMyTabId() {
  return new Promise(res => {
    try {
      // lastError diperiksa agar channel error (context invalidated) tidak unhandled
      chrome.runtime.sendMessage({ action: '__GET_TAB_ID__' }, r => {
        void chrome.runtime.lastError;
        res(r?.tabId ?? null);
      });
    } catch (e) {
      console.debug('[FLAB] getMyTabId sendMessage gagal:', e);
      res(null);
    }
  });
}
