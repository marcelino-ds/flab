// ── Content script ─────────────────────────────────────────────────────────────
// Guard: jangan double-inject saat executeScript dipanggil manual
'use strict';

if (!window.__prelabAI) {
  window.__prelabAI = true;

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.action === 'START') return handleStart(msg);

    // Untuk FILL_ANSWER dan RETRY, pastikan isBatching masih true.
    // Jika user sudah klik batal, abaikan respon yang telat dari AI.
    chrome.storage.local.get(['isBatching'], d => {
      if (!d.isBatching) {
        console.log(`[Prelab] Mengabaikan aksi ${msg.action} karena proses telah dibatalkan.`);
        return;
      }
      if (msg.action === 'FILL_ANSWER') executeFillAnswer(msg.data);
      if (msg.action === 'RETRY_SOLVE') retrySolve();
    });
  });

  // Restore UI jika halaman baru dimuat dan sesi masih berjalan
  chrome.storage.local.get(['isBatching', 'ai', 'batchPrompt'], d => {
    if (!d.isBatching) return;
    waitForBody(() =>
      renderUI(d.ai ?? 'gemini', d.batchPrompt ?? '')
    );
  });
}

// ── Platform Detection ─────────────────────────────────────────────────────────
function detectPlatform() {
  const host = location.hostname;
  if (host.includes('praktikum.gunadarma.ac.id')) return 'ilab';
  if (host.includes('v-class.gunadarma.ac.id'))   return 'vclass';
  return 'generic';
}

// ── Moodle Quiz Detection ──────────────────────────────────────────────────────
function detectMoodleQuiz() {
  const onQuizPage    = !!document.querySelector('.que, #responseform, .quiz-attempt');
  const hasQuestions   = document.querySelectorAll('.que').length > 0;
  const isAttemptPage  = location.pathname.includes('/mod/quiz/attempt.php');
  const isSummaryPage  = location.pathname.includes('/mod/quiz/summary.php');
  const isReviewPage   = location.pathname.includes('/mod/quiz/review.php');

  return {
    isQuiz: onQuizPage || isAttemptPage,
    hasQuestions,
    isAttemptPage,
    isSummaryPage,
    isReviewPage,
    questionCount: document.querySelectorAll('.que').length,
  };
}

// Detect tipe soal Moodle dari class .que
function detectQuestionType(queEl) {
  if (!queEl) return 'unknown';
  const cl = queEl.classList;
  if (cl.contains('multichoice'))  return 'multichoice';
  if (cl.contains('shortanswer')) return 'shortanswer';
  if (cl.contains('essay'))       return 'essay';
  if (cl.contains('coderunner'))  return 'coderunner';
  if (cl.contains('numerical'))   return 'numerical';
  if (cl.contains('match'))       return 'match';
  if (cl.contains('truefalse'))   return 'truefalse';
  // Fallback: cek ada radio → multichoice, ada textarea → essay, ada input text → shortanswer
  if (queEl.querySelector('input[type="radio"]'))  return 'multichoice';
  if (queEl.querySelector('.ace_editor'))           return 'coderunner';
  if (queEl.querySelector('textarea'))             return 'essay';
  if (queEl.querySelector('input[type="text"]'))   return 'shortanswer';
  return 'unknown';
}

// ══════════════════════════════════════════════════════════════════════════════
// Ace Editor helpers
// ══════════════════════════════════════════════════════════════════════════════

function getAceEditor(queEl) {
  const aceEl = queEl?.querySelector('.ace_editor');
  if (!aceEl) return null;
  // Moodle/CodeRunner stores the editor instance on the element
  return aceEl.env?.editor || aceEl.__ace_editor || null;
}

function getExistingCode(queEl) {
  // Method 1: Ace editor API
  const editor = getAceEditor(queEl);
  if (editor) {
    try { return editor.getValue(); } catch { /**/ }
  }
  // Method 2: Read from Ace gutter (visible lines) 
  const aceLines = queEl?.querySelectorAll('.ace_line');
  if (aceLines && aceLines.length > 0) {
    return [...aceLines].map(l => l.textContent).join('\n');
  }
  // Method 3: Hidden textarea (Moodle CodeRunner syncs to this)
  const textarea = queEl?.querySelector('textarea[name*="answer"]') || queEl?.querySelector('textarea');
  if (textarea) return textarea.value || '';
  return '';
}

function setAceCode(queEl, code) {
  // Method 1: Ace editor API (best)
  const editor = getAceEditor(queEl);
  if (editor) {
    try {
      editor.setValue(code, -1); // -1 = don't select, put cursor at start
      editor.clearSelection();
      editor.moveCursorTo(0, 0);
      console.log('[Prelab] Code set via Ace editor API');
      // Also update hidden textarea for form submission
      syncAceToTextarea(queEl);
      return true;
    } catch(e) {
      console.warn('[Prelab] Ace editor API failed:', e);
    }
  }

  // Method 2: Use the hidden ace_text-input with select-all + paste
  const aceInput = queEl?.querySelector('.ace_text-input');
  if (aceInput) {
    aceInput.focus();
    // Select all existing content then paste
    document.execCommand('selectAll', false, null);
    const dt = new DataTransfer();
    dt.setData('text/plain', code);
    aceInput.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true }));
    console.log('[Prelab] Code set via paste to ace_text-input');
    return true;
  }

  // Method 3: Hidden textarea fallback
  const textarea = queEl?.querySelector('textarea[name*="answer"]') || queEl?.querySelector('textarea');
  if (textarea) {
    setNativeValue(textarea, code, true);
    console.log('[Prelab] Code set via textarea fallback');
    return true;
  }

  return false;
}

// Sync Ace editor content to the hidden Moodle textarea
function syncAceToTextarea(queEl) {
  const editor = getAceEditor(queEl);
  if (!editor) return;
  const textarea = queEl?.querySelector('textarea[name*="answer"]') || queEl?.querySelector('textarea');
  if (textarea) {
    const code = editor.getValue();
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
    if (setter) setter.call(textarea, code);
    else textarea.value = code;
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    textarea.dispatchEvent(new Event('change', { bubbles: true }));
  }
}

// ── Router ─────────────────────────────────────────────────────────────────────
async function handleStart({ ai, mode, prompt }) {
  if (mode === 'solve')  {
    await chrome.storage.local.set({ solveRetryCount: 0 });
    return handleSolve(ai, prompt);
  }
  if (mode === 'select') return startSnipTool(ai, prompt);
  if (mode === 'text')   return dispatch(ai, { type: 'text', text: extractText(), prompt });
  dispatch(ai, { type: 'image', dataUrl: await captureTab(), prompt });
}

// ── Retry handler (dipanggil saat Gemini timeout) ──────────────────────────────
async function retrySolve() {
  const MAX_RETRY = 3;
  const d = await storageGet(['activeMode', 'ai', 'batchPrompt', 'solveRetryCount', 'isBatching']);
  if (!d.isBatching) return;

  const retryCount = Number(d.solveRetryCount ?? 0);
  const ui = document.getElementById('pai-ui');

  if (retryCount >= MAX_RETRY) {
    setStatus(`Gagal setelah ${MAX_RETRY}x percobaan. Dihentikan.`, ui);
    chrome.storage.local.set({ isBatching: false });
    setTimeout(() => ui?.remove(), 4000);
    return;
  }

  const nextCount = retryCount + 1;
  await chrome.storage.local.set({ solveRetryCount: nextCount });

  setStatus(`Mencoba ulang (${nextCount}/${MAX_RETRY})...`, ui);
  console.log(`[Prelab] Retrying solve attempt ${nextCount}/${MAX_RETRY}`);

  await sleep(2000);
  if (!(await isStillBatching())) return;

  handleSolve(d.ai ?? 'gemini', d.batchPrompt ?? '', true);
}

// ── Shared UI ──────────────────────────────────────────────────────────────────
function renderUI(ai, prompt) {
  let ui = document.getElementById('pai-ui');
  const platform = detectPlatform();
  const platformLabels = { ilab: 'iLab', vclass: 'vClass', generic: '—' };

  if (!ui) {
    ui = document.createElement('div');
    ui.id = 'pai-ui';
    Object.assign(ui.style, {
      position: 'fixed', bottom: '24px', right: '24px',
      background: 'rgba(30, 30, 32, 0.85)', backdropFilter: 'blur(24px)',
      WebkitBackdropFilter: 'blur(24px)',
      border: '1px solid rgba(255, 255, 255, 0.08)', borderRadius: '14px',
      padding: '12px 16px', zIndex: '2147483647',
      fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
      color: '#F5F5F7', fontSize: '12.5px', boxShadow: '0 8px 32px rgba(0, 0, 0, 0.24)',
      minWidth: '240px', maxWidth: '320px', display: 'flex', flexDirection: 'column', gap: '8px',
    });
    ui.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:space-between;padding-bottom:6px;border-bottom:1px solid rgba(255,255,255,0.06);">
        <div style="display:flex;align-items:center;gap:6px;">
          <span style="font-weight:600;font-size:12px;color:#EBEBF5;opacity:0.9;">PRELAB</span>
          <span style="font-size:10px;color:#8E8E93;background:rgba(118,118,128,0.2);padding:1px 6px;border-radius:4px;font-weight:500;">${platformLabels[platform]}</span>
        </div>
        <button id="pai-stop" style="background:transparent;color:#EBEBF5;opacity:0.6;border:none;border-radius:12px;cursor:pointer;font-weight:500;font-size:11px;padding:2px 6px;transition:all 0.2s;">Batal</button>
      </div>
      <div id="pai-status" style="font-size:13px;color:#FFFFFF;line-height:1.4;font-weight:400;margin-top:2px;"></div>
    `;
    document.body.appendChild(ui);

    const stopBtn = document.getElementById('pai-stop');
    stopBtn.addEventListener('mouseover', () => { stopBtn.style.color = '#FF453A'; stopBtn.style.opacity = '1'; stopBtn.style.background = 'rgba(255, 69, 58, 0.1)'; });
    stopBtn.addEventListener('mouseout', () => { stopBtn.style.color = '#EBEBF5'; stopBtn.style.opacity = '0.6'; stopBtn.style.background = 'transparent'; });
    
    stopBtn.addEventListener('click', () => {
      window.__prelabAborted = true; // INSTANT ABORT FLAG
      try {
        chrome.storage.local.set({ isBatching: false });
        chrome.runtime.sendMessage({ action: 'STOP_PROCESS' }); // Matikan tab AI jika sedang terbuka
      } catch (e) {
        console.warn('[Prelab] Context invalidated. Extension reloaded?', e);
      }
      ui.innerHTML = `<div style="padding:12px;text-align:center;color:#ff453a;font-weight:700;font-size:13px;">🛑 Proses dihentikan paksa.</div>`;
      setTimeout(() => ui?.remove(), 2500);
    });
  }
  setStatus(`<span style="opacity:0.6">Tugas otomatis berjalan...</span>`, ui);
  return ui;
}

function setStatus(msg, ui = document.getElementById('pai-ui')) {
  const el = ui?.querySelector('#pai-status');
  if (el) el.innerHTML = msg;
}

// ── Auto-Solve mode ────────────────────────────────────────────────────────────
async function handleSolve(ai, prompt, isRetry = false) {
  const d = await storageGet(['isBatching']);
  if (!d.isBatching) return;
  
  if (!isRetry) {
    await chrome.storage.local.set({ solveRetryCount: 0, precheckRetryCount: 0 });
    await chrome.storage.local.remove(['precheckError', 'precheckCode']);
  }

  const ui = renderUI(ai, prompt);
  const platform = detectPlatform();

  if (platform === 'ilab') {
    // Tunggu minimal ada .que element atau document.readyState complete
    if (document.readyState !== 'complete') {
      await new Promise(res => window.addEventListener('load', res, { once: true }));
    }
    // Polling singkat untuk soal yang diload via JS/AJAX
    let waitTicks = 0;
    while (document.querySelectorAll('.que').length === 0 && waitTicks < 10) {
      await sleep(300);
      waitTicks++;
    }
  }

  // Platform-specific quiz validation
  if (platform === 'ilab') {
    const quiz = detectMoodleQuiz();
    if (quiz.isSummaryPage) {
      setStatus('⚠️ Halaman summary — tidak auto-submit.', ui);
      chrome.storage.local.set({ isBatching: false });
      setTimeout(() => ui?.remove(), 5000);
      return;
    }
    if (quiz.isReviewPage) {
      setStatus('📋 Halaman review — skip.', ui);
      chrome.storage.local.set({ isBatching: false });
      setTimeout(() => ui?.remove(), 3000);
      return;
    }
    if (!quiz.isQuiz) {
      setStatus('⏳ Menunggu halaman quiz...', ui);
      await sleep(2000);
      const quiz2 = detectMoodleQuiz();
      if (!quiz2.isQuiz) {
        setStatus('❌ Bukan halaman quiz iLab.', ui);
        chrome.storage.local.set({ isBatching: false });
        setTimeout(() => ui?.remove(), 4000);
        return;
      }
    }
    // CHECK apakah semua soal di halaman ini SUDAH dijawab (feedback visible)
    // Ini terjadi saat page reload setelah CHECK — jangan re-solve!
    const questions = document.querySelectorAll('.que');
    const allHaveFeedback = questions.length > 0 && [...questions].every(q => {
      const isCorrectLike = q.classList.contains('correct') || q.classList.contains('partiallycorrect') || q.querySelector('.rightanswer');
      if (isCorrectLike) return true;
      if (q.classList.contains('incorrect')) {
        const hasCheckBtn = findButton(q, ['check', 'periksa', 'submit'], ['precheck', 'pre-check']);
        return !hasCheckBtn; // Jika TIDAK ada tombol Check -> final. Jika ADA -> belum final (boleh retry)
      }
      return false; // Jika belum final, jangan anggap sudah selesai
    });

    if (allHaveFeedback) {
      setStatus('📋 Soal sudah dijawab, navigasi ke berikutnya...', ui);
      await sleep(800);
      navigateNext(msg => setStatus(msg, ui));
      return;
    }

    setStatus(`📝 Terdeteksi ${quiz.questionCount} soal di halaman ini.`, ui);
    await sleep(500);
  }

  setStatus('📸 Menangkap soal...', ui);
  const dataUrl = await captureTab();
  if (!dataUrl) { setStatus('Gagal menangkap layar.', ui); return; }

  if (!(await isStillBatching())) return;

  // Tambah context platform ke prompt
  let enrichedPrompt = prompt || '';
  if (platform === 'ilab') {
    enrichedPrompt = buildIlabContext() + '\n' + enrichedPrompt;

    // Tambah existing code context untuk CodeRunner
    const codeContext = extractCodeRunnerContext();
    if (codeContext) enrichedPrompt = codeContext + '\n' + enrichedPrompt;

    // Tambah error context dari precheck retry
    const errorContext = await getRetryErrorContext();
    if (errorContext) enrichedPrompt = errorContext + '\n' + enrichedPrompt;
  }

  setStatus('🧠 Menganalisis soal...', ui);
  dispatch(ai, { type: 'solve_image', dataUrl, prompt: enrichedPrompt });
  setStatus('⏳ Menunggu balasan Gemini...', ui);
}

// ── iLab context builder ───────────────────────────────────────────────────────
function buildIlabContext() {
  const questions = document.querySelectorAll('.que');
  if (questions.length === 0) return '';

  const parts = [];
  questions.forEach((q, i) => {
    const type = detectQuestionType(q);
    const qText = q.querySelector('.qtext')?.innerText?.trim() || '';
    const options = [];

    if (type === 'multichoice' || type === 'truefalse') {
      q.querySelectorAll('.answer label, .answer .d-flex, .answer div[data-region]').forEach(label => {
        const txt = label.innerText?.trim();
        if (txt) options.push(txt);
      });
    }

    let info = `Soal ${i + 1} [${type}]`;
    if (qText) info += `: "${qText.slice(0, 200)}"`;
    if (options.length > 0) info += ` | Opsi: ${options.map((o, j) => `(${j + 1}) ${o}`).join(', ')}`;
    parts.push(info);
  });

  return `[CONTEXT: Platform iLab Gunadarma (Moodle). ${parts.join(' || ')}]`;
}

// ── CodeRunner context: extract existing template code ─────────────────────────
function extractCodeRunnerContext() {
  const queEl = document.querySelector('.que.coderunner') || 
                document.querySelector('.que');
  if (!queEl) return '';

  const type = detectQuestionType(queEl);
  if (type !== 'coderunner') return '';

  const existingCode = getExistingCode(queEl);
  if (!existingCode.trim()) return '';

  return `[KODE TEMPLATE YANG SUDAH ADA DI EDITOR — JANGAN BUAT ULANG DARI NOL]
\`\`\`
${existingCode}
\`\`\`
PENTING: Ada kode template di atas yang SUDAH tertulis di editor.
Kamu HARUS mengembalikan SELURUH kode program yang sudah DILENGKAPI (termasuk boilerplate/template yang sudah ada).
JANGAN hanya mengembalikan baris yang ditambahkan saja. Kembalikan kode UTUH dari baris 1 sampai akhir.
Pastikan tidak ada duplikasi class/method/import.`;
}

// ── Precheck retry error context ───────────────────────────────────────────────
async function getRetryErrorContext() {
  const d = await storageGet(['precheckError', 'precheckCode', 'precheckRetryCount']);
  if (!d.precheckError) return '';

  // Clear after reading
  await chrome.storage.local.remove(['precheckError', 'precheckCode']);

  return `[PERCOBAAN SEBELUMNYA GAGAL PRECHECK — PERBAIKI!]
Error dari PRECHECK: "${d.precheckError}"
Kode yang dicoba sebelumnya:
\`\`\`
${d.precheckCode || '(tidak tersedia)'}
\`\`\`
PERBAIKI kode di atas berdasarkan error message precheck. Perhatikan output yang diharapkan vs output aktual.
Ini percobaan ke-${d.precheckRetryCount || 1}.`;
}

// ══════════════════════════════════════════════════════════════════════════════
// FILL ANSWER — Router
// ══════════════════════════════════════════════════════════════════════════════
function executeFillAnswer(json) {
  const platform = detectPlatform();
  console.log(`[Prelab] Fill answer on platform: ${platform}`, json);

  if (platform === 'ilab')    return ilabFillAnswer(json);
  if (platform === 'vclass')  return vclassFillAnswer(json);
  return genericFillAnswer(json);
}

// ══════════════════════════════════════════════════════════════════════════════
// iLab (Moodle) — Fill Answer
// ══════════════════════════════════════════════════════════════════════════════
function ilabFillAnswer(json) {
  const ui          = document.getElementById('pai-ui');
  const status      = msg => setStatus(msg, ui);
  
  // originalJaw bisa jadi array (untuk multi-select checkbox) atau string
  const isArray     = Array.isArray(json.jawaban);
  const originalJaw = isArray ? json.jawaban : String(json.jawaban ?? '').trim();
  const jaw         = isArray ? originalJaw.map(s => String(s).toUpperCase()) : String(originalJaw).toUpperCase();
  const idxHint     = Number(json.index_pilihan ?? 0);

  if (!originalJaw || (isArray && originalJaw.length === 0)) { status('❌ Tidak ada jawaban diterima.'); return; }
  
  const displayJaw = isArray ? originalJaw.join(', ') : originalJaw;
  status(`✍️ Menerapkan: <span style="opacity:0.8">${displayJaw.length > 30 ? '(multiselect/teks panjang)' : displayJaw}</span>`);

  const questions = document.querySelectorAll('.que');
  const queEl = findUnansweredQuestion(questions) || questions[0];

  if (!queEl) {
    status('❌ Tidak ada soal ditemukan di halaman.');
    chrome.storage.local.set({ isBatching: false });
    return;
  }

  const type = detectQuestionType(queEl);
  let filled = false;

  // ── Multichoice / True-False ──────────────────────────────────────────────
  if (type === 'multichoice' || type === 'truefalse') {
    filled = ilabFillMultichoice(queEl, originalJaw, jaw, idxHint, status);
  }

  // ── Short Answer / Numerical ──────────────────────────────────────────────
  if (type === 'shortanswer' || type === 'numerical') {
    filled = ilabFillShortAnswer(queEl, originalJaw, status);
  }

  // ── Essay ─────────────────────────────────────────────────────────────────
  if (type === 'essay') {
    filled = ilabFillEssay(queEl, originalJaw, status);
  }

  // ── CodeRunner ────────────────────────────────────────────────────────────
  if (type === 'coderunner') {
    filled = ilabFillCodeRunner(queEl, originalJaw, status);
    if (filled) {
      // CodeRunner: lakukan PRECHECK dulu, jangan langsung navigate
      setTimeout(() => ilabPrecheckFlow(queEl, status), 1500);
      return; // <-- Jangan navigate next dulu!
    }
  }

  // ── Unknown type — fallback ke generic ────────────────────────────────────
  if (!filled && type === 'unknown') {
    filled = genericFillInQuestion(queEl, originalJaw, jaw, idxHint, status);
  }

  if (!filled) {
    status('❌ Gagal mengisi jawaban. Tipe soal: ' + (type || 'unknown'));
    chrome.storage.local.set({ isBatching: false });
    setTimeout(() => document.getElementById('pai-ui')?.remove(), 4000);
    return;
  }

  // ── Non-CodeRunner: langsung navigate (atau CHECK dulu kalau ada) ─────────
  setTimeout(() => ilabCheckAndNavigate(queEl, status), 1200);
}

// ══════════════════════════════════════════════════════════════════════════════
// iLab: PRECHECK → Retry → CHECK → Navigate (untuk CodeRunner)
// ══════════════════════════════════════════════════════════════════════════════

var MAX_PRECHECK_RETRIES = 3;  // var agar tidak error saat re-inject

async function ilabPrecheckFlow(queEl, status) {
  if (!(await isStillBatching())) return;

  // Cari tombol PRECHECK
  const precheckBtn = findButton(queEl, ['precheck']);
  
  if (!precheckBtn) {
    status('⚠️ Tombol PRECHECK tidak ditemukan. Langsung CHECK...');
    await sleep(500);
    return ilabCheckAndNavigate(queEl, status);
  }

  // Sync Ace editor ke textarea sebelum precheck
  syncAceToTextarea(queEl);
  await sleep(300);

  // Bersihkan result precheck lama (jika ada) BElUM kita klik
  clearPrecheckResult(queEl);

  status('🔍 Menjalankan PRECHECK...');
  fireClick(precheckBtn);

  // Tunggu hasil PRECHECK muncul (polling DOM)
  const resultEl = await waitForPrecheckResult(queEl, 25000);

  if (!resultEl) {
    status('⚠️ Hasil PRECHECK tidak muncul. Langsung CHECK...');
    return ilabCheckAndNavigate(queEl, status);
  }

  // Parse hasil PRECHECK
  const resultText = (resultEl.innerText || resultEl.textContent || '').trim();
  const isPassed = parsePrecheckResult(resultText, resultEl);

  if (isPassed) {
    status('✅ PRECHECK berhasil! Menjalankan CHECK...');
    await sleep(800);
    return ilabCheckAndNavigate(queEl, status);
  }

  // PRECHECK gagal — cek retry count
  const d = await storageGet(['precheckRetryCount']);
  const retryCount = Number(d.precheckRetryCount ?? 0);

  if (retryCount >= MAX_PRECHECK_RETRIES) {
    status(`❌ PRECHECK gagal ${MAX_PRECHECK_RETRIES}x. Menghentikan bot agar Anda bisa koreksi manual.`);
    await saveErrorScreenshot(queEl, resultText);
    chrome.storage.local.set({ isBatching: false });
    window.__prelabAborted = true;
    setTimeout(() => document.getElementById('pai-ui')?.remove(), 7000);
    return; // STOP! Jangan cek atau navigate.
  }

  // Retry: simpan error context & kirim ulang ke Gemini
  const nextRetry = retryCount + 1;
  const existingCode = getExistingCode(queEl);
  
  status(`🔄 PRECHECK gagal. Retry ${nextRetry}/${MAX_PRECHECK_RETRIES}...`);

  await chrome.storage.local.set({
    precheckError: resultText.slice(0, 2500),
    precheckCode: existingCode,
    precheckRetryCount: nextRetry,
  });

  // Clear precheck result before retrying (agar tidak dibaca ulang)
  clearPrecheckResult(queEl);

  await sleep(1500);
  if (!(await isStillBatching())) return;

  // Re-trigger solve flow — Gemini akan lihat screenshot + error context
  const sd = await storageGet(['ai', 'batchPrompt']);
  handleSolve(sd.ai || 'gemini', sd.batchPrompt || '', true);
}

// Tunggu precheck result muncul di DOM
async function waitForPrecheckResult(queEl, timeout = 25000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (window.__prelabAborted) return null; // Instant abort check
    // Cari elemen hasil precheck
    const result = 
      queEl.querySelector('.coderunner-test-results') ||
      queEl.querySelector('.CodeRunner-test-results') ||
      queEl.querySelector('.que-coderunner-result') ||
      queEl.querySelector('.outcome .feedback') ||
      queEl.querySelector('.outcome') ||
      queEl.querySelector('.coderunnerresults') ||
      queEl.querySelector('table.coderunner_test_results') ||
      queEl.querySelector('.precheck-results') ||
      queEl.querySelector('[id*="feedback"]');
    
    if (result && result.innerText?.trim().length > 5) {
      return result;
    }
    await sleep(500);
  }
  return null;
}

// Parse PRECHECK result — return true if all tests passed
function parsePrecheckResult(text, el) {
  const lower = text.toLowerCase();
  
  // Explicit pass indicators
  if (lower.includes('passed all') || lower.includes('all correct') || 
      lower.includes('semua benar') || lower.includes('mark: 1') ||
      lower.includes('passed')) {
    // Double check: pastikan tidak ada "failed" juga
    if (!lower.includes('fail') && !lower.includes('error') && !lower.includes('wrong')) {
      return true;
    }
  }
  
  // Cek tabel Coderunner: samakan Expected dan Got
  const rows = el.querySelectorAll('tr');
  if (rows.length > 1) {
    let expectedIdx = -1;
    let gotIdx = -1;
    
    // Cari index kolom
    const headers = rows[0].querySelectorAll('th');
    headers.forEach((th, i) => {
      const hd = (th.innerText || th.textContent || '').toLowerCase().trim();
      if (hd === 'expected') expectedIdx = i;
      if (hd === 'got') gotIdx = i;
    });

    if (expectedIdx !== -1 && gotIdx !== -1) {
      // Jika ada kolom Expected dan Got, bandingkan tiap baris data
      const allMatched = [...rows].slice(1).every(row => {
        const cells = row.querySelectorAll('td');
        if (!cells[expectedIdx] || !cells[gotIdx]) return true; // abaikan jika baris tidak lengkap
        const expected = (cells[expectedIdx].innerText || cells[expectedIdx].textContent || '').trim();
        const got = (cells[gotIdx].innerText || cells[gotIdx].textContent || '').trim();
        return expected !== '' && expected === got; 
      });
      if (allMatched) return true;
      // Jika Expected dan Got ditemukan tapi tidak match, pasti gagal (salah)
      return false;
    }

    // Fallback: Check for green tick marks in the table
    const allPassed = [...rows].slice(1).every(row => {
      const cells = row.querySelectorAll('td');
      const lastCell = cells[cells.length - 1];
      return lastCell?.classList.contains('correct') || 
             lastCell?.textContent?.includes('✓') ||
             lastCell?.textContent?.includes('Pass') ||
             row.classList.contains('correct');
    });
    if (allPassed) return true;
  }

  // Explicit fail indicators
  if (lower.includes('fail') || lower.includes('error') || lower.includes('wrong') ||
      lower.includes('salah') || lower.includes('expected') || lower.includes('got')) {
    return false;
  }

  // Unknown — assume fail to trigger retry
  return false;
}

// Clear precheck result from DOM so it doesn't interfere with next precheck
function clearPrecheckResult(queEl) {
  const results = queEl.querySelectorAll(
    '.coderunner-test-results, .CodeRunner-test-results, .que-coderunner-result, .outcome .feedback, .outcome, .coderunnerresults, table.coderunner_test_results, .precheck-results, [id*="feedback"]'
  );
  results.forEach(el => { try { el.innerHTML = ''; } catch {/***/} });
}

// ══════════════════════════════════════════════════════════════════════════════
// iLab: CHECK & Navigate (untuk semua tipe soal)
// ══════════════════════════════════════════════════════════════════════════════

async function ilabCheckAndNavigate(queEl, status) {
  if (!(await isStillBatching())) return;

  // Sync Ace to textarea sebelum submit (untuk CodeRunner)
  syncAceToTextarea(queEl);
  await sleep(300);

  // Reset precheck retry count untuk soal ini
  await chrome.storage.local.remove(['precheckError', 'precheckCode', 'precheckRetryCount']);

  // Cari tombol CHECK / Submit (JANGAN sampai kepencet Precheck lagi!)
  const checkBtn = findButton(queEl, ['check', 'periksa', 'submit'], ['precheck', 'pre-check']);
  
  if (checkBtn) {
    status('📝 Menjalankan CHECK...');

    // Flag to detect if form submission causes page reload
    let isUnloading = false;
    const unloadListener = () => { isUnloading = true; };
    window.addEventListener('beforeunload', unloadListener);
    window.addEventListener('unload', unloadListener);

    fireClick(checkBtn);
    
    // Polling page update setelah CHECK (AJAX atau Reload)
    let ajaxDone = false;
    let ticks = 0;
    while(ticks < 30) { // maks 15 detik
      await sleep(500);
      if (isUnloading || window.__prelabAborted) {
         status('⏳ Halaman sedang dimuat ulang...');
         window.removeEventListener('beforeunload', unloadListener);
         window.removeEventListener('unload', unloadListener);
         return; // JANGAN panggil navigateNext, karena reload sedang berjalan (menghindari dibatalkannya post check)
      }
      if (queEl.classList.contains('correct') || queEl.classList.contains('incorrect') || queEl.querySelector('.outcome') || queEl.classList.contains('complete')) {
         ajaxDone = true;
         break;
      }
      ticks++;
    }

    window.removeEventListener('beforeunload', unloadListener);
    window.removeEventListener('unload', unloadListener);

    if (!ajaxDone) {
      status('⚠️ CHECK selesai, tidak ada respons AJAX yang terdeteksi.');
    } else {
      // Cek hasil CHECK
      const isCorrect = checkIfCorrect(queEl);
      if (isCorrect === true) {
        status('✅ Jawaban BENAR!');
      } else if (isCorrect === false) {
        const d = await storageGet(['precheckRetryCount']);
        const retryCount = Number(d.precheckRetryCount ?? 0);
        
        if (retryCount >= MAX_PRECHECK_RETRIES) {
          status(`❌ CHECK gagal ${MAX_PRECHECK_RETRIES}x. Menghentikan bot.`);
          const questionText = queEl.querySelector('.qtext')?.innerText?.trim() || '';
          await saveErrorScreenshot(queEl, `CHECK failed: ${questionText.slice(0, 100)}`);
          chrome.storage.local.set({ isBatching: false });
          window.__prelabAborted = true;
          setTimeout(() => document.getElementById('pai-ui')?.remove(), 7000);
          return; // STOP!
        }
        
        const nextRetry = retryCount + 1;
        status(`🔄 CHECK gagal. Retry ${nextRetry}/${MAX_PRECHECK_RETRIES}...`);
        
        const feedbackEl = queEl.querySelector('.outcome, .feedback, .coderunner-test-results, .CodeRunner-test-results') || queEl;
        const errText = feedbackEl.innerText || '';
        const existingCode = getExistingCode(queEl) || '';
        
        await chrome.storage.local.set({
          precheckError: errText.slice(0, 2500),
          precheckCode: existingCode,
          precheckRetryCount: nextRetry
        });
        
        clearPrecheckResult(queEl);
        
        await sleep(1500);
        if (!(await isStillBatching())) return;
        
        const sd = await storageGet(['ai', 'batchPrompt']);
        return handleSolve(sd.ai || 'gemini', sd.batchPrompt || '', true); // Retry!
      } else {
        status('📋 CHECK selesai.');
      }
      await sleep(1500);
    }
  }

  // Navigate to next question jika tidak terjadi page reload
  navigateNext(status);
}

// Check if answer is correct after CHECK (look at Moodle feedback)
function checkIfCorrect(queEl) {
  if (!queEl) return null;
  
  const cl = queEl.classList;
  if (cl.contains('correct'))           return true;
  if (cl.contains('incorrect'))         return false;
  if (cl.contains('partiallycorrect'))  return false;

  // Check feedback elements
  const feedback = queEl.querySelector('.outcome, .feedback, .state');
  if (feedback) {
    const text = feedback.innerText?.toLowerCase() || '';
    if (text.includes('correct') || text.includes('benar')) return true;
    if (text.includes('incorrect') || text.includes('salah')) return false;
  }

  // Check grade
  const grade = queEl.querySelector('.grade, .mark');
  if (grade) {
    const text = grade.innerText || '';
    const match = text.match(/(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)/);
    if (match) {
      const [, got, total] = match;
      return parseFloat(got) >= parseFloat(total);
    }
  }

  return null; // unknown
}

// ── Save error screenshot ──────────────────────────────────────────────────────
async function saveErrorScreenshot(queEl, errorText) {
  try {
    const dataUrl = await captureTab();
    const questionText = queEl?.querySelector('.qtext')?.innerText?.trim() || 'Unknown';

    const d = await storageGet(['errorLogs']);
    const logs = d.errorLogs || [];
    logs.push({
      timestamp: Date.now(),
      date: new Date().toLocaleString('id-ID'),
      question: questionText.slice(0, 300),
      error: (errorText || '').slice(0, 800),
      screenshot: dataUrl,
      url: location.href,
    });

    // Keep only last 30 entries
    if (logs.length > 30) logs.splice(0, logs.length - 30);

    await chrome.storage.local.set({ errorLogs: logs });
    console.log(`[Prelab] Error screenshot saved. Total logs: ${logs.length}`);
  } catch(e) {
    console.warn('[Prelab] Failed to save error screenshot:', e);
  }
}

// ── iLab: Multichoice filler ────────────────────────────────────────────────
function ilabFillMultichoice(queEl, originalJaw, jaw, idxHint, status) {
  const norm = s => String(s).toUpperCase()
    .replace(/\s+/g, '')
    .replace(/\\?SQRT|AKAR/g, '√')
    .replace(/\\/g, '')
    .replace(/[{}()[\]]/g, '')
    .trim();

  // Support array (multi-select)
  const isArray = Array.isArray(jaw);
  const jawArr = isArray ? jaw : [jaw];
  const jawNormArr = jawArr.map(j => norm(j));

  const radios = [...queEl.querySelectorAll('input[type="radio"], input[type="checkbox"]')];

  console.log(`[Prelab] Multichoice: ${radios.length} inputs (radio+checkbox), jawaban="${originalJaw}", idx=${idxHint}`);
  if (radios.length === 0) {
    console.warn('[Prelab] Tidak ada radio/checkbox ditemukan di question element');
    return false;
  }

  const options = radios.map((radio, i) => {
    const text = getRadioLabelText(radio, queEl);
    return { radio, text, index: i };
  });

  let matchCount = 0;

  // Kita loop tiap jawaban yang diberikan AI
  for (let k = 0; k < jawArr.length; k++) {
    const currentJaw = jawArr[k];
    const currentJawNorm = jawNormArr[k];
    let matched = false;

    // Strategy 1: Exact Match
    for (const opt of options) {
      if (opt.radio.checked) continue;

      const raw   = opt.text.toUpperCase().trim();
      const clean = raw.replace(/^[A-Ea-e][.)\s]+/i, '').trim();
      const rNorm = norm(opt.text);
      const cNorm = norm(clean);
      const val   = (opt.radio.value || '').toUpperCase().trim();

      if (raw === currentJaw || clean === currentJaw || rNorm === currentJawNorm || cNorm === currentJawNorm || val === currentJaw) {
        moodleClickRadio(opt.radio);
        highlightElement(opt.radio.closest('.r0,.r1,.r2,.r3,.r4,div,label') || opt.radio.parentElement);
        matched = true;
        matchCount++;
        break;
      }
    }

    // Strategy 2: Prefix Match
    if (!matched) {
      for (const opt of options) {
        if (opt.radio.checked) continue;
        const raw = opt.text.toUpperCase().trim();
        if (raw.startsWith(currentJaw + '.') || raw.startsWith(currentJaw + ')')) {
          moodleClickRadio(opt.radio);
          highlightElement(opt.radio.closest('.r0,.r1,.r2,.r3,.r4,div,label') || opt.radio.parentElement);
          matched = true;
          matchCount++;
          break;
        }
      }
    }

    // Strategy 3: Index Hint
    if (!matched && !isArray && idxHint > 0 && idxHint <= radios.length) {
      const target = radios[idxHint - 1];
      moodleClickRadio(target);
      highlightElement(target.closest('div') || target.parentElement);
      matched = true;
      matchCount++;
    }

    // Strategy 4: Letter Fallback (A-E)
    if (!matched && !isArray && currentJaw.length === 1 && currentJaw >= 'A' && currentJaw <= 'E') {
      const idx = currentJaw.charCodeAt(0) - 65;
      if (idx < radios.length) {
        moodleClickRadio(radios[idx]);
        highlightElement(radios[idx].closest('div') || radios[idx].parentElement);
        matched = true;
        matchCount++;
      }
    }

    // Strategy 5: Partial Match / Includes (Beresiko false positive)
    if (!matched) {
      for (const opt of options) {
        if (opt.radio.checked) continue;
        const raw   = opt.text.toUpperCase().trim();
        const clean = raw.replace(/^[A-E][.)\s]+/i, '').trim();
        const rNorm = norm(opt.text);
        const cNorm = norm(clean);

        if (rNorm.includes(currentJawNorm) || cNorm.includes(currentJawNorm) || (currentJaw.length > 3 && (opt.text.toUpperCase().includes(currentJaw) || currentJaw.includes(clean)))) {
          moodleClickRadio(opt.radio);
          highlightElement(opt.radio.closest('div') || opt.radio.parentElement);
          matched = true;
          matchCount++;
          break;
        }
      }
    }
  }

  if (matchCount > 0) {
    status(`✅ Dipilih ${matchCount} opsi jawaban.`);
    return true;
  }

  console.warn('[Prelab] Multichoice: tidak ada opsi yang cocok dengan jawaban');
  return false;
}

// Find label text for a radio/checkbox (robust for Moodle DOM)
function getRadioLabelText(radio, queEl) {
  // Strategy 1: Cari parent row (wrapper) dari jawaban ini
  const row = radio.closest('.r0, .r1, .r2, .r3, .r4, .d-flex, .align-items-center, div[class*="answer"] > div');
  if (row) {
    const clone = row.cloneNode(true);
    // Hapus elemen input agar value-nya/teksnya tidak ikut terambil
    clone.querySelectorAll('input').forEach(el => el.remove());
    const txt = (clone.innerText || clone.textContent || '').trim();
    if (txt) return txt;
  }

  // Strategy 2: label[for="radio.id"]
  if (radio.id) {
    const label = queEl.querySelector(`label[for="${CSS.escape(radio.id)}"]`);
    if (label && label.innerText?.trim()) return label.innerText.trim();
  }

  // Strategy 3: Parent atau Sibling label/div
  const parentLabel = radio.closest('label');
  if (parentLabel && parentLabel.innerText?.trim()) return parentLabel.innerText.trim();

  let sibling = radio.nextElementSibling;
  while (sibling) {
    if (sibling.tagName === 'LABEL' || sibling.tagName === 'DIV' || sibling.tagName === 'SPAN') {
      const txt = sibling.innerText?.trim();
      if (txt) return txt;
    }
    sibling = sibling.nextElementSibling;
  }

  // Default fallback text kalau nge-blank
  return radio.value || '';
}

// ── iLab: Short Answer filler ───────────────────────────────────────────────
function ilabFillShortAnswer(queEl, jawaban, status) {
  const inputs = [...queEl.querySelectorAll('.answer input[type="text"], .formulation input[type="text"], input[type="text"][name*="answer"]')];
  
  if (inputs.length === 0) return false;

  const jawArr = Array.isArray(jawaban) ? jawaban : [jawaban];
  let filledCount = 0;

  for (let i = 0; i < inputs.length; i++) {
    const val = i < jawArr.length ? jawArr[i] : (jawArr.length === 1 ? jawArr[0] : null);
    if (val !== null && val !== undefined) {
      setNativeValue(inputs[i], String(val));
      highlightElement(inputs[i]);
      filledCount++;
    }
  }

  if (filledCount > 0) {
    status(`✅ Diisi: ${filledCount} kotak isian.`);
    return true;
  }
  return false;
}

// ── iLab: Essay filler ──────────────────────────────────────────────────────
function ilabFillEssay(queEl, jawaban, status) {
  const jText = jawaban.replace(/\\n/g, '\n');

  const attoEditor = queEl.querySelector('[contenteditable="true"]');
  if (attoEditor) {
    attoEditor.focus();
    attoEditor.innerHTML = jText.replace(/\n/g, '<br>');
    attoEditor.dispatchEvent(new Event('input', { bubbles: true }));
    attoEditor.dispatchEvent(new Event('change', { bubbles: true }));
    highlightElement(attoEditor);
    status('✅ Jawaban essay diisi (Atto editor).');
    return true;
  }

  const textarea = queEl.querySelector('textarea:not([hidden])');
  if (textarea) {
    setNativeValue(textarea, jText, true);
    highlightElement(textarea);
    status('✅ Jawaban essay diisi.');
    return true;
  }

  return false;
}

// ── iLab: CodeRunner filler (FIXED: preserves template code) ────────────────
function ilabFillCodeRunner(queEl, jawaban, status) {
  // Check for GapFill / inline <input> first! Many do not have explict type="text".
  const inlineInputs = [...queEl.querySelectorAll('input:not([type="hidden"]):not([type="radio"]):not([type="checkbox"]):not([type="submit"]):not([type="button"])')].filter(el => {
    return el.offsetParent !== null && !el.classList.contains('ace_text-input');
  });
  
  if (inlineInputs.length > 0) {
    const jawArr = Array.isArray(jawaban) ? jawaban : [jawaban];
    let filledCount = 0;
    for (let i = 0; i < inlineInputs.length; i++) {
      let val = i < jawArr.length ? jawArr[i] : (jawArr.length === 1 ? jawArr[0] : null);
      if (val !== null && val !== undefined) {
        let strVal = String(val);
        setNativeValue(inlineInputs[i], strVal);
        highlightElement(inlineInputs[i]);
        filledCount++;
      }
    }
    if (filledCount > 0) {
      status(`✅ Kode diisi (${filledCount} kotak inline).`);
      return true;
    }
  }

  const jText = Array.isArray(jawaban) ? jawaban.join('\n') : String(jawaban);

  // Method 1: Ace Editor API (best — preserves everything properly)
  const editor = getAceEditor(queEl);
  if (editor) {
    try {
      // Tunggu Ace siapkan session
      editor.setValue(jText, -1);
      editor.clearSelection();
      editor.moveCursorTo(0, 0);
      syncAceToTextarea(queEl);
      highlightElement(queEl.querySelector('.ace_editor'));
      status('✅ Kode diisi (Ace Editor API).');
      return true;
    } catch(e) {
      // Jika setValue error karena ada region read-only (CodeRunner GapFill versi Editor), 
      // kita gunakan selectAll + insert yang secara otomatis mematuhi batas read-only!
      try {
        editor.selection.selectAll();
        editor.insert(jText);
        syncAceToTextarea(queEl);
        highlightElement(queEl.querySelector('.ace_editor'));
        status('✅ Kode diisi (Ace Insert Fallback).');
        return true;
      } catch (err2) {
        console.warn('[Prelab] Ace API fallback failed:', err2);
      }
    }
  }

  // Method 2: Ace text-input paste (select all → paste full code)
  const aceInput = queEl.querySelector('.ace_text-input');
  if (aceInput) {
    aceInput.focus();

    // Gunakan perintah browser native untuk menyeleksi semua teks (lama)
    document.execCommand('selectAll', false, null);
    
    // Fallback delete events in case it's a protected Ace Editor region
    aceInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', keyCode: 46, bubbles: true }));
    aceInput.dispatchEvent(new KeyboardEvent('keyup',   { key: 'Delete', keyCode: 46, bubbles: true }));
    
    // Small delay then paste
    setTimeout(() => {
      const dt = new DataTransfer();
      dt.setData('text/plain', jText);
      aceInput.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true }));
    }, 100);
    
    highlightElement(queEl.querySelector('.ace_editor') || aceInput);
    status('✅ Kode diisi (Ace paste).');
    return true;
  }

  // Method 3: Hidden textarea fallback
  const textarea = queEl.querySelector('textarea[name*="answer"]') || queEl.querySelector('textarea');
  if (textarea) {
    setNativeValue(textarea, jText, true);
    highlightElement(textarea);
    status('✅ Kode diisi (textarea).');
    return true;
  }

  return false;
}

// ── Generic fill for unknown question types ─────────────────────────────────
function genericFillInQuestion(queEl, originalJaw, jaw, idxHint, status) {
  const radios = [...queEl.querySelectorAll('input[type="radio"], input[type="checkbox"]')];
  for (const r of radios) {
    if ((r.value || '').toUpperCase().trim() === jaw) {
      moodleClickRadio(r);
      highlightElement(r.closest('label') || r.closest('div'));
      status('✅ Jawaban dipilih (generic).');
      return true;
    }
  }

  const inputs = [...queEl.querySelectorAll('input[type="text"]')];
  if (inputs.length > 0) {
    const jawArr = Array.isArray(originalJaw) ? originalJaw : [originalJaw];
    let filledCount = 0;
    for (let i = 0; i < inputs.length; i++) {
      const val = i < jawArr.length ? jawArr[i] : (jawArr.length === 1 ? jawArr[0] : null);
      if (val !== null && val !== undefined) {
        setNativeValue(inputs[i], String(val));
        highlightElement(inputs[i]);
        filledCount++;
      }
    }
    if (filledCount > 0) {
      status(`✅ Jawaban diisi (${filledCount} kotak).`);
      return true;
    }
  }

  const textarea = queEl.querySelector('textarea:not([hidden])');
  if (textarea) {
    setNativeValue(textarea, originalJaw.replace(/\\n/g, '\n'), true);
    highlightElement(textarea);
    status('✅ Jawaban diisi (generic textarea).');
    return true;
  }

  return false;
}

// ── Moodle navigation ──────────────────────────────────────────────────────────
function navigateNext(status) {
  const platform = detectPlatform();

  if (platform === 'ilab') {
    return ilabNavigateNext(status);
  }
  return genericNavigateNext(status);
}

function ilabNavigateNext(status) {
  const nextSelectors = [
    'input[type="submit"][name="next"]',
    '.mod_quiz-next-nav',
    'input[value*="Halaman berikutnya"]',
    'input[value*="Next page"]',
    'input[value*="Selanjutnya"]',
    '.submitbtns input[type="submit"]:not([name="previous"])',
    'button[type="submit"]:not([name="previous"])',
  ];

  // DANGER CHECK: jangan klik "Submit all and finish"
  const dangerSelectors = [
    'input[name="finishattempt"]',
    'input[value*="Submit all"]',
    'input[value*="Kirim semua"]',
    'input[value*="selesai" i]',
    'button[value*="Submit all"]',
  ];

  for (const sel of dangerSelectors) {
    const dangerBtn = document.querySelector(sel);
    if (dangerBtn) {
      status('🏁 Soal terakhir! Tidak auto-submit. Review dulu.');
      chrome.storage.local.set({ isBatching: false });
      setTimeout(() => document.getElementById('pai-ui')?.remove(), 6000);
      return;
    }
  }

  for (const sel of nextSelectors) {
    const btn = document.querySelector(sel);
    if (btn && (btn.offsetParent !== null || btn.type === 'submit')) {
      status('➡️ Melanjutkan ke soal berikutnya...');
      fireClick(btn);
      return;
    }
  }

  const navButtons = document.querySelectorAll('.qn_buttons a, .quiz-nav-buttons a');
  const notYetAnswered = [...navButtons].find(a => 
    a.classList.contains('notyetanswered') || 
    a.getAttribute('title')?.toLowerCase().includes('not yet answered') ||
    a.getAttribute('title')?.toLowerCase().includes('belum dijawab')
  );

  if (notYetAnswered) {
    status('➡️ Menuju soal yang belum dijawab...');
    notYetAnswered.click();
    return;
  }

  status('🏁 Semua soal selesai! Review jawabanmu.');
  chrome.storage.local.set({ isBatching: false });
  setTimeout(() => document.getElementById('pai-ui')?.remove(), 5000);
}

function genericNavigateNext(status) {
  const nextBtn = findNextButton();
  if (nextBtn) {
    status('➡️ Melanjutkan ke soal berikutnya...');
    fireClick(nextBtn);
    setTimeout(async () => {
      const d = await storageGet(['isBatching', 'activeMode', 'ai', 'batchPrompt']);
      if (d.isBatching && d.activeMode === 'solve') {
        handleStart({ ai: d.ai ?? 'gemini', mode: 'solve', prompt: d.batchPrompt ?? '' });
      }
    }, 3200);
  } else {
    status('🏁 Selesai. Tidak ada tombol lanjut.');
    chrome.storage.local.set({ isBatching: false });
    setTimeout(() => document.getElementById('pai-ui')?.remove(), 4000);
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// vClass — Stub (belum diimplementasi, pakai iLab logic)
// ══════════════════════════════════════════════════════════════════════════════
function vclassFillAnswer(json) {
  console.log('[Prelab] vClass — using iLab logic as fallback');
  return ilabFillAnswer(json);
}

// ══════════════════════════════════════════════════════════════════════════════
// Generic Fill Answer (legacy fallback)
// ══════════════════════════════════════════════════════════════════════════════
function genericFillAnswer(json) {
  const ui          = document.getElementById('pai-ui');
  const status      = msg => setStatus(msg, ui);
  const originalJaw = String(json.jawaban ?? '').trim();
  const jaw         = originalJaw.toUpperCase();
  const idxHint     = Number(json.index_pilihan ?? 0);

  if (!originalJaw) { status('Tidak ada jawaban diterima.'); return; }
  status(`Menerapkan: <span style="opacity:0.8">${originalJaw.length > 30 ? '(teks panjang)' : originalJaw}</span>`);

  let clicked = false;

  const isEssay = (idxHint === 0) || originalJaw.includes('\n') || originalJaw.length > 50;
  if (isEssay) {
    const editors = [
      ...document.querySelectorAll('textarea:not([hidden])'),
      ...document.querySelectorAll('.ace_text-input'),
    ].filter(el => {
      try { return el.offsetParent !== null || el.classList.contains('ace_text-input'); }
      catch { return false; }
    });

    if (editors.length > 0) {
      const el    = editors.find(e => e.classList.contains('ace_text-input')) ?? editors[editors.length - 1];
      const jText = originalJaw.replace(/\\n/g, '\n');
      try {
        setNativeValue(el, jText, el.tagName === 'TEXTAREA');
        const dt = new DataTransfer();
        dt.setData('text/plain', jText);
        el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true }));
        highlightElement(el.closest('.ace_editor, .CodeMirror, .answer, form') ?? el);
        clicked = true;
        status('Masukan berhasil diisikan.');
      } catch(err) {
        console.warn('[Prelab] Essay inject error:', err);
      }
    }
  }

  if (!clicked) {
    const radios = [...document.querySelectorAll('input[type="radio"], input[type="checkbox"]')];
    for (const r of radios) {
      if ((r.value ?? '').toUpperCase().trim() === jaw) {
        fireClick(r); clicked = true; break;
      }
    }
  }

  if (!clicked) {
    status('Opsi tidak ditemukan.');
    chrome.storage.local.set({ isBatching: false });
    return;
  }

  setTimeout(() => navigateNext(status), 900);
}

// ══════════════════════════════════════════════════════════════════════════════
// Shared Helpers
// ══════════════════════════════════════════════════════════════════════════════

function findUnansweredQuestion(questions) {
  for (const q of questions) {
    if (q.classList.contains('notyetanswered') || 
        q.classList.contains('invalidanswer') ||
        !q.classList.contains('complete')) {
      return q;
    }
    const radios = q.querySelectorAll('input[type="radio"]');
    if (radios.length > 0 && ![...radios].some(r => r.checked)) {
      return q;
    }
    const textInput = q.querySelector('input[type="text"]');
    if (textInput && !textInput.value.trim()) {
      return q;
    }
  }
  return null;
}

// Find button by keywords inside a question element or globally
function findButton(queEl, keywords, excludeKeywords = []) {
  // First: cari di dalam question element
  const allBtns = [
    ...queEl.querySelectorAll('button, input[type="button"], input[type="submit"]'),
    // Juga cari di .im-controls (Moodle immediate feedback controls)
    ...(queEl.querySelector('.im-controls')?.querySelectorAll('button, input[type="button"], input[type="submit"]') || []),
  ];

  for (const btn of allBtns) {
    const txt = (btn.innerText || btn.value || btn.name || '').toLowerCase();
    const matchesKeyword = keywords.some(k => txt.includes(k));
    const excluded = excludeKeywords.some(ex => txt.includes(ex));
    
    // Khusus untuk Check vs Precheck: jika mencari 'check' tapi ini 'precheck', harus di-skip.
    if (matchesKeyword && !excluded && btn.offsetParent !== null) {
      // Pastikan kalau cuma nyari 'check', nggak salah klik 'precheck'
      if (keywords.includes('check') && !keywords.includes('precheck') && txt.includes('precheck')) {
         continue;
      }
      return btn;
    }
  }

  // Fallback: cari di .submitbtns global
  const submitBtns = document.querySelectorAll('.submitbtns button, .submitbtns input[type="submit"]');
  for (const btn of submitBtns) {
    const txt = (btn.innerText || btn.value || btn.name || '').toLowerCase();
    const matchesKeyword = keywords.some(k => txt.includes(k));
    const excluded = excludeKeywords.some(ex => txt.includes(ex));
    
    if (matchesKeyword && !excluded) {
      if (keywords.includes('check') && !keywords.includes('precheck') && txt.includes('precheck')) {
         continue;
      }
      return btn;
    }
  }

  return null;
}

function moodleClickRadio(el) {
  if (!el) return;
  
  // Jika checkbox/radio sudah tercentang, biarkan saja
  if (el.type === 'checkbox' && el.checked) return;
  if (el.type === 'radio' && el.checked) return;

  // Gunakan klik native browser agar state toggle pada checkbox sinkron sempurna
  el.click();
  
  // Fallback trigger event manual kalau Moodle gak nangkep (tapi biasanya click() udah cukup)
  el.dispatchEvent(new Event('change', { bubbles: true }));
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

function setNativeValue(el, value, isTextarea = false) {
  el.focus();
  const proto = isTextarea ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  if (setter) {
    setter.call(el, value);
  } else {
    el.value = value;
  }
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

function highlightElement(el) {
  if (!el) return;
  el.style.outline = '2px solid rgba(10, 132, 255, 0.5)';
  el.style.backgroundColor = 'rgba(10, 132, 255, 0.06)';
  el.style.borderRadius = '6px';
  el.style.transition = 'all 0.3s ease';
  setTimeout(() => {
    if (el) {
      el.style.outline = '';
      el.style.backgroundColor = '';
    }
  }, 3000);
}

function fireClick(el) {
  try {
    el.click();
    el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  } catch { /**/ }
}

function findNextButton() {
  const NEXT_KEYWORDS = ['next', 'selanjutnya', 'berikutnya', 'lanjut'];
  return [...document.querySelectorAll('button,a,input[type="button"],input[type="submit"]')]
    .find(b => {
      if (b.offsetWidth === 0 && b.offsetHeight === 0) return false;
      const txt = (b.innerText || b.value || '').toLowerCase();
      return NEXT_KEYWORDS.some(k => txt.includes(k));
    }) ?? null;
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
  return new Promise(res => {
    try {
      chrome.storage.local.get(keys, d => {
        if (chrome.runtime.lastError) console.warn(chrome.runtime.lastError);
        res(d || {});
      });
    } catch (e) {
      res({});
    }
  });
}

async function isStillBatching() {
  if (window.__prelabAborted) return false;
  const d = await storageGet(['isBatching']);
  return !!d.isBatching;
}

function waitForBody(fn) {
  if (document.body) return fn();
  const id = setInterval(() => { if (document.body) { clearInterval(id); fn(); } }, 80);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Polling waitFor helper
function waitFor(fn, timeout = 10000, interval = 300) {
  return new Promise(res => {
    const id = setInterval(() => { 
      if (window.__prelabAborted) { clearInterval(id); res(null); return; }
      const v = fn(); 
      if (v) { clearInterval(id); res(v); } 
    }, interval);
    setTimeout(() => { clearInterval(id); res(null); }, timeout);
  });
}

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
