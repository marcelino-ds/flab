// ── Content script ─────────────────────────────────────────────────────────────
// Guard: jangan double-inject saat executeScript dipanggil manual
'use strict';

import { escapeHtml, sleep } from '../shared/util.js';
import { htmlToMarkdown } from './html-to-markdown.js';
import { detectPlatform, detectMoodleQuiz, detectQuestionType } from './platform.js';
import { getExistingCode, syncAceToTextarea } from './ace-editor.js';
import {
  findUnansweredQuestion, findButton, setNativeValue,
  highlightElement, fireClick, findNextButton, extractText,
  scrollToResultElement, waitForBody, computeProgress,
  isQuestionCorrect, isQuestionIncorrect, canResubmit,
  getGapFillInputs, buildGapFillTemplate,
} from './dom-utils.js';
import { detectQuestionImages, extractQuestionImages, stitchImages } from './question-images.js';
import { getMoodleOptions, getMatchRows } from './moodle-options.js';
import {
  moodleFillMultichoice, moodleFillShortAnswer, moodleFillEssay,
  moodleFillCodeRunner, moodleFillMatch, genericFillInQuestion,
} from './moodle-fill.js';
import { recordOutcome, summarize } from './session-stats.js';
import { parsePrecheckResult, checkIfCorrect } from './grading.js';

// Guard idempotensi: bila content.js sudah ter-inject di dokumen ini, hentikan
// SEBELUM deklarasi const apa pun agar re-injeksi tidak melempar "already declared".
if (window.__flabAI) {
  console.debug('[FLAB] content.js sudah ter-inject — lewati re-injeksi.');
} else {
  window.__flabAI = true;

// ══════════════════════════════════════════════════════════════════════════════
// Constants
// ══════════════════════════════════════════════════════════════════════════════
const MAX_SOLVE_RETRIES = 3;
const MAX_SOLVE_DISPATCH = 40; // circuit breaker: plafon keras total dispatch solve per sesi
const MAX_PRECHECK_RETRIES = 3;
const MAX_CHECK_POLL_TICKS = 30;
const CHECK_POLL_INTERVAL_MS = 500;
const MOODLE_RENDER_DELAY_MS = 3000;
const CHECK_FEEDBACK_DELAY_MS = 2500;
const CHECK_NAVIGATE_DELAY_MS = 1200;
const PRECHECK_FLOW_DELAY_MS = 1500;
const PRECHECK_CLEAR_DELAY_MS = 1000;
const MAX_ERROR_LOGS = 10;
const ERROR_LOG_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 hari

const POLL_INTERVALS = {
  QUESTION_LOAD: 300,
  QUESTION_LOAD_MAX_TICKS: 10,
  BODY_WAIT: 80,
};

const TIMEOUTS = {
  PRECHECK_RESULT: 25000,
  CAPTURE_DELAY: 2000,
  NAVIGATE_DELAY: 1200,
  CHECK_DELAY: 1500,
  ERROR_UI_REMOVE: 4000,
  SUCCESS_UI_REMOVE: 3000,
  SUMMARY_UI_REMOVE: 5000,
  GENERIC_RETRY_DELAY: 3200,
  ERROR_LOG_REMOVE: 7000,
};

// ── Utility: HTML escape to prevent XSS when inserting data into innerHTML ────

  // Simpan referensi listener agar bisa di-remove saat extension reload
  const _flabListener = (msg, sender) => {
    // Defense-in-depth: tolak pesan dari luar konteks ekstensi ini.
    if (sender?.id && sender.id !== chrome.runtime.id) return;
    if (msg.action === 'STOP_PROCESS') {
      window.__flabAborted = true;
      const ui = document.getElementById('pai-ui');
      if (ui) {
        ui.innerHTML = `<div style="padding:12px;text-align:center;color:#ff453a;font-weight:700;font-size:13px;">[Sistem] Dibatalkan dari jendela Gemini.</div>`;
        setTimeout(() => ui.remove(), 2500);
      }
      return;
    }

    if (msg.action === 'START') return handleStart(msg);

    // Untuk FILL_ANSWER dan RETRY, pastikan isBatching masih true.
    // Jika user sudah klik batal, abaikan respon yang telat dari AI.
    chrome.storage.local.get(['isBatching'], d => {
      if (!d.isBatching) {
        console.log(`[FLAB] Mengabaikan aksi ${msg.action} karena proses telah dibatalkan.`);
        return;
      }
      if (msg.action === 'FILL_ANSWER') executeFillAnswer(msg.data);
      if (msg.action === 'RETRY_SOLVE') retrySolve();
    });
  };
  window.__flabListener = _flabListener;
  chrome.runtime.onMessage.addListener(_flabListener);

  // Restore UI jika halaman baru dimuat dan sesi masih berjalan
  chrome.storage.local.get(['isBatching', 'ai', 'batchPrompt'], d => {
    if (!d.isBatching) return;
    waitForBody(POLL_INTERVALS.BODY_WAIT, () =>
      renderUI(d.ai ?? 'gemini', d.batchPrompt ?? '')
    );
  });

// ── Platform & deteksi soal dipindah ke ./platform.js ───────────────────────────

// ══════════════════════════════════════════════════════════════════════════════
// Ace Editor helpers dipindah ke ./ace-editor.js
// ══════════════════════════════════════════════════════════════════════════════

// ── Router ─────────────────────────────────────────────────────────────────────
async function handleStart({ ai, mode, prompt }) {
  if (mode === 'solve') {
    await chrome.storage.local.set({ solveRetryCount: 0 });
    return handleSolve(ai, prompt);
  }
  if (mode === 'select') return startSnipTool(ai, prompt);
  if (mode === 'text') return dispatch(ai, { type: 'text', text: extractText(), prompt });
  dispatch(ai, { type: 'image', dataUrl: await captureTab(), prompt });
}

// ── Retry handler (dipanggil saat Gemini timeout) ──────────────────────────────
async function retrySolve() {
  const d = await storageGet(['activeMode', 'ai', 'batchPrompt', 'solveRetryCount', 'isBatching']);
  if (!d.isBatching) return;

  const retryCount = Number(d.solveRetryCount ?? 0);
  const ui = document.getElementById('pai-ui');

  if (retryCount >= MAX_SOLVE_RETRIES) {
    setStatus(`[Sistem] Dihentikan otomatis setelah ${MAX_SOLVE_RETRIES}x percobaan gagal.`, ui);
    chrome.storage.local.set({ isBatching: false });
    setTimeout(() => ui?.remove(), TIMEOUTS.ERROR_UI_REMOVE);
    return;
  }

  const nextCount = retryCount + 1;
  await chrome.storage.local.set({ solveRetryCount: nextCount });

  setStatus(`[Recovery] Mencoba ulang permintaan AI. Percobaan: ${nextCount}/${MAX_SOLVE_RETRIES}`, ui);
  console.log(`[FLAB] Retrying solve attempt ${nextCount}/${MAX_SOLVE_RETRIES}`);

  await sleep(TIMEOUTS.CAPTURE_DELAY);
  if (!(await isStillBatching())) return;

  handleSolve(d.ai ?? 'gemini', d.batchPrompt ?? '', true);
}

// ── Shared UI ──────────────────────────────────────────────────────────────────
function renderUI(ai, prompt) {
  let ui = document.getElementById('pai-ui');
  const platform = detectPlatform();
  const platformLabels = { moodle: 'Moodle', generic: '—' };

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
          <span style="font-weight:600;font-size:12px;color:#EBEBF5;opacity:0.9;">FLAB</span>
          <span style="font-size:10px;color:#8E8E93;background:rgba(118,118,128,0.2);padding:1px 6px;border-radius:4px;font-weight:500;">${platformLabels[platform]}</span>
          <span id="pai-progress" style="font-size:10px;color:#0A84FF;font-weight:600;"></span>
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
      window.__flabAborted = true; // INSTANT ABORT FLAG
      try {
        chrome.storage.local.set({ isBatching: false });
        chrome.runtime.sendMessage({ action: 'STOP_PROCESS' }); // Matikan tab AI jika sedang terbuka
      } catch (e) {
        console.warn('[FLAB] Context invalidated. Extension reloaded?', e);
      }
      ui.innerHTML = `<div style="padding:12px;text-align:center;color:#ff453a;font-weight:700;font-size:13px;">[Sistem] Proses dihentikan paksa.</div>`;
      setTimeout(() => ui?.remove(), 2500);
    });
  }
  setStatus(`<span style="opacity:0.6">Automasi diluncurkan, memulai persiapan...</span>`, ui);
  return ui;
}

function setStatus(msg, ui = document.getElementById('pai-ui')) {
  const el = ui?.querySelector('#pai-status');
  if (el) el.innerHTML = msg;
}

// ── Auto-Solve mode ────────────────────────────────────────────────────────────
let __solveInProgress = false;

async function handleSolve(ai, prompt, isRetry = false) {
  if (__solveInProgress) {
    console.warn('[FLAB] handleSolve already in progress. Skipping duplicate call.');
    return;
  }
  __solveInProgress = true;
  try {
    const d = await storageGet(['isBatching']);
    if (!d.isBatching) return;

    let dispatchCount;
    if (!isRetry) {
      // Sesi baru: reset semua counter & mulai hitungan circuit breaker dari 1.
      window.__flabAborted = false;
      dispatchCount = 1;
      await chrome.storage.local.set({ solveRetryCount: 0, precheckRetryCount: 0, checkRetryCount: 0, solveDispatchCount: 1 });
      await chrome.storage.local.remove(['precheckError', 'precheckCode']);
    } else {
      const sc = await storageGet(['solveDispatchCount']);
      dispatchCount = Number(sc.solveDispatchCount ?? 0) + 1;
      await chrome.storage.local.set({ solveDispatchCount: dispatchCount });
    }

    // Circuit breaker: plafon keras total dispatch solve per sesi. Backstop terhadap
    // skenario retry compounding (H2) yang bisa membuka tab Gemini berulang tanpa henti.
    if (dispatchCount > MAX_SOLVE_DISPATCH) {
      console.warn(`[FLAB] Circuit breaker: ${dispatchCount} dispatch > plafon ${MAX_SOLVE_DISPATCH}. Menghentikan.`);
      const ui0 = document.getElementById('pai-ui');
      setStatus(`[Sistem] Batas aman ${MAX_SOLVE_DISPATCH} percobaan tercapai. Dihentikan otomatis.`, ui0);
      window.__flabAborted = true;
      await chrome.storage.local.set({ isBatching: false });
      setTimeout(() => ui0?.remove(), TIMEOUTS.ERROR_UI_REMOVE);
      return;
    }

  const ui = renderUI(ai, prompt);
  const platform = detectPlatform();
  const isMoodlePlatform = platform === 'moodle';

  if (isMoodlePlatform) {
    if (document.readyState !== 'complete') {
      await new Promise(res => window.addEventListener('load', res, { once: true }));
    }
    let waitTicks = 0;
    while (document.querySelectorAll('.que').length === 0 && waitTicks < POLL_INTERVALS.QUESTION_LOAD_MAX_TICKS) {
      await sleep(POLL_INTERVALS.QUESTION_LOAD);
      waitTicks++;
    }
  }

  if (isMoodlePlatform) {
    const quiz = detectMoodleQuiz();
    if (quiz.isSummaryPage) {
      setStatus('[Sistem] Berada di halaman ulasan kuis. Mode pengiriman otomatis ditangguhkan.', ui);
      chrome.storage.local.set({ isBatching: false });
      setTimeout(() => ui?.remove(), TIMEOUTS.SUMMARY_UI_REMOVE);
      return;
    }
    if (quiz.isReviewPage) {
      setStatus('[Navigasi] Terdeteksi halaman review jawaban. Proses diabaikan.', ui);
      chrome.storage.local.set({ isBatching: false });
      setTimeout(() => ui?.remove(), TIMEOUTS.SUCCESS_UI_REMOVE);
      return;
    }
    if (!quiz.isQuiz) {
      setStatus('[Status] Mengamati aktivitas... Menunggu pengguna memasuki laman kuis berlangsung.', ui);
      await sleep(TIMEOUTS.CAPTURE_DELAY);
      const quiz2 = detectMoodleQuiz();
      if (!quiz2.isQuiz) {
        setStatus('[Error] Lingkungan Moodle kuis pengerjaan belum terbuka. Eksekusi dibatalkan.', ui);
        chrome.storage.local.set({ isBatching: false });
        window.__flabAborted = true; // Ensure all pending timers see the abort flag
        setTimeout(() => ui?.remove(), TIMEOUTS.ERROR_UI_REMOVE);
        return;
      }
    }
    const questions = document.querySelectorAll('.que');
    // "Selesai" = tiap soal sudah BENAR, atau salah-terminal (tak bisa di-Check ulang).
    // Soal salah yang masih bisa di-Check ulang BUKAN selesai → harus di-solve ulang
    // (fitur perbaiki sampai benar), jadi jangan langsung navigasi ke halaman berikut.
    const allHaveFeedback = questions.length > 0 && [...questions].every(q => {
      if (isQuestionCorrect(q) || q.querySelector('.rightanswer')) return true;
      if (isQuestionIncorrect(q)) return !canResubmit(q);
      return false;
    });

    if (allHaveFeedback) {
      setStatus('[Navigasi] Soal di halaman ini telah dieksekusi. Berpindah ke halaman selanjutnya...', ui);
      await sleep(TIMEOUTS.NAVIGATE_DELAY);
      navigateNext(s => setStatus(s, ui));
      return;
    }

    setStatus(`[Analisis DOM] Menemukan ${quiz.questionCount} blok pertanyaan LMS untuk dievaluasi.`, ui);
    await sleep(TIMEOUTS.CAPTURE_DELAY);
  }

  // Cari soal aktif yang belum dijawab
  let activeQueEl = null;
  if (isMoodlePlatform) {
    const questions = document.querySelectorAll('.que');
    activeQueEl = findUnansweredQuestion(questions) || questions[0];
  }

  // Build context dari teks soal
  let enrichedPrompt = prompt || '';
  if (isMoodlePlatform) {
    enrichedPrompt = buildMoodleContext(activeQueEl) + '\n' + enrichedPrompt;

    const codeContext = extractCodeRunnerContext(activeQueEl);
    if (codeContext) enrichedPrompt = codeContext + '\n' + enrichedPrompt;

    const errorContext = await getRetryErrorContext();
    if (errorContext) enrichedPrompt = errorContext + '\n' + enrichedPrompt;
  }

  // Cek apakah ada gambar dalam soal
  const hasImages = isMoodlePlatform ? detectQuestionImages(activeQueEl) : false;

  if (hasImages) {
    // Ada gambar → ekstrak semua img dari DOM, gabungkan ke 1 canvas composite
    const imgEls = extractQuestionImages(activeQueEl);
    setStatus(`[Ekstraksi] Menangkap gambar... Merekonstruksi layout canvas untuk ${imgEls.length} grafis elemen.`, ui);

    const questionText = extractQuestionsText(activeQueEl);
    const combinedPrompt = questionText
      ? `[TEKS SOAL UNTUK REFERENSI]\n${questionText}\n\n${enrichedPrompt}`
      : enrichedPrompt;

    if (!(await isStillBatching())) return;

    // Coba stitch canvas (tidak butuh scroll, tidak lambat seperti screenshot)
    const stitched = await stitchImages(imgEls);

    if (stitched) {
      setStatus('[AI Bridge] Membuka saluran Gemini... Mengirim payload gambar komposit dan teks terjemahan.', ui);
      // Gunakan 'solve_image' agar gemini.js otomatis tambahkan aturan JSON
      dispatch(ai, { type: 'solve_image', dataUrl: stitched, prompt: combinedPrompt });
    } else {
      // Fallback: screenshot tab biasa (jika canvas CORS blocked)
      console.warn('[FLAB] Canvas stitch gagal, fallback ke screenshot tab.');
      setStatus('[Fallback] Restriksi keamanan canvas terdeteksi. Beralih ke tangkapan layar antarmuka.', ui);
      await sleep(TIMEOUTS.CAPTURE_DELAY);
      if (!(await isStillBatching())) return;
      const dataUrl = await captureTab();
      if (dataUrl) {
        dispatch(ai, { type: 'image', dataUrl, prompt: combinedPrompt });
      } else {
        // Final fallback: teks saja
        if (!questionText) { setStatus('[Error] Resolusi fallback tangkapan layar gagal, teks pertanyaan kosong.', ui); return; }
        setStatus('[Fallback AI] Mengirim permintaan teks murni sebagai operasi degradasi.', ui);
        dispatch(ai, { type: 'solve_text', text: questionText, prompt: enrichedPrompt });
      }
    }
  } else {
    // Default: teks saja — lebih cepat & stabil (tidak ada pemrosesan gambar)
    setStatus('[Penyusunan] Mengkompilasi metadata dan konten tekstual komponen soal (Mode cepat).', ui);
    const questionText = extractQuestionsText(activeQueEl);
    if (!questionText) {
      setStatus('[Error] Gagal menarik isi substansial dari badan pertanyaan LMS.', ui);
      return;
    }
    if (!(await isStillBatching())) return;
    setStatus('[AI Bridge] Permintaan diformat. Mentransmisikan intruksi analitis ke server AI...', ui);
    dispatch(ai, { type: 'solve_text', text: questionText, prompt: enrichedPrompt });
  }

  setStatus('[Sync] Agen tertidur. Menanti tanggapan eksekusi dari instans Gemini...', ui);
  } catch (err) {
    console.error('[FLAB] Error in handleSolve:', err);
  } finally {
    __solveInProgress = false;
  }
}

// ── Moodle context builder ───────────────────────────────────────────────────────
// Hanya penanda platform + tipe (+ opsi bernomor untuk multichoice). Body soal TIDAK
// diulang di sini karena extractQuestionsText() sudah mengirim versi Markdown lengkap.
function buildMoodleContext(activeQueEl) {
  if (!activeQueEl) return '';

  const type = detectQuestionType(activeQueEl);
  const options = [];

  if (type === 'multichoice' || type === 'truefalse') {
    getMoodleOptions(activeQueEl).forEach(o => { if (o.text) options.push(o.text); });
  }

  let info = `Tipe soal: ${type}`;
  if (options.length > 0) info += ` | ${options.length} opsi`;

  return `[CONTEXT: Platform Moodle LMS. ${info}]`;
}

// ── Image helpers dipindah ke ./question-images.js ──────────────────────────────

// ── Extract text from questions ────────────────────────────────────────────────
// Body soal dikonversi ke Markdown agar struktur (tabel I/O, blok kode, list, math)
// terjaga saat dikirim ke AI. Teks opsi tetap diambil verbatim untuk exact-matching.
function extractQuestionsText(activeQueEl) {
  if (!activeQueEl) return '';

  const type = detectQuestionType(activeQueEl);
  const bodyEl = activeQueEl.querySelector('.qtext') || activeQueEl.querySelector('.formulation');
  const qBody = bodyEl ? htmlToMarkdown(bodyEl) : '';
  const options = [];

  if (type === 'multichoice' || type === 'truefalse') {
    getMoodleOptions(activeQueEl).forEach(o => { if (o.text) options.push(o.text); });
  }

  let part = `SOAL (${type}):\n${qBody}`;
  if (options.length > 0) {
    part += '\n\nOpsi (urutan = index_pilihan):\n' + options.map((o, j) => `  ${j + 1}. ${o}`).join('\n');
  }

  if (type === 'match') {
    const rows = getMatchRows(activeQueEl);
    if (rows.length > 0) {
      const optionSet = [...new Set(rows.flatMap(r => r.options))];
      part += '\n\nBaris untuk dijodohkan (urutan = urutan jawaban):\n' +
        rows.map((r, j) => `  ${j + 1}. ${r.stem}`).join('\n');
      part += '\n\nPilihan yang tersedia:\n' + optionSet.map(o => `  - ${o}`).join('\n');
    }
  }

  return part;
}

// ── getMoodleOptions dipindah ke ./moodle-options.js ────────────────────────────

// ── HTML → Markdown dipindah ke ./html-to-markdown.js ───────────────────────────

// ── CodeRunner context: extract existing template code ─────────────────────────
function extractCodeRunnerContext(activeQueEl) {
  if (!activeQueEl) return '';

  const type = detectQuestionType(activeQueEl);
  if (type !== 'coderunner') return '';

  // GapFill: kotak <input> kecil di antara teks template. AI harus mengisi POTONGAN
  // tiap gap, BUKAN menulis ulang seluruh program (itu yang bikin `for` dobel).
  const gaps = getGapFillInputs(activeQueEl);
  if (gaps.length > 0) {
    const tmpl = buildGapFillTemplate(activeQueEl, gaps);
    return `[SOAL CODERUNNER MODE GAPFILL — ISI TIAP KOTAK, BUKAN TULIS ULANG SEMUA]
Ada ${gaps.length} kotak isian ([GAP1]..[GAP${gaps.length}]) yang disisipkan di dalam template kode berikut. Teks di LUAR penanda [GAPn] SUDAH tercetak di soal dan TIDAK boleh kamu tulis ulang.
\`\`\`
${tmpl}
\`\`\`
ATURAN GAPFILL:
- "jawaban" WAJIB berupa array of strings dengan TEPAT ${gaps.length} elemen, urut [GAP1], [GAP2], ... [GAP${gaps.length}].
- Tiap elemen = HANYA potongan yang hilang di gap itu (sependek mungkin). JANGAN sertakan teks template di sekitarnya.
- Contoh: jika template "for ( [GAP1] : [GAP2] ) {" maka GAP1="int n", GAP2="nilai" — JANGAN tulis "for (int n" atau "for (int n : nilai){".
- Jangan menduplikasi keyword (for/while/if) yang sudah ada di template.
"index_pilihan": 0.`;
  }

  const existingCode = getExistingCode(activeQueEl);
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
  const d = await storageGet(['precheckError', 'precheckCode', 'precheckRetryCount', 'checkRetryCount']);
  if (!d.precheckError) return '';

  // Clear after reading
  await chrome.storage.local.remove(['precheckError', 'precheckCode']);

  const retryNum = Math.max(d.precheckRetryCount || 0, d.checkRetryCount || 0);

  return `[PERCOBAAN SEBELUMNYA GAGAL PRECHECK — PERBAIKI!]
Error dari PRECHECK: "${d.precheckError}"
Kode yang dicoba sebelumnya:
\`\`\`
${d.precheckCode || '(tidak tersedia)'}
\`\`\`
PERBAIKI kode di atas berdasarkan error message precheck. Perhatikan output yang diharapkan vs output aktual.
Ini percobaan ke-${retryNum || 1}.`;
}

// ══════════════════════════════════════════════════════════════════════════════
// FILL ANSWER — Router
// ══════════════════════════════════════════════════════════════════════════════
async function executeFillAnswer(json) {
  // Cek abort flag sebelum mengisi jawaban
  if (window.__flabAborted) return;
  const d = await new Promise(r => chrome.storage.local.get(['isBatching'], r));
  if (!d.isBatching) return;

  const platform = detectPlatform();
  console.log(`[FLAB] Fill answer on platform: ${platform}`, json);

  if (platform === 'moodle') return moodleFillAnswer(json);
  return genericFillAnswer(json);
}

// ══════════════════════════════════════════════════════════════════════════════
// Moodle — Fill Answer
// ══════════════════════════════════════════════════════════════════════════════
async function moodleFillAnswer(json) {
  const ui = document.getElementById('pai-ui');
  const status = msg => setStatus(msg, ui);

  // originalJaw bisa jadi array (untuk multi-select checkbox) atau string
  const isArray = Array.isArray(json.jawaban);
  const originalJaw = isArray ? json.jawaban : String(json.jawaban ?? '').trim();
  const jaw = isArray ? originalJaw.map(s => String(s).toUpperCase()) : String(originalJaw).toUpperCase();
  const idxHint = Number(json.index_pilihan ?? 0);

  if (!originalJaw || (isArray && originalJaw.length === 0)) { status('❌ Tidak ada jawaban diterima.'); return; }

  const displayJaw = isArray ? originalJaw.join(', ') : originalJaw;
  const safeDisplayJaw = displayJaw.length > 30 ? '(multiselect/teks panjang)' : escapeHtml(displayJaw);
  status(`✍️ Menerapkan: <span style="opacity:0.8">${safeDisplayJaw}</span>`);

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
    filled = moodleFillMultichoice(queEl, originalJaw, jaw, idxHint, status);
  }

  // ── Short Answer / Numerical ──────────────────────────────────────────────
  if (type === 'shortanswer' || type === 'numerical') {
    filled = moodleFillShortAnswer(queEl, originalJaw, status);
  }

  // ── Essay ─────────────────────────────────────────────────────────────────
  if (type === 'essay') {
    filled = moodleFillEssay(queEl, originalJaw, status);
  }

  // ── Match (menjodohkan) ───────────────────────────────────────────────────
  if (type === 'match') {
    filled = moodleFillMatch(queEl, originalJaw, status);
  }

  // ── CodeRunner ────────────────────────────────────────────────────────────
  if (type === 'coderunner') {
    filled = await moodleFillCodeRunner(queEl, originalJaw, status);
    if (filled) {
      setTimeout(() => moodlePrecheckFlow(queEl, status), PRECHECK_FLOW_DELAY_MS);
      return;
    }
  }

  // ── Unknown type — fallback ke generic ────────────────────────────────────
  if (!filled && (type === 'unknown' || type === 'match')) {
    filled = genericFillInQuestion(queEl, originalJaw, jaw, idxHint, status);
  }

  if (!filled) {
    status('❌ Gagal mengisi jawaban. Tipe soal: ' + (type || 'unknown'));
    chrome.storage.local.set({ isBatching: false });
    setTimeout(() => document.getElementById('pai-ui')?.remove(), TIMEOUTS.ERROR_UI_REMOVE);
    return;
  }

  // ── Non-CodeRunner: langsung navigate (atau CHECK dulu kalau ada) ─────────
  setTimeout(() => moodleCheckAndNavigate(queEl, status), CHECK_NAVIGATE_DELAY_MS);
}

// ══════════════════════════════════════════════════════════════════════════════
// Moodle: PRECHECK → Retry → CHECK → Navigate (untuk CodeRunner)
// ══════════════════════════════════════════════════════════════════════════════



async function moodlePrecheckFlow(queEl, status) {
  if (!(await isStillBatching())) return;

  // Cari tombol PRECHECK
  const precheckBtn = findButton(queEl, ['precheck']);

  if (!precheckBtn) {
    status('⚠️ Tombol PRECHECK tidak ditemukan. Langsung CHECK...');
    await sleep(500);
    return moodleCheckAndNavigate(queEl, status);
  }

  // Sync Ace editor ke textarea sebelum precheck
  syncAceToTextarea(queEl);
  await sleep(TIMEOUTS.CAPTURE_DELAY);

  clearPrecheckResult(queEl);

  status('🔍 Menjalankan PRECHECK...');
  fireClick(precheckBtn);

  const resultEl = await waitForPrecheckResult(queEl);

  if (!resultEl) {
    status('⚠️ Hasil PRECHECK tidak muncul. Langsung CHECK...');
    return moodleCheckAndNavigate(queEl, status);
  }

  status('⏳ Sinkronisasi layout Moodle (3 detik)...');
  await sleep(MOODLE_RENDER_DELAY_MS);

  // Re-query resultEl jaga-jaga kalau dom Moodle me-replace elementnya (stale DOM)
  const freshResultEl = queEl.querySelector('.coderunner-test-results, .CodeRunner-test-results') || resultEl;

  scrollToResultElement(freshResultEl, queEl, true);
  await sleep(500); // Tunggu instant scroll selesai

  // Parse hasil PRECHECK
  const resultText = (resultEl.innerText || resultEl.textContent || '').trim();
  const isPassed = parsePrecheckResult(resultText, resultEl);

  if (isPassed) {
    status('✅ PRECHECK berhasil! Menjalankan CHECK...');
    await sleep(800);
    return moodleCheckAndNavigate(queEl, status);
  }

  // PRECHECK gagal — cek retry count
  const d = await storageGet(['precheckRetryCount']);
  const retryCount = Number(d.precheckRetryCount ?? 0);

  if (retryCount >= MAX_PRECHECK_RETRIES) {
    status(`❌ PRECHECK gagal ${MAX_PRECHECK_RETRIES}x. Menghentikan bot agar Anda bisa koreksi manual.`);
    // Scroll ke hasil error agar kode + tabel Got/Expected ter-capture di screenshot
    const freshResultElErr = queEl.querySelector('.coderunner-test-results, .CodeRunner-test-results') || resultEl;
    scrollToResultElement(freshResultElErr, queEl, true);
    await sleep(500);
    await saveErrorScreenshot(queEl, resultText);
    chrome.storage.local.set({ isBatching: false });
    window.__flabAborted = true;
    setTimeout(() => document.getElementById('pai-ui')?.remove(), TIMEOUTS.ERROR_LOG_REMOVE);
    return;
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

  await sleep(PRECHECK_CLEAR_DELAY_MS);
  if (!(await isStillBatching())) return;

  // Re-trigger solve flow — Gemini akan lihat screenshot + error context
  const sd = await storageGet(['ai', 'batchPrompt']);
  handleSolve(sd.ai || 'gemini', sd.batchPrompt || '', true);
}

// Tunggu precheck result muncul di DOM
async function waitForPrecheckResult(queEl, timeout = TIMEOUTS.PRECHECK_RESULT) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (window.__flabAborted) return null;
    const result =
      queEl.querySelector('.coderunner-test-results') ||
      queEl.querySelector('.CodeRunner-test-results') ||
      queEl.querySelector('.que-coderunner-result') ||
      queEl.querySelector('.coderunnerresults') ||
      queEl.querySelector('table.coderunner_test_results') ||
      queEl.querySelector('.precheck-results');

    if (result && result.innerText?.trim().length > 5) {
      return result;
    }
    await sleep(POLL_INTERVALS.QUESTION_LOAD);
  }
  return null;
}

// parsePrecheckResult dipindah ke ./grading.js

// Clear precheck result from DOM so it doesn't interfere with next precheck
// PENTING: Tidak hapus [id*="feedback"] atau .outcome global - terlalu agresif.
function clearPrecheckResult(queEl) {
  const results = queEl.querySelectorAll(
    '.coderunner-test-results, .CodeRunner-test-results, .que-coderunner-result, .coderunnerresults, table.coderunner_test_results, .precheck-results'
  );
  results.forEach(el => { try { el.innerHTML = ''; } catch {/***/ } });
}

// ══════════════════════════════════════════════════════════════════════════════
// Moodle: CHECK & Navigate (untuk semua tipe soal)
// ══════════════════════════════════════════════════════════════════════════════

async function moodleCheckAndNavigate(queEl, status) {
  if (!(await isStillBatching())) return;

  syncAceToTextarea(queEl);
  await sleep(TIMEOUTS.CAPTURE_DELAY);

  await chrome.storage.local.remove(['precheckError', 'precheckCode', 'precheckRetryCount']);

  const checkBtn = findButton(queEl, ['check', 'periksa', 'submit'], ['precheck', 'pre-check']);

  if (checkBtn) {
    status('📝 Menjalankan CHECK...');

    let isUnloading = false;
    const unloadListener = () => { isUnloading = true; };
    window.addEventListener('beforeunload', unloadListener);
    window.addEventListener('unload', unloadListener);

    fireClick(checkBtn);

    let ajaxDone = false;
    let ticks = 0;
    while (ticks < MAX_CHECK_POLL_TICKS) {
      await sleep(CHECK_POLL_INTERVAL_MS);
      if (isUnloading || window.__flabAborted) {
        status('⏳ Halaman sedang dimuat ulang...');
        window.removeEventListener('beforeunload', unloadListener);
        window.removeEventListener('unload', unloadListener);
        return;
      }
      const stateTxt = (queEl.querySelector('.info .state, .state')?.innerText || '').toLowerCase();
      const stateGraded = /correct|incorrect|\bbenar\b|\bsalah\b/.test(stateTxt) && !/not\s*yet/.test(stateTxt);
      if (queEl.classList.contains('correct') || queEl.classList.contains('incorrect') ||
        queEl.querySelector('.outcome') || queEl.classList.contains('complete') ||
        queEl.querySelector('.coderunner-test-results, .CodeRunner-test-results') || stateGraded) {
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
      await sleep(CHECK_FEEDBACK_DELAY_MS);
      const freshQueEl = document.getElementById(queEl.id) || queEl;
      const feedbackEl = freshQueEl.querySelector('.outcome, .feedback, .coderunner-test-results, .CodeRunner-test-results, .precheck-results') || freshQueEl.querySelector('.answer, .formulation') || freshQueEl;
      scrollToResultElement(feedbackEl, freshQueEl, true);
      await sleep(500);

      // Cek hasil CHECK
      const isCorrect = checkIfCorrect(freshQueEl);
      if (isCorrect === true) {
        await bumpSessionStats('correct');
        status('✅ Jawaban BENAR!');
      } else if (isCorrect === false) {
        const d = await storageGet(['checkRetryCount']);
        const retryCount = Number(d.checkRetryCount ?? 0);

        if (retryCount >= MAX_PRECHECK_RETRIES) {
          await bumpSessionStats('failed');
          status(`❌ CHECK gagal ${MAX_PRECHECK_RETRIES}x. Menghentikan bot.`);
          const questionText = freshQueEl.querySelector('.qtext')?.innerText?.trim() || '';

          const freshFeedbackEl = freshQueEl.querySelector('.outcome, .feedback, .coderunner-test-results, .CodeRunner-test-results') || freshQueEl;
          scrollToResultElement(freshFeedbackEl, freshQueEl, true);
          await sleep(500);

          await saveErrorScreenshot(freshQueEl, `CHECK failed: ${questionText.slice(0, 100)}`);
          chrome.storage.local.set({ isBatching: false });
          window.__flabAborted = true;
          setTimeout(() => document.getElementById('pai-ui')?.remove(), TIMEOUTS.ERROR_LOG_REMOVE);
          return;
        }

        const nextRetry = retryCount + 1;
        status(`🔄 CHECK gagal. Retry ${nextRetry}/${MAX_PRECHECK_RETRIES}...`);

        const feedbackEl = freshQueEl.querySelector('.outcome, .feedback, .coderunner-test-results, .CodeRunner-test-results') || freshQueEl;
        const errText = feedbackEl.innerText || '';
        const existingCode = getExistingCode(freshQueEl) || '';

        await chrome.storage.local.set({
          precheckError: errText.slice(0, 2500),
          precheckCode: existingCode,
          checkRetryCount: nextRetry
        });

        clearPrecheckResult(freshQueEl);

        await sleep(TIMEOUTS.CHECK_DELAY);
        if (!(await isStillBatching())) return;

        const sd = await storageGet(['ai', 'batchPrompt']);
        return handleSolve(sd.ai || 'gemini', sd.batchPrompt || '', true);
      } else {
        status('📋 CHECK selesai.');
      }
      await sleep(TIMEOUTS.CHECK_DELAY);
    }
  }

  const nextUnanswered = findUnansweredQuestion(document.querySelectorAll('.que'));
  if (nextUnanswered) {
    status('➡️ Lanjut ke soal berikutnya di halaman ini...');
    const sd = await storageGet(['ai', 'batchPrompt']);
    handleSolve(sd.ai || 'gemini', sd.batchPrompt || '', false);
  } else {
    navigateNext(status);
  }
}

// checkIfCorrect dipindah ke ./grading.js

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

    // Buang log kedaluwarsa (TTL) — screenshot base64 sensitif & boros storage.
    const now = Date.now();
    let pruned = logs.filter(l => !l.timestamp || (now - l.timestamp) < ERROR_LOG_TTL_MS);
    // Lalu cap jumlah: simpan hanya MAX_ERROR_LOGS terbaru.
    if (pruned.length > MAX_ERROR_LOGS) pruned = pruned.slice(pruned.length - MAX_ERROR_LOGS);

    await chrome.storage.local.set({ errorLogs: pruned });
    console.log(`[FLAB] Error screenshot saved. Total logs: ${pruned.length}`);
  } catch (e) {
    console.warn('[FLAB] Failed to save error screenshot:', e);
  }
}

// ── Fill handlers dipindah ke ./moodle-fill.js ──────────────────────────────────

// ── Moodle navigation ──────────────────────────────────────────────────────────
function navigateNext(status) {
  const platform = detectPlatform();

  if (platform === 'moodle') {
    return moodleNavigateNext(status);
  }
  return genericNavigateNext(status);
}

function moodleNavigateNext(status) {
  const nextSelectors = [
    'input[type="submit"][name="next"]',
    '.mod_quiz-next-nav',
    'input[value*="Halaman berikutnya"]',
    'input[value*="Next page"]',
    'input[value*="Selanjutnya"]',
    '.submitbtns input[type="submit"]:not([name="previous"])',
    'button[type="submit"]:not([name="previous"])',
  ];

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
      try { chrome.runtime.sendMessage({ action: 'SESSION_DONE' }); } catch { /* context reload */ }
      setTimeout(() => document.getElementById('pai-ui')?.remove(), TIMEOUTS.SUMMARY_UI_REMOVE);
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

  storageGet(['sessionStats']).then(d => {
    const ringkasan = summarize(d.sessionStats);
    status(`🏁 Semua soal selesai! ${ringkasan}. Review jawabanmu.`);
  });
  chrome.storage.local.set({ isBatching: false });
  // Beri tahu background: sesi kelar → tutup tab provider (Gemini/dll) & fokuskan
  // kembali tab Moodle ini, supaya tidak nyangkut di tab AI.
  try { chrome.runtime.sendMessage({ action: 'SESSION_DONE' }); } catch { /* context reload */ }
  setTimeout(() => document.getElementById('pai-ui')?.remove(), TIMEOUTS.SUMMARY_UI_REMOVE);
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
    }, TIMEOUTS.GENERIC_RETRY_DELAY);
  } else {
    status('🏁 Selesai. Tidak ada tombol lanjut.');
    chrome.storage.local.set({ isBatching: false });
    setTimeout(() => document.getElementById('pai-ui')?.remove(), TIMEOUTS.ERROR_UI_REMOVE);
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// Generic Fill Answer (legacy fallback)
// ══════════════════════════════════════════════════════════════════════════════
function genericFillAnswer(json) {
  const ui = document.getElementById('pai-ui');
  const status = msg => setStatus(msg, ui);
  const originalJaw = String(json.jawaban ?? '').trim();
  const jaw = originalJaw.toUpperCase();
  const idxHint = Number(json.index_pilihan ?? 0);

  if (!originalJaw) { status('Tidak ada jawaban diterima.'); return; }
  const safeOriginalJaw = originalJaw.length > 30 ? '(teks panjang)' : escapeHtml(originalJaw);
  status(`Menerapkan: <span style="opacity:0.8">${safeOriginalJaw}</span>`);

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
      const el = editors.find(e => e.classList.contains('ace_text-input')) ?? editors[editors.length - 1];
      const jText = originalJaw.replace(/\\n/g, '\n');
      try {
        setNativeValue(el, jText, el.tagName === 'TEXTAREA');
        const dt = new DataTransfer();
        dt.setData('text/plain', jText);
        el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true }));
        highlightElement(el.closest('.ace_editor, .CodeMirror, .answer, form') ?? el);
        clicked = true;
        status('Masukan berhasil diisikan.');
      } catch (err) {
        console.warn('[FLAB] Essay inject error:', err);
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

// ── Helper DOM murni dipindah ke ./dom-utils.js ─────────────────────────────────

function captureTab() {
  return new Promise(res =>
    chrome.runtime.sendMessage({ action: 'CAPTURE' }, r => res(r?.dataUrl ?? null))
  );
}

function dispatch(ai, payload) {
  // Catat progres (current/total) sebelum kirim agar PROGRESS_UPDATE punya angka,
  // bukan "?/?". Dihitung dari quiz-nav Moodle (lintas-halaman) bila ada.
  const prog = computeProgress();
  if (prog) {
    chrome.storage.local.set({ current: prog.current, total: prog.total });
    const pEl = document.getElementById('pai-progress');
    if (pEl) pEl.textContent = `${prog.current}/${prog.total}`;
  }
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
  if (window.__flabAborted) return false;
  const d = await storageGet(['isBatching']);
  return !!d.isBatching;
}

// Tambah satu outcome ke sessionStats di storage (read-modify-write; aman untuk single-tab).
async function bumpSessionStats(outcome) {
  const d = await storageGet(['sessionStats']);
  const next = recordOutcome(d.sessionStats, outcome);
  await chrome.storage.local.set({ sessionStats: next });
  return next;
}

// ── waitForBody / scrollToResultElement / waitFor dipindah ke ./dom-utils.js ────

// ── Snip tool ─────────────────────────────────────────────────────────────────
function startSnipTool(ai, prompt) {
  if (document.getElementById('flabai-snip')) return;

  const style = document.createElement('style');
  style.id = 'flabai-snip-style';
  style.textContent = `
    #flabai-snip{position:fixed;inset:0;z-index:2147483647;cursor:crosshair;background:rgba(0,0,0,.45);}
    #_snip-hint{position:absolute;top:16px;left:50%;transform:translateX(-50%);background:#1a1a3a;color:#ccd;font-family:Inter,sans-serif;font-size:13px;padding:8px 20px;border-radius:999px;border:1px solid #6c63ff80;white-space:nowrap;box-shadow:0 4px 24px #0008;}
    #_snip-cancel{color:#ff6b6b;cursor:pointer;font-weight:600;}
    #_snip-box{position:fixed;display:none;border:2px solid #6c63ff;background:rgba(108,99,255,.12);pointer-events:none;}`;
  document.head.appendChild(style);

  const overlay = document.createElement('div');
  overlay.id = 'flabai-snip';
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
    const full = await captureTab();
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
    if (!dataUrl) { res(null); return; }
    const img = new Image();
    img.onload = () => {
      try {
        const dpr = window.devicePixelRatio || 1;
        const c = document.createElement('canvas');
        c.width = w * dpr; c.height = h * dpr;
        c.getContext('2d').drawImage(img, x * dpr, y * dpr, w * dpr, h * dpr, 0, 0, w * dpr, h * dpr);
        res(c.toDataURL('image/png'));
      } catch (e) {
        console.debug('[FLAB] cropImage drawImage gagal:', e);
        res(null);
      }
    };
    // Tanpa onerror, dataUrl korup membuat Promise menggantung selamanya → snip tool hang.
    img.onerror = () => { console.debug('[FLAB] cropImage: gambar gagal dimuat.'); res(null); };
    img.src = dataUrl;
  });
}

} // ── akhir guard idempotensi (window.__flabAI) ──
