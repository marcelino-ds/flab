// Helper DOM murni (tanpa state internal / chrome.*). Dipakai lintas fill & flow.

// Teks status soal. Sebagian tema/tipe Moodle (mis. CodeRunner adaptif di iLab
// Gunadarma) TIDAK menaruh kelas correct/incorrect di `.que` — status HANYA muncul
// sebagai teks badge ("Correct"/"Incorrect"/"Not yet answered"/"Benar"/"Salah").
function getStateText(q) {
  const el = q.querySelector('.info .state, .state, .outcome');
  return (el?.innerText || el?.textContent || '').toLowerCase();
}

// Soal sudah dinilai BENAR? Cek "incorrect" lebih dulu agar substring "correct" di
// dalam "incorrect" tak salah klaim. "Not yet answered" → belum dinilai (false).
export function isQuestionCorrect(q) {
  const cl = q.classList;
  if (cl.contains('incorrect') || cl.contains('partiallycorrect')) return false;
  if (cl.contains('correct')) return true;
  const t = getStateText(q);
  if (!t || /not\s*yet\s*answered|belum\s*dijawab/.test(t)) return false;
  if (/incorrect|partially\s*correct|tidak\s+benar|\bsalah\b|sebagian\s*benar/.test(t)) return false;
  return /\bcorrect\b|\bbenar\b/.test(t);
}

// Soal sudah dinilai SALAH / sebagian benar?
export function isQuestionIncorrect(q) {
  const cl = q.classList;
  if (cl.contains('incorrect') || cl.contains('partiallycorrect')) return true;
  if (cl.contains('correct')) return false;
  const t = getStateText(q);
  if (!t || /not\s*yet\s*answered|belum\s*dijawab/.test(t)) return false;
  return /incorrect|partially\s*correct|tidak\s+benar|\bsalah\b|sebagian\s*benar/.test(t);
}

// Sudah dinilai (benar ATAU salah)? Dipakai untuk membedakan dari "belum dijawab".
export function isQuestionGraded(q) {
  return isQuestionCorrect(q) || isQuestionIncorrect(q);
}

// Soal masih bisa di-CHECK ulang? (tombol Check/Periksa/Submit masih ada → penalty
// regime mengizinkan kirim ulang). Soal salah yang resubmittable HARUS di-solve
// ulang, bukan dilewati — inilah fitur "perbaiki sampai benar".
export function canResubmit(q) {
  return !!findButton(q, ['check', 'periksa', 'submit'], ['precheck', 'pre-check']);
}

export function findUnansweredQuestion(questions) {
  for (const q of questions) {
    const cl = q.classList;
    // BENAR → jangan pernah di-solve ulang (cegah loop re-solve).
    if (isQuestionCorrect(q)) {
      continue;
    }
    // SALAH → solve ulang bila masih bisa di-Check (dibatasi counter retry &
    // circuit breaker); kalau sudah terminal (tak ada tombol Check) → lewati.
    if (isQuestionIncorrect(q)) {
      if (canResubmit(q)) return q;
      continue;
    }
    // Server menandai jawaban tak valid → wajib diisi ulang.
    if (cl.contains('invalidanswer')) return q;

    // CodeRunner (iLab): JANGAN tebak sudah-dijawab dari isi input/textarea —
    // textarea CodeRunner bisa berisi template boilerplate & disembunyikan lewat
    // CSS (bukan atribut [hidden]), sehingga tampak "terisi" padahal belum
    // disolve. iLab menilai via CHECK yang meng-update kelas/state, jadi pakai
    // jalur berbasis kelas di bawah — persis perilaku semula.
    const isCodeRunner = cl.contains('coderunner') || !!q.querySelector('.ace_editor');
    if (!isCodeRunner) {
      // Belum dinilai. Tentukan sudah-dijawab dari STATE INPUT AKTUAL, bukan kelas
      // .que dari server: pada kuis deferred-feedback (v-class) kelas tetap
      // "notyetanswered" sampai halaman disubmit, jadi mengandalkan kelas membuat
      // soal yang baru saja diisi terpilih ulang → loop tak berujung.
      const checkables = [...q.querySelectorAll('input[type="radio"], input[type="checkbox"]')];
      if (checkables.length > 0) {
        if (!checkables.some(r => r.checked)) return q;
        continue;
      }

      const textInput = q.querySelector('.answer input[type="text"], .formulation input[type="text"], input[type="text"]');
      if (textInput) {
        if (!textInput.value.trim()) return q;
        continue;
      }

      // Essay: Atto menulis ke [contenteditable] & baru sync ke textarea saat submit,
      // jadi cek KEDUANYA — textarea bisa kosong walau jawaban sudah diketik di Atto.
      const editable = q.querySelector('[contenteditable="true"]');
      const textArea = q.querySelector('textarea:not([hidden])');
      if (editable || textArea) {
        const editableFilled = editable && (editable.textContent || '').trim();
        const areaFilled = textArea && (textArea.value || '').trim();
        if (!editableFilled && !areaFilled) return q;
        continue;
      }
    }

    // Fallback berbasis kelas (CodeRunner & tipe tak dikenal).
    if (cl.contains('notyetanswered') || !cl.contains('complete')) return q;
  }
  return null;
}

// CodeRunner GapFill: jawaban berupa deretan kotak <input> kecil yang disisipkan di
// antara teks template (mis. `for (` □ ` : ` □ `) {` □ `}`). Tiap kotak hanya butuh
// POTONGAN kecil, bukan statement utuh — beda dari CodeRunner Ace (satu editor).
// Kotak gapfill = input teks terlihat, BUKAN ace_text-input/radio/checkbox/submit.
export function getGapFillInputs(queEl) {
  if (!queEl) return [];
  return [...queEl.querySelectorAll(
    'input:not([type=hidden]):not([type=radio]):not([type=checkbox]):not([type=submit]):not([type=button])'
  )].filter(el => el.offsetParent !== null && !el.classList.contains('ace_text-input'));
}

// Rekonstruksi template gapfill jadi teks dengan penanda [GAP1], [GAP2], ... di posisi
// tiap kotak input — supaya AI tahu PERSIS apa yang sudah ada di sekeliling tiap gap
// dan hanya mengisi potongan yang hilang (bukan menulis ulang `for` dll). Penjelajahan
// DOM in-order menjaga urutan gap = urutan kotak = urutan array jawaban.
export function buildGapFillTemplate(queEl, inputs) {
  const container = inputs[0]?.closest('.answer, .formulation, .coderunner-ui-element, .qtext') ||
    queEl.querySelector('.answer, .formulation') || queEl;
  const idxOf = new Map(inputs.map((el, i) => [el, i]));
  let out = '';
  const walk = node => {
    for (const child of node.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) {
        out += child.textContent;
      } else if (child.nodeType === Node.ELEMENT_NODE) {
        if (child.tagName === 'INPUT' && idxOf.has(child)) {
          out += `[GAP${idxOf.get(child) + 1}]`;
        } else if (child.tagName === 'BR') {
          out += '\n';
        } else {
          walk(child);
        }
      }
    }
  };
  walk(container);
  // Rapikan whitespace berlebih tapi pertahankan newline antar baris template.
  return out.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}


const FINAL_SUBMIT_RE = /finishattempt|submit\s+all|kirim\s+semua|selesai|finish/i;

function isVisibleButton(btn) {
  return btn && (btn.offsetParent !== null || btn.type === 'submit');
}

function buttonText(btn) {
  return (btn.innerText || btn.value || btn.name || btn.id || '').toLowerCase();
}

// Find button by keywords inside the current question only. Jangan fallback ke
// `.submitbtns` global: di halaman quiz itu sering tombol final submit / finish.
export function findButton(queEl, keywords, excludeKeywords = []) {
  if (!queEl) return null;
  const allBtns = [...queEl.querySelectorAll('button, input[type="button"], input[type="submit"]')];

  for (const btn of allBtns) {
    const txt = buttonText(btn);
    const matchesKeyword = keywords.some(k => txt.includes(k));
    const excluded = excludeKeywords.some(ex => txt.includes(ex));
    const finalSubmit = FINAL_SUBMIT_RE.test(txt);

    // Khusus untuk Check vs Precheck: jika mencari 'check' tapi ini 'precheck', harus di-skip.
    if (matchesKeyword && !excluded && !finalSubmit && isVisibleButton(btn)) {
      // Pastikan kalau cuma nyari 'check', nggak salah klik 'precheck'
      if (keywords.includes('check') && !keywords.includes('precheck') && txt.includes('precheck')) {
        continue;
      }
      return btn;
    }
  }

  return null;
}

export function moodleClickRadio(el) {
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

export function setNativeValue(el, value, isTextarea = false) {
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

export function highlightElement(el) {
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

export function fireClick(el) {
  try {
    el.click();
    el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  } catch { /**/ }
}

export function findNextButton() {
  const NEXT_KEYWORDS = ['next', 'selanjutnya', 'berikutnya', 'lanjut'];
  return [...document.querySelectorAll('button,a,input[type="button"],input[type="submit"]')]
    .find(b => {
      if (b.offsetWidth === 0 && b.offsetHeight === 0) return false;
      const txt = (b.innerText || b.value || '').toLowerCase();
      return NEXT_KEYWORDS.some(k => txt.includes(k));
    }) ?? null;
}

export function extractText() {
  const skip = new Set(['script', 'style', 'noscript', 'nav', 'header', 'footer']);
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
    acceptNode(n) {
      const tag = n.parentElement?.tagName?.toLowerCase();
      if (skip.has(tag) || n.parentElement?.closest('nav,header,footer,#flabai-snip'))
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

// ── Shared helper: smooth-scroll an element into view + push container scroll ──
export function scrollToResultElement(el, fallbackEl, forceInstant = false) {
  if (!el) return;
  try {
    el.scrollIntoView({ behavior: forceInstant ? 'auto' : 'smooth', block: 'center' });
  } catch (e) {
    try {
      const fallback = fallbackEl?.querySelector('.answer, .formulation') || fallbackEl;
      if (fallback) fallback.scrollIntoView({ behavior: 'smooth', block: 'center' });
    } catch (_) { /**/ }
  }
}

// Hitung progres kuis dari blok navigasi soal Moodle (.qn_buttons). Lintas-halaman:
// quiz-nav memuat tombol untuk SEMUA soal kuis, bukan hanya halaman ini.
// total  = jumlah tombol soal (fallback: jumlah .que di halaman).
// current = jumlah soal sudah dijawab + 1 (yang sedang dikerjakan), dibatasi total.
// Mengembalikan null bila tak ada penanda (pemanggil skip update agar tak nimpa "?").
export function computeProgress() {
  const navBtns = [...document.querySelectorAll('.qn_buttons .qnbutton, .qn_buttons a.qnbutton, .quiznavigation a.qnbutton')];
  if (navBtns.length > 0) {
    const total = navBtns.length;
    const answered = navBtns.filter(b =>
      !/notyetanswered|todo|notyetdrawn/.test(b.className || '')
    ).length;
    return { current: Math.min(answered + 1, total), total };
  }
  // Fallback: hanya tahu soal di halaman ini.
  const ques = document.querySelectorAll('.que');
  if (ques.length > 0) {
    const answered = [...ques].filter(q => q.classList.contains('complete') ||
      q.classList.contains('correct') || q.classList.contains('incorrect')).length;
    return { current: Math.min(answered + 1, ques.length), total: ques.length };
  }
  return null;
}

export function waitForBody(intervalMs, fn) {
  if (document.body) return fn();
  const id = setInterval(() => { if (document.body) { clearInterval(id); fn(); } }, intervalMs);
}

// Polling waitFor — sadar window.__flabAborted (di-set oleh content script saat batal).
export function waitFor(fn, timeout = 10000, interval = 300) {
  return new Promise(res => {
    const id = setInterval(() => {
      if (window.__flabAborted) { clearInterval(id); res(null); return; }
      const v = fn();
      if (v) { clearInterval(id); res(v); }
    }, interval);
    setTimeout(() => { clearInterval(id); res(null); }, timeout);
  });
}
