import { describe, it, expect, afterEach } from 'vitest';
import {
  findButton, findUnansweredQuestion, setNativeValue, computeProgress,
  isQuestionGraded, isQuestionCorrect, isQuestionIncorrect, canResubmit,
  getGapFillInputs, buildGapFillTemplate,
} from '../src/content/dom-utils.js';

afterEach(() => { document.body.innerHTML = ''; });

function que(innerHTML, className = 'que') {
  const d = document.createElement('div');
  d.className = className;
  d.innerHTML = innerHTML;
  document.body.appendChild(d);
  return d;
}

describe('findButton — keyword match + precheck/check disambiguation', () => {
  it('temukan tombol Check', () => {
    const q = que('<button>Check</button>');
    expect(findButton(q, ['check'])?.innerText).toBe('Check');
  });

  it('JANGAN klik Precheck saat mencari "check"', () => {
    const q = que('<button>Precheck</button>');
    expect(findButton(q, ['check'], ['precheck'])).toBeNull();
  });

  it('pilih Check, bukan Precheck, saat keduanya ada', () => {
    const q = que('<button>Precheck</button><button>Check</button>');
    expect(findButton(q, ['check'], ['precheck'])?.innerText).toBe('Check');
  });

  it('temukan Precheck saat memang mencari precheck', () => {
    const q = que('<button>Precheck</button>');
    expect(findButton(q, ['precheck'])?.innerText).toBe('Precheck');
  });

  it('cocok via value pada input submit', () => {
    const q = que('<input type="submit" value="Periksa">');
    expect(findButton(q, ['periksa'])?.value).toBe('Periksa');
  });

  it('null bila tidak ada yang cocok', () => {
    const q = que('<button>Batal</button>');
    expect(findButton(q, ['check'])).toBeNull();
  });
});

describe('findUnansweredQuestion', () => {
  it('pilih soal yang belum complete', () => {
    const a = que('<input type="radio" checked>', 'que complete');
    const b = que('<input type="radio">', 'que');
    expect(findUnansweredQuestion([a, b])).toBe(b);
  });

  it('soal dengan text input kosong dianggap belum dijawab', () => {
    const q = que('<input type="text" value="">', 'que complete');
    expect(findUnansweredQuestion([q])).toBe(q);
  });

  it('soal complete dengan radio tercentang dilewati', () => {
    const q = que('<input type="radio" checked>', 'que complete');
    expect(findUnansweredQuestion([q])).toBeNull();
  });

  it('soal sudah dinilai correct dilewati (cegah loop re-solve)', () => {
    const q = que('<input type="text" value="int[] a = new int[100];">', 'que correct');
    expect(findUnansweredQuestion([q])).toBeNull();
  });

  it('soal incorrect TANPA tombol Check dilewati (terminal, tak bisa diperbaiki)', () => {
    const q = que('<input type="radio">', 'que incorrect');
    expect(findUnansweredQuestion([q])).toBeNull();
  });

  it('soal incorrect MASIH bisa di-Check → dipilih ulang (perbaiki sampai benar)', () => {
    const q = que('<textarea>kode salah</textarea><button>Check</button>', 'que incorrect');
    expect(isQuestionIncorrect(q)).toBe(true);
    expect(canResubmit(q)).toBe(true);
    expect(findUnansweredQuestion([q])).toBe(q);
  });

  it('incorrect via teks .state + tombol Check (tanpa kelas) → dipilih ulang', () => {
    const q = que(
      '<div class="info"><div class="state">Incorrect</div></div>' +
      '<textarea>kode</textarea><button>Check</button>',
      'que coderunner'
    );
    expect(isQuestionCorrect(q)).toBe(false);
    expect(isQuestionIncorrect(q)).toBe(true);
    expect(findUnansweredQuestion([q])).toBe(q);
  });

  it('lewati soal correct, pilih soal berikutnya yang belum dijawab', () => {
    const a = que('<input type="text" value="ok">', 'que correct');
    const b = que('<input type="radio">', 'que');
    expect(findUnansweredQuestion([a, b])).toBe(b);
  });

  it('soal dinilai correct via teks .state (tanpa kelas correct) dilewati', () => {
    // CodeRunner iLab Gunadarma: .que tak punya kelas correct, status di .info .state.
    const q = que(
      '<div class="info"><div class="state">Correct</div></div>' +
      '<textarea>nilai[5] = 89;</textarea>',
      'que coderunner'
    );
    expect(isQuestionGraded(q)).toBe(true);
    expect(findUnansweredQuestion([q])).toBeNull();
  });

  it('soal "Not yet answered" via teks tetap dianggap belum dijawab', () => {
    const q = que(
      '<div class="info"><div class="state">Not yet answered</div></div>' +
      '<textarea></textarea>',
      'que coderunner'
    );
    expect(isQuestionGraded(q)).toBe(false);
    expect(findUnansweredQuestion([q])).toBe(q);
  });
});

describe('getGapFillInputs + buildGapFillTemplate', () => {
  it('deteksi kotak gapfill (abaikan hidden/submit/ace)', () => {
    const q = que(
      '<div class="answer">for ( <input type="text"> : <input type="text"> ) {}' +
      '<input type="hidden"><input type="submit"></div>',
      'que coderunner'
    );
    expect(getGapFillInputs(q).length).toBe(2);
  });

  it('rekonstruksi template dengan penanda [GAPn] urut posisi', () => {
    const q = que(
      '<div class="answer">for ( <input type="text"> : <input type="text"> ) {<br>' +
      '<input type="text"><br>}</div>',
      'que coderunner'
    );
    const inputs = getGapFillInputs(q);
    const tmpl = buildGapFillTemplate(q, inputs);
    expect(tmpl).toContain('for (');
    expect(tmpl).toContain('[GAP1]');
    expect(tmpl).toContain('[GAP2]');
    expect(tmpl).toContain('[GAP3]');
    // Urutan penanda harus sesuai urutan kemunculan kotak.
    expect(tmpl.indexOf('[GAP1]')).toBeLessThan(tmpl.indexOf('[GAP2]'));
    expect(tmpl.indexOf('[GAP2]')).toBeLessThan(tmpl.indexOf('[GAP3]'));
  });

  it('soal tanpa kotak inline → array kosong', () => {
    const q = que('<div class="ace_editor"></div>', 'que coderunner');
    expect(getGapFillInputs(q).length).toBe(0);
  });
});

describe('setNativeValue', () => {
  it('set value input + dispatch input/change', () => {
    const input = document.createElement('input');
    let inputFired = false, changeFired = false;
    input.addEventListener('input', () => { inputFired = true; });
    input.addEventListener('change', () => { changeFired = true; });
    setNativeValue(input, 'halo');
    expect(input.value).toBe('halo');
    expect(inputFired).toBe(true);
    expect(changeFired).toBe(true);
  });

  it('set value textarea (isTextarea=true)', () => {
    const ta = document.createElement('textarea');
    setNativeValue(ta, 'baris', true);
    expect(ta.value).toBe('baris');
  });
});

// Catatan: findNextButton tidak diunit-test di sini — ia memfilter tombol via
// offsetWidth/offsetHeight (visibility), dan happy-dom tidak melakukan layout
// sehingga dimensi selalu 0. Verifikasi visibilitas dilakukan di browser nyata.

describe('computeProgress', () => {
  function navHtml(states) {
    // states: array className tiap tombol soal
    return '<div class="qn_buttons">' +
      states.map(c => `<a class="qnbutton ${c}">x</a>`).join('') + '</div>';
  }

  it('quiz-nav: total = jumlah tombol, current = terjawab + 1', () => {
    document.body.innerHTML = navHtml(['answered', 'answered', 'notyetanswered', 'notyetanswered']);
    expect(computeProgress()).toEqual({ current: 3, total: 4 });
  });

  it('quiz-nav: current dibatasi total saat semua terjawab', () => {
    document.body.innerHTML = navHtml(['answered', 'answered']);
    expect(computeProgress()).toEqual({ current: 2, total: 2 });
  });

  it('fallback ke .que bila tak ada quiz-nav', () => {
    document.body.innerHTML =
      '<div class="que complete"></div><div class="que"></div><div class="que"></div>';
    expect(computeProgress()).toEqual({ current: 2, total: 3 });
  });

  it('null bila tak ada penanda apa pun', () => {
    document.body.innerHTML = '<p>halaman biasa</p>';
    expect(computeProgress()).toBeNull();
  });
});
