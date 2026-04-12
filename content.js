// ── Content script ─────────────────────────────────────────────────────────────
// Guard: jangan double-inject saat executeScript dipanggil manual
'use strict';

if (!window.__prelabAI) {
  window.__prelabAI = true;

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.action === 'START')        handleStart(msg);
    if (msg.action === 'FILL_ANSWER') executeFillAnswer(msg.data);
    if (msg.action === 'RETRY_SOLVE') retrySolve();
  });

  // Restore UI jika halaman baru dimuat dan sesi masih berjalan
  chrome.storage.local.get(['isBatching', 'batchScreenshots', 'ai', 'batchPrompt'], d => {
    if (!d.isBatching) return;
    waitForBody(() =>
      renderBatchUI(d.batchScreenshots?.length ?? 0, d.ai ?? 'gemini', d.batchPrompt ?? '')
    );
  });
}

// ── Router ─────────────────────────────────────────────────────────────────────
async function handleStart({ ai, mode, prompt }) {
  if (mode === 'batch')  return handleBatch(ai, prompt);
  if (mode === 'solve')  {
    // Reset retry counter saat soal baru dimulai dari luar (bukan dari retry)
    await chrome.storage.local.set({ solveRetryCount: 0 });
    return handleSolve(ai, prompt);
  }
  if (mode === 'select') return startSnipTool(ai, prompt);
  if (mode === 'text')   return dispatch(ai, { type: 'text', text: extractText(), prompt });
  // Default: full-page screenshot
  dispatch(ai, { type: 'image', dataUrl: await captureTab(), prompt });
}

// ── Retry handler (dipanggil saat Gemini timeout) ──────────────────────────────
async function retrySolve() {
  const MAX_RETRY = 3;
  const d = await storageGet(['activeMode', 'ai', 'batchPrompt', 'solveRetryCount', 'isBatching']);
  if (!d.isBatching) return; // Sudah dihentikan user

  const retryCount = Number(d.solveRetryCount ?? 0);
  const ui = document.getElementById('pai-ui');

  if (retryCount >= MAX_RETRY) {
    setStatus(`❌ Gagal setelah ${MAX_RETRY}x retry. Loop dihentikan.`, ui);
    chrome.storage.local.set({ isBatching: false });
    setTimeout(() => ui?.remove(), 4000);
    return;
  }

  const nextCount = retryCount + 1;
  await chrome.storage.local.set({ solveRetryCount: nextCount });

  setStatus(`🔁 Retry ${nextCount}/${MAX_RETRY} – mengirim ulang soal ke Gemini...`, ui);
  console.log(`[PrelabAI] Retrying solve attempt ${nextCount}/${MAX_RETRY}`);

  // Jeda 2 detik sebelum retry agar Gemini tab lama sempat tertutup
  await sleep(2000);
  if (!(await isStillBatching())) return;

  handleSolve(d.ai ?? 'gemini', d.batchPrompt ?? '');
}

// ── Shared UI ──────────────────────────────────────────────────────────────────
function renderBatchUI(count, ai, prompt) {
  let ui = document.getElementById('pai-ui');
  if (!ui) {
    ui = document.createElement('div');
    ui.id = 'pai-ui';
    Object.assign(ui.style, {
      position: 'fixed', bottom: '20px', right: '20px',
      background: 'rgba(20,20,22,0.92)', backdropFilter: 'blur(14px)',
      border: '1px solid rgba(255,255,255,0.09)', borderRadius: '16px',
      padding: '14px 18px', zIndex: '2147483647',
      fontFamily: 'Inter,-apple-system,sans-serif', color: '#fff',
      fontSize: '13px', boxShadow: '0 12px 40px rgba(0,0,0,0.65)',
      minWidth: '210px', display: 'flex', flexDirection: 'column', gap: '10px',
    });
    ui.innerHTML = `
      <div style="display:flex;align-items:center;gap:8px;font-weight:600;font-size:14px;">
        <span style="width:8px;height:8px;background:#32d74b;border-radius:50%;display:inline-block;box-shadow:0 0 8px rgba(50,215,75,.6);animation:_pblink 1.5s infinite;"></span>
        PrelabAI
      </div>
      <div id="pai-status" style="font-size:12px;color:#e5e5ea;line-height:1.45;"></div>
      <button id="pai-stop" style="background:#ff453a;color:#fff;border:none;padding:7px 14px;border-radius:8px;cursor:pointer;font-weight:600;font-size:12px;">⏹ Stop</button>
      <style>@keyframes _pblink{0%,100%{opacity:1}50%{opacity:.25}}</style>`;
    document.body.appendChild(ui);

    document.getElementById('pai-stop').addEventListener('click', () => {
      chrome.storage.local.set({ isBatching: false });
      setStatus('🛑 Dihentikan.', ui);
      setTimeout(() => ui?.remove(), 2500);
    });
  }
  setStatus(`📋 Batch: <b style="color:#ffd60a">${count}/10</b>`, ui);
  return ui;
}

function setStatus(msg, ui = document.getElementById('pai-ui')) {
  const el = ui?.querySelector('#pai-status');
  if (el) el.innerHTML = msg;
}

// ── Batch mode ─────────────────────────────────────────────────────────────────
async function handleBatch(ai, prompt) {
  const d = await storageGet(['isBatching', 'batchScreenshots']);
  if (!d.isBatching) return;

  const ui = renderBatchUI(d.batchScreenshots?.length ?? 0, ai, prompt);

  setStatus('⏳ Menunggu halaman siap…', ui);
  await sleep(1400);

  if (!(await isStillBatching())) return;

  setStatus('📸 Memotret soal…', ui);
  const dataUrl = await captureTab();
  if (!dataUrl) { setStatus('❌ Gagal memotret.', ui); return; }

  const saved = await storageGet(['batchScreenshots', 'isBatching']);
  if (!saved.isBatching) return;

  let shots = saved.batchScreenshots ?? [];
  shots.push(dataUrl);

  if (shots.length >= 10) {
    setStatus('🚀 Mengirim 10 soal ke Gemini…', ui);
    dispatch(ai, { type: 'batch_images', dataUrls: shots, prompt });
    shots = [];
    await sleep(800);
  }

  await chrome.storage.local.set({ batchScreenshots: shots });
  renderBatchUI(shots.length, ai, prompt);

  const nextBtn = findNextButton();
  if (nextBtn) {
    setStatus('➡️ Lanjut soal berikutnya…', ui);
    nextBtn.click();
    setTimeout(() => handleStart({ ai, mode: 'batch', prompt }), 3200);
  } else {
    chrome.storage.local.set({ isBatching: false });
    if (shots.length > 0) {
      setStatus('✅ Mengirim sisa soal ke Gemini…', ui);
      dispatch(ai, { type: 'batch_images', dataUrls: shots, prompt });
    }
    setStatus('✅ Selesai!', ui);
    setTimeout(() => ui?.remove(), 3000);
  }
}

// ── Auto-Solve mode ────────────────────────────────────────────────────────────
async function handleSolve(ai, prompt) {
  const d = await storageGet(['isBatching']);
  if (!d.isBatching) return;

  const ui = renderBatchUI(0, ai, prompt);
  setStatus('📸 Memotret soal…', ui);

  const dataUrl = await captureTab();
  if (!dataUrl) { setStatus('❌ Gagal memotret.', ui); return; }

  if (!(await isStillBatching())) return;

  setStatus('🚀 Mengirim ke Gemini…', ui);
  dispatch(ai, { type: 'solve_image', dataUrl, prompt });
  setStatus('⏳ Menunggu jawaban AI…', ui);
}

// ── Fill answer handler ────────────────────────────────────────────────────────
function executeFillAnswer(json) {
  const ui          = document.getElementById('pai-ui');
  const status      = msg => setStatus(msg, ui);
  const originalJaw = String(json.jawaban ?? '').trim();
  const jaw         = originalJaw.toUpperCase();
  const idxHint     = Number(json.index_pilihan ?? 0); // 0 = essay/coding

  if (!originalJaw) { status('❌ Jawaban kosong dari AI.'); return; }
  status(`🧩 Mengisi: <b>${originalJaw.length > 30 ? '(teks panjang)' : originalJaw}</b>`);

  // ── Helper: fire synthetic mouse events so JS frameworks detect the click ──
  const fireClick = (el) => {
    try {
      el.click();
      el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      el.dispatchEvent(new MouseEvent('mouseup',   { bubbles: true }));
      el.dispatchEvent(new Event('change',         { bubbles: true }));
    } catch { /**/ }
  };

  // ── Helper: normalize strings for math-formula matching ───────────────────
  const norm = s => String(s).toUpperCase()
    .replace(/\s+/g,         '')
    .replace(/\\?SQRT|AKAR/g,'√')
    .replace(/\\/g,          '')
    .replace(/[{}()[\]]/g,   '')
    .trim();

  let clicked = false;

  // ═══════════════════════════════════════════════════════════════════
  // BRANCH A: Isian / Koding
  //   Criteria: AI set index_pilihan=0  OR  jawaban is multiline  OR  jawaban > 50 chars
  // ═══════════════════════════════════════════════════════════════════
  const isEssay = (idxHint === 0) || originalJaw.includes('\n') || originalJaw.length > 50;

  if (isEssay) {
    // Try textarea, then plain text input, then AceEditor hidden input
    const editors = [
      ...document.querySelectorAll('textarea:not([hidden])'),
      ...document.querySelectorAll('.ace_text-input'),
    ].filter(el => {
      try { return el.offsetParent !== null || el.classList.contains('ace_text-input'); }
      catch { return false; }
    });

    if (editors.length > 0) {
      const el    = editors.find(e => e.classList.contains('ace_text-input')) ?? editors[editors.length - 1];
      const jText = originalJaw.replace(/\\n/g, '\n'); // unescape literal \n from JSON

      try {
        el.focus();
        // Native setter to bypass React/Vue value watchers
        const setter = Object.getOwnPropertyDescriptor(
          el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype,
          'value'
        )?.set;
        setter ? setter.call(el, jText) : (el.value = jText);

        el.dispatchEvent(new Event('input',  { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));

        // Paste event as last resort (AceEditor, CodeRunner)
        const dt = new DataTransfer();
        dt.setData('text/plain', jText);
        el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true }));

        const box = el.closest('.ace_editor, .CodeMirror, .answer, form') ?? el;
        box.style.outline = '3px solid #32d74b';
        clicked = true;
        status('✅ Kode/Teks berhasil diisikan.');
      } catch(err) {
        console.warn('[PrelabAI] Essay inject error:', err);
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // BRANCH B: Pilihan Ganda  
  // ═══════════════════════════════════════════════════════════════════
  if (!clicked) {
    const radios = [...document.querySelectorAll('input[type="radio"], input[type="checkbox"]')];

    // B1 – exact value match
    for (const r of radios) {
      if ((r.value ?? '').toUpperCase().trim() === jaw) {
        fireClick(r); clicked = true; break;
      }
    }

    // B2 – label text matching (with math normalizer)
    if (!clicked) {
      const jawNorm = norm(jaw);
      const labels  = [...document.querySelectorAll('label, li, div, span, a')].filter(l => {
        const txt = (l.textContent ?? '').trim();
        if (!txt || txt.length >= 200) return false;
        // Reject containers holding multiple radio buttons
        if (l.querySelectorAll('input[type="radio"],[role="radio"]').length > 1) return false;
        return (
          l.querySelectorAll('input,[role="radio"]').length === 1 ||
          l.getAttribute('for') ||
          l.tagName === 'LI' ||
          l.getAttribute('role') === 'radio' ||
          l.className?.toLowerCase().includes('option')
        );
      });

      for (const l of labels) {
        const raw    = (l.textContent ?? '').toUpperCase().trim();
        const clean  = raw.replace(/^[A-E][.)]\s*/i, '').trim();
        const rNorm  = norm(raw);
        const cNorm  = norm(clean);

        const matched =
          raw === jaw || clean === jaw ||
          raw.startsWith(jaw + '.') || raw.startsWith(jaw + ')') ||
          rNorm === jawNorm || cNorm === jawNorm || rNorm.includes(jawNorm);

        if (matched) {
          l.style.outline    = '2px solid #32d74b';
          l.style.background = 'rgba(50,215,75,0.12)';
          fireClick(l);
          const r = l.querySelector('input') ??
                    document.getElementById(l.getAttribute('for') ?? '') ??
                    l.querySelector('[role="radio"]');
          if (r) fireClick(r);
          clicked = true;
          break;
        }
      }
    }

    // B3 – spatial fallback: use AI-provided ordinal index
    if (!clicked && idxHint > 0) {
      const allRadios = [...document.querySelectorAll('input[type="radio"],[role="radio"]')];
      const target    = allRadios[idxHint - 1];
      if (target) {
        target.style.outline = '3px solid #ff9f0a';
        fireClick(target);
        clicked = true;
        status(`⚠️ Pencocokan teks gagal – fallback ke opsi ke-${idxHint}.`);
      }
    }

    // B4 – letter fallback (A→0, B→1, …)
    if (!clicked && jaw.length === 1 && jaw >= 'A' && jaw <= 'E') {
      const allRadios = [...document.querySelectorAll('input[type="radio"],[role="radio"]')];
      const target    = allRadios[jaw.charCodeAt(0) - 65];
      if (target) {
        target.style.outline = '2px solid #32d74b';
        fireClick(target);
        clicked = true;
      }
    }
  }

  // ── Bail if nothing was clicked ───────────────────────────────────────────
  if (!clicked) {
    status('❌ Tidak dapat mendeteksi opsi jawaban – loop dihentikan.');
    chrome.storage.local.set({ isBatching: false });
    return;
  }

  // ── Navigate to next question ─────────────────────────────────────────────
  setTimeout(() => {
    const nextBtn = findNextButton();
    if (nextBtn) {
      status('➡️ Lanjut ke soal berikutnya…');
      fireClick(nextBtn);
      setTimeout(() => {
        chrome.storage.local.get(['activeMode', 'ai', 'batchPrompt'], d => {
          if (d.activeMode === 'solve') handleStart({ ai: d.ai ?? 'gemini', mode: 'solve', prompt: d.batchPrompt ?? '' });
        });
      }, 3200);
    } else {
      status('🎉 Selesai! Tidak ada tombol Next.');
      chrome.storage.local.set({ isBatching: false });
      setTimeout(() => document.getElementById('pai-ui')?.remove(), 4000);
    }
  }, 900);
}

// ── Helpers ────────────────────────────────────────────────────────────────────
function findNextButton() {
  const NEXT_KEYWORDS = ['next', 'selanjutnya', 'berikutnya', 'lanjut'];
  return [...document.querySelectorAll('button,a,input[type="button"],input[type="submit"]')]
    .find(b => {
      if (b.offsetWidth === 0 && b.offsetHeight === 0) return false;
      const txt = (b.innerText || b.value || '').toLowerCase();
      return NEXT_KEYWORDS.some(k => txt.includes(k));
    }) ?? null;
}

function autoDetect() {
  const imgs = [...document.querySelectorAll('img')].filter(img =>
    img.naturalWidth > 80 && img.naturalHeight > 80 &&
    !img.src.includes('data:image/gif') &&
    !['icon','logo','avatar'].some(w => img.src.includes(w))
  );
  return imgs.length > 0 ? 'screenshot' : 'text';
}

function extractText() {
  const skip = new Set(['script','style','noscript','nav','header','footer']);
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
    acceptNode(n) {
      const tag = n.parentElement?.tagName?.toLowerCase();
      if (skip.has(tag) || n.parentElement?.closest('nav,header,footer,#prelabai-snip'))
        return NodeFilter.FILTER_REJECT;
      if (!n.textContent.trim()) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    }
  });
  const chunks = [];
  while (walker.nextNode()) {
    const t = walker.currentNode.textContent.trim();
    if (t.length > 3 && chunks.at(-1) !== t) chunks.push(t);
  }
  return chunks.join('\n').slice(0, 12000);
}

function captureTab() {
  return new Promise(res =>
    chrome.runtime.sendMessage({ action: 'CAPTURE' }, r => res(r?.dataUrl ?? null))
  );
}

function dispatch(ai, payload) {
  chrome.runtime.sendMessage({ action: 'OPEN_AI', payload: { ai, ...payload } });
}

function storageGet(keys) {
  return new Promise(res => chrome.storage.local.get(keys, res));
}

async function isStillBatching() {
  const d = await storageGet(['isBatching']);
  return !!d.isBatching;
}

function waitForBody(fn) {
  if (document.body) return fn();
  const id = setInterval(() => { if (document.body) { clearInterval(id); fn(); } }, 80);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Snip tool ─────────────────────────────────────────────────────────────────
function startSnipTool(ai, prompt) {
  if (document.getElementById('prelabai-snip')) return;

  const style = document.createElement('style');
  style.id = 'prelabai-snip-style';
  style.textContent = `
    #prelabai-snip{position:fixed;inset:0;z-index:2147483647;cursor:crosshair;background:rgba(0,0,0,.45);}
    #_snip-hint{position:absolute;top:16px;left:50%;transform:translateX(-50%);background:#1a1a3a;color:#ccd;font-family:Inter,sans-serif;font-size:13px;padding:8px 20px;border-radius:999px;border:1px solid #6c63ff80;white-space:nowrap;box-shadow:0 4px 24px #0008;}
    #_snip-cancel{color:#ff6b6b;cursor:pointer;font-weight:600;}
    #_snip-box{position:fixed;display:none;border:2px solid #6c63ff;background:rgba(108,99,255,.12);pointer-events:none;}`;
  document.head.appendChild(style);

  const overlay = document.createElement('div');
  overlay.id = 'prelabai-snip';
  overlay.innerHTML = `<div id="_snip-hint">Drag area soal &nbsp;·&nbsp; <span id="_snip-cancel">Batal (Esc)</span></div><div id="_snip-box"></div>`;
  document.body.appendChild(overlay);

  const box = overlay.querySelector('#_snip-box');
  let startX, startY, dragging = false;

  overlay.addEventListener('mousedown', e => {
    dragging = true;
    startX = e.clientX; startY = e.clientY;
    Object.assign(box.style, { left: startX + 'px', top: startY + 'px', width: '0', height: '0', display: 'block' });
  });
  overlay.addEventListener('mousemove', e => {
    if (!dragging) return;
    const x = Math.min(e.clientX, startX), y = Math.min(e.clientY, startY);
    Object.assign(box.style, { left: x + 'px', top: y + 'px', width: Math.abs(e.clientX - startX) + 'px', height: Math.abs(e.clientY - startY) + 'px' });
  });
  overlay.addEventListener('mouseup', async e => {
    if (!dragging) return;
    dragging = false;
    const x = Math.min(e.clientX, startX), y = Math.min(e.clientY, startY);
    const w = Math.abs(e.clientX - startX), h = Math.abs(e.clientY - startY);
    if (w < 20 || h < 20) return;
    overlay.remove();
    const full    = await captureTab();
    const cropped = await cropImage(full, x, y, w, h);
    dispatch(ai, { type: 'image', dataUrl: cropped, prompt });
  });

  overlay.querySelector('#_snip-cancel').addEventListener('click', () => overlay.remove());
  document.addEventListener('keydown', function esc(e) {
    if (e.key === 'Escape') { overlay.remove(); document.removeEventListener('keydown', esc); }
  });
}

function cropImage(dataUrl, x, y, w, h) {
  return new Promise(res => {
    const img = new Image();
    img.onload = () => {
      const dpr = window.devicePixelRatio || 1;
      const c   = document.createElement('canvas');
      c.width = w * dpr; c.height = h * dpr;
      c.getContext('2d').drawImage(img, x * dpr, y * dpr, w * dpr, h * dpr, 0, 0, w * dpr, h * dpr);
      res(c.toDataURL('image/png'));
    };
    img.src = dataUrl;
  });
}
