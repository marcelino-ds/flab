// Pengisian jawaban per tipe soal Moodle (multichoice/short/essay/coderunner/generic).
import { escapeHtml, sleep } from '../shared/util.js';
import { moodleClickRadio, highlightElement, setNativeValue } from './dom-utils.js';
import { getMoodleOptions } from './moodle-options.js';
import { getAceEditor, getExistingCode, syncAceToTextarea } from './ace-editor.js';

// Index-first: karena getMoodleOptions() menjamin urutan opsi yang dikirim ke AI
// identik dengan urutan input di DOM, index_pilihan dari AI adalah sinyal paling
// andal. Exact-text dipakai sebagai validator (single-select) & jalur utama
// multi-select. Partial/includes match SENGAJA tidak dipakai (rawan salah pilih).
export function moodleFillMultichoice(queEl, originalJaw, jaw, idxHint, status) {
  const norm = s => String(s).toUpperCase()
    .replace(/\s+/g, '')
    .replace(/\\?SQRT|AKAR/g, '√')
    .replace(/\\/g, '')
    .replace(/[{}()[\]]/g, '')
    .trim();

  const options = getMoodleOptions(queEl); // [{ input, index, text }]
  console.log(`[FLAB] Multichoice: ${options.length} opsi, jawaban="${originalJaw}", idxHint=${idxHint}`);
  if (options.length === 0) {
    console.warn('[FLAB] Tidak ada radio/checkbox ditemukan di question element');
    return false;
  }

  const isArray = Array.isArray(jaw);
  const jawArr = isArray ? jaw : [jaw];
  const jawNormArr = jawArr.map(j => norm(j));

  // Cari opsi yang teksnya cocok persis dengan satu jawaban (validator/fallback)
  const findByText = (rawJaw, normJaw) => {
    for (const opt of options) {
      const raw = opt.text.toUpperCase().trim();
      const clean = raw.replace(/^[A-Ea-e][.)\s]+/i, '').trim();
      const val = (opt.input.value || '').toUpperCase().trim();
      if (raw === rawJaw || clean === rawJaw || val === rawJaw ||
          norm(opt.text) === normJaw || norm(clean) === normJaw) {
        return opt;
      }
      if (raw.startsWith(rawJaw + '.') || raw.startsWith(rawJaw + ')')) return opt;
    }
    return null;
  };

  const select = opt => {
    if (!opt) return;
    moodleClickRadio(opt.input);
    highlightElement(opt.input.closest('.r0,.r1,.r2,.r3,.r4,div,label') || opt.input.parentElement);
  };

  let matchCount = 0;

  // ── Single-select: index-first dengan validasi teks ───────────────────────
  if (!isArray) {
    const currentJaw = jawArr[0];
    const currentJawNorm = jawNormArr[0];
    const byText = findByText(currentJaw, currentJawNorm);
    const idxValid = idxHint > 0 && idxHint <= options.length;
    const byIndex = idxValid ? options[idxHint - 1] : null;

    let chosen = null;
    if (byIndex && byText && byIndex.index === byText.index) {
      chosen = byIndex;                       // index & teks sepakat → paling yakin
    } else if (byText) {
      chosen = byText;                        // teks cocok eksplisit → percaya teks
    } else if (byIndex) {
      chosen = byIndex;                       // hanya index → andalkan alignment terjamin
    } else if (currentJaw.length === 1 && currentJaw >= 'A' && currentJaw <= 'E') {
      const i = currentJaw.charCodeAt(0) - 65; // fallback huruf A–E
      if (i < options.length) chosen = options[i];
    }

    if (chosen) { select(chosen); matchCount++; }
  } else {
    // ── Multi-select: cocokkan tiap jawaban via teks (index_pilihan = 0) ──────
    for (let k = 0; k < jawArr.length; k++) {
      const opt = findByText(jawArr[k], jawNormArr[k]);
      if (opt && !opt.input.checked) { select(opt); matchCount++; }
    }
  }

  if (matchCount > 0) {
    status(`✅ Dipilih ${matchCount} opsi jawaban.`);
    return true;
  }

  console.warn('[FLAB] Multichoice: tidak ada opsi yang cocok dengan jawaban');
  return false;
}

// ── iLab: Short Answer filler ───────────────────────────────────────────────
export function moodleFillShortAnswer(queEl, jawaban, status) {
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
export function moodleFillEssay(queEl, jawaban, status) {
  const jText = jawaban.replace(/\\n/g, '\n');

  const attoEditor = queEl.querySelector('[contenteditable="true"]');
  if (attoEditor) {
    attoEditor.focus();
    attoEditor.innerHTML = escapeHtml(jText).replace(/\n/g, '<br>');
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

// ── iLab: CodeRunner filler (preserves template code) ────────────────────────
export async function moodleFillCodeRunner(queEl, jawaban, status) {
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
      if (codeFilledOk(queEl, jText)) {
        highlightElement(queEl.querySelector('.ace_editor'));
        status('✅ Kode diisi (Ace Editor API).');
        return true;
      }
      console.warn('[FLAB] Ace setValue tidak terverifikasi, coba fallback.');
    } catch (e) {
      // Jika setValue error karena ada region read-only (CodeRunner GapFill versi Editor),
      // kita gunakan selectAll + insert yang secara otomatis mematuhi batas read-only!
      try {
        editor.selection.selectAll();
        editor.remove(); // Delete whatever we selected first
        editor.insert(jText);
        syncAceToTextarea(queEl);
        if (codeFilledOk(queEl, jText)) {
          highlightElement(queEl.querySelector('.ace_editor'));
          status('✅ Kode diisi (Ace Insert Fallback).');
          return true;
        }
        console.warn('[FLAB] Ace insert fallback tidak terverifikasi.');
      } catch (err2) {
        console.warn('[FLAB] Ace API fallback failed:', err2);
      }
    }
  }

  // Method 2: Ace text-input paste (select all first → then paste full code to replace existing)
  const aceInput = queEl.querySelector('.ace_text-input');
  if (aceInput) {
    aceInput.focus();
    // Select all existing content first so paste replaces rather than appends
    aceInput.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'a',
      code: 'KeyA',
      keyCode: 65,
      ctrlKey: true,
      bubbles: true
    }));
    await sleep(100);
    const dt = new DataTransfer();
    dt.setData('text/plain', jText);
    aceInput.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true }));
    if (!codeFilledOk(queEl, jText)) {
      try { document.execCommand('insertText', false, jText); } catch (e) { console.debug('[FLAB] execCommand insertText gagal:', e); }
    }
    syncAceToTextarea(queEl);
    // Paste sintetis sering TIDAK mengisi Ace — verifikasi sebelum klaim berhasil.
    if (codeFilledOk(queEl, jText)) {
      highlightElement(queEl.querySelector('.ace_editor') || aceInput);
      status('✅ Kode diisi (Ace paste).');
      return true;
    }
    console.warn('[FLAB] Ace paste tidak terverifikasi, coba textarea.');
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

// Verifikasi kode benar-benar masuk editor. Bandingkan prefiks non-whitespace agar
// toleran terhadap normalisasi indentasi/newline oleh Ace, tanpa false-positive kosong.
function codeFilledOk(queEl, expected) {
  const actual = getExistingCode(queEl) || '';
  const norm = s => String(s).replace(/\s+/g, '');
  const a = norm(actual);
  const e = norm(expected);
  if (e.length === 0) return a.length === 0;
  if (a.length === 0) return false;
  // Anggap berhasil bila editor memuat sebagian besar konten yang diharapkan.
  return a.includes(e.slice(0, Math.min(e.length, 60))) || a.length >= e.length * 0.9;
}

// ── Generic fill for unknown question types ─────────────────────────────────
export function genericFillInQuestion(queEl, originalJaw, jaw, idxHint, status) {
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
