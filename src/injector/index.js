// ── Gemini injector ─────────────────────────────────────────────────────────
'use strict';

import { escapeHtml, sleep } from '../shared/util.js';
import { matchClosingBrace } from './json-extract.js';
import { getProviderByHost } from '../shared/providers.js';
import { buildAutoSolveRules } from '../shared/solve-contract.js';

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
// Token abort per-payload. Tab persisten dipakai ulang lintas soal, jadi STOP dari
// soal lama tidak boleh membatalkan soal baru — tiap processPayload pegang token
// sendiri, dan __activeAbort selalu menunjuk token yang sedang berjalan.
let __activeAbort = { v: false };

// Proses SATU payload di tab provider: bangun UI, tunggu editor, inject, kirim,
// amati respons. Dipanggil saat tab pertama kali dibuka (payload dari storage) dan
// tiap kali background mengirim NEW_PAYLOAD ke tab yang sama (soal berikutnya).
async function processPayload(payload, provider) {
  const myAbort = { v: false };
  __activeAbort = myAbort;

  // Reuse tab → bersihkan overlay sisa soal sebelumnya sebelum bikin yang baru.
  document.getElementById('__flab-gem-ui')?.remove();

  const ui = buildGeminiUI();
  const isAborted = () => myAbort.v;
  const setGStatus = (msg, pct = null, barColor = null) => {
    if (myAbort.v) return;
    ui.status.innerHTML = msg;
    if (pct !== null) ui.bar.style.width = pct + '%';
    if (barColor) ui.bar.style.background = barColor;
  };

  ui.stopBtn.addEventListener('click', () => {
    myAbort.v = true;
    setGStatus('[Sistem] Dibatalkan paksa. Sinyal sinkron dikirim ke LMS.', 100, '#ff453a');
    chrome.runtime.sendMessage({ action: 'STOP_PROCESS' }); // Matikan LMS di tab sebelah
    setTimeout(() => ui.root.remove(), 3000);
  });

  // ── Wait for provider editor ───────────────────────────────────────────────
  const inputEl = await waitFor(() => {
    for (const sel of provider.editorSelectors) {
      const el = document.querySelector(sel);
      if (el) return el;
    }
    return null;
  }, EDITOR_WAIT_MS);

  if (!inputEl) {
    setGStatus('[Sistem] Gagal mengikat elemen editor teks Gemini UI.', 100, '#ff453a');
    setTimeout(() => ui.root.remove(), 5000);
    return;
  }
  if (myAbort.v) return;
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
    await injectMultipleImages(inputEl, payload.dataUrls, payload.prompt, setGStatus, isAborted);
  } else if (payload.type === 'solve_image') {
    setGStatus('[Operasi] Mode Ekstraksi Gambar & Parsing JSON otomatis...', 30);
    await injectImage(inputEl, payload.dataUrl, (payload.prompt || '') + autoSolveRules, setGStatus, isAborted);
  } else {
    setGStatus('[Operasi] Menginisiasi transmisi blob gambar tunggal...', 30);
    await injectImage(inputEl, payload.dataUrl, payload.prompt || '', setGStatus, isAborted);
  }

  if (myAbort.v) return;
  setGStatus('[Jaringan] Memantik event pengiriman antarmuka Gemini...', 85);
  await sleep(INITIAL_DELAY_MS);

  // Ambil jumlah bubble SEBELUM klik send agar tahu mana bubble respons yang baru
  const initialBubbleCount = document.querySelectorAll(provider.bubbleSelector).length;

  const sent = clickSend(provider);
  if (!sent) {
    setGStatus('[Error] Kegagalan menemukan elemen pemicu pengiriman.', 100, '#ff453a');
    setTimeout(() => ui.root.remove(), 5000);
    return;
  }

  setGStatus('[Agen] Menggantung status, menunggu perakitan struktur JSON dan resolusi AI...', 90);
  const needsJsonResponse = payload.type === 'solve_image' || payload.type === 'solve_text';
  if (needsJsonResponse) {
    await observeAndExtractJson(setGStatus, isAborted, initialBubbleCount, provider.bubbleSelector);
  } else {
    setTimeout(() => ui.root.remove(), 4000);
  }
}

// Baca payload terbaru dari storage, validasi tab & provider, lalu proses.
async function consumePayloadFromStorage() {
  let session = await chrome.storage.local.get(['flabPayload', 'pendingTabId']);
  const payload = session.flabPayload;
  if (!payload) { console.log('[FLAB] No payload – skip.'); return; }

  // Provider di-identify dari host tab ini; hanya lanjut bila cocok dengan pilihan user.
  const provider = getProviderByHost(location.hostname);
  if (!provider)                             { console.log('[FLAB] Host bukan provider terdaftar – skip.'); return; }
  if (payload.ai && payload.ai !== provider.id) { console.log('[FLAB] Provider mismatch – skip.'); return; }

  const myTabId = await getMyTabId();

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
  await processPayload(payload, provider);
}

// Idempotensi: daftarkan listener sekali. Tab persisten dipakai ulang, jadi
// background memicu soal berikutnya lewat NEW_PAYLOAD tanpa reload halaman.
if (!window.__flabInjectorReady) {
  window.__flabInjectorReady = true;
  chrome.runtime.onMessage.addListener((msg, sender) => {
    if (sender?.id && sender.id !== chrome.runtime.id) return;
    if (msg.action === 'NEW_PAYLOAD') consumePayloadFromStorage();
    if (msg.action === 'STOP_PROCESS') __activeAbort.v = true;
  });
}

// Payload pertama: dijalankan saat tab baru dibuka & halaman selesai dimuat.
consumePayloadFromStorage();

// buildAutoSolveRules dipindah ke ../shared/solve-contract.js (dipakai bareng jalur API)

// ── JSON extractor (waits for AI streaming to finish) ─────────────────────────
async function observeAndExtractJson(setGStatus, isAborted, initialBubbleCount = -1, bubbleSelector = BUBBLE_SELECTOR) {
  let ticks = 0;

  const existingBubbleCount = initialBubbleCount !== -1 ? initialBubbleCount : document.querySelectorAll(bubbleSelector).length;

  return new Promise(resolve => {
    const timer = setInterval(() => {
      if (isAborted?.()) { clearInterval(timer); resolve(); return; }

      const bubbles = document.querySelectorAll(bubbleSelector);
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
function clickSend(provider) {
  const selectors = provider?.sendSelectors || [];

  for (const sel of selectors) {
    for (const btn of document.querySelectorAll(sel)) {
      if (!btn.disabled && !btn.hasAttribute('disabled') && btn.offsetParent !== null) {
        btn.click();
        return true;
      }
    }
  }

  // Fallback: Enter key on editor
  let editor = null;
  for (const sel of (provider?.editorSelectors || [])) {
    editor = document.querySelector(sel);
    if (editor) break;
  }
  if (editor) {
    editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, bubbles: true }));
    return true;
  }
  return false;
}

// ── UI helpers ────────────────────────────────────────────────────────────────
function buildGeminiUI() {
  const root = document.createElement('div');
  root.id = '__flab-gem-ui';
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

// matchClosingBrace dipindah ke ./json-extract.js

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
