import { describe, it, expect, afterEach } from 'vitest';
import { checkIfCorrect, hasOfficialGradeSignal, officialGradeSignature } from '../src/content/grading.js';

afterEach(() => { document.body.innerHTML = ''; });

function el(html) {
  const d = document.createElement('div');
  d.innerHTML = html;
  document.body.appendChild(d);
  return d;
}

describe('checkIfCorrect', () => {
  it('class correct → true', () => {
    const q = el('<div class="que correct"></div>').firstElementChild;
    expect(checkIfCorrect(q)).toBe(true);
  });

  it('class incorrect → false', () => {
    const q = el('<div class="que incorrect"></div>').firstElementChild;
    expect(checkIfCorrect(q)).toBe(false);
  });

  it('partiallycorrect → false', () => {
    const q = el('<div class="que partiallycorrect"></div>').firstElementChild;
    expect(checkIfCorrect(q)).toBe(false);
  });

  it('feedback teks "Correct" → true', () => {
    const q = el('<div class="que"><div class="outcome">Correct answer</div></div>').firstElementChild;
    expect(checkIfCorrect(q)).toBe(true);
  });

  it('grade penuh (1/1) → true', () => {
    const q = el('<div class="que"><div class="grade">Mark 1.00 / 1.00</div></div>').firstElementChild;
    expect(checkIfCorrect(q)).toBe(true);
  });

  it('grade sebagian (0.5/1) → false', () => {
    const q = el('<div class="que"><div class="grade">Mark 0.50 / 1.00</div></div>').firstElementChild;
    expect(checkIfCorrect(q)).toBe(false);
  });

  it('tanpa sinyal → null (unknown)', () => {
    const q = el('<div class="que"></div>').firstElementChild;
    expect(checkIfCorrect(q)).toBe(null);
  });

  it('queEl null → null', () => {
    expect(checkIfCorrect(null)).toBe(null);
  });

  it('badge .info .state "Correct" (tanpa kelas) → true', () => {
    const q = el('<div class="que coderunner"><div class="info"><div class="state">Correct</div></div></div>').firstElementChild;
    expect(checkIfCorrect(q)).toBe(true);
  });

  it('badge .info .state "Incorrect" (tanpa kelas) → false', () => {
    const q = el('<div class="que coderunner"><div class="info"><div class="state">Incorrect</div></div></div>').firstElementChild;
    expect(checkIfCorrect(q)).toBe(false);
  });

  it('badge .info .state "Tidak benar" → false, bukan benar', () => {
    const q = el('<div class="que coderunner"><div class="info"><div class="state">Tidak benar</div></div></div>').firstElementChild;
    expect(checkIfCorrect(q)).toBe(false);
  });

  it('badge .info .state "Not yet answered" → null (belum dinilai)', () => {
    const q = el('<div class="que coderunner"><div class="info"><div class="state">Not yet answered</div></div></div>').firstElementChild;
    expect(checkIfCorrect(q)).toBe(null);
  });

  it('tabel CodeRunner tanpa status resmi → null (bisa stale dari PRECHECK)', () => {
    const q = el(`<div class="que coderunner"><div class="coderunner-test-results">
      <table><tr><th>Test</th></tr><tr><td>Kompilasi gagal. Pengujian dibatalkan!</td></tr></table>
      Your code must pass all tests to earn any marks. Try again.
    </div></div>`).firstElementChild;
    expect(checkIfCorrect(q)).toBe(null);
    expect(hasOfficialGradeSignal(q)).toBe(false);
  });

  it('tabel CodeRunner passed tanpa status resmi → null (CHECK resmi belum pasti)', () => {
    const q = el('<div class="que coderunner"><div class="coderunner-test-results">Passed all tests!</div></div>').firstElementChild;
    expect(checkIfCorrect(q)).toBe(null);
  });

  it('grade "20.00 out of 20.00" → true', () => {
    const q = el('<div class="que"><div class="grade">Mark 20.00 out of 20.00</div></div>').firstElementChild;
    expect(checkIfCorrect(q)).toBe(true);
  });

  it('grade "0.00 out of 20.00" → false', () => {
    const q = el('<div class="que"><div class="grade">Mark 0.00 out of 20.00</div></div>').firstElementChild;
    expect(checkIfCorrect(q)).toBe(false);
  });
});


describe('hasOfficialGradeSignal', () => {
  it('true untuk class/status/grade resmi', () => {
    expect(hasOfficialGradeSignal(el('<div class="que correct"></div>').firstElementChild)).toBe(true);
    expect(hasOfficialGradeSignal(el('<div class="que"><div class="info"><div class="state">Incorrect</div></div></div>').firstElementChild)).toBe(true);
    expect(hasOfficialGradeSignal(el('<div class="que"><div class="grade">Mark 1 / 1</div></div>').firstElementChild)).toBe(true);
  });

  it('false untuk feedback/outcome saja agar tidak memakai hasil CHECK stale', () => {
    expect(hasOfficialGradeSignal(el('<div class="que"><div class="feedback">Jawaban benar</div></div>').firstElementChild)).toBe(false);
    expect(hasOfficialGradeSignal(el('<div class="que"><div class="outcome">Try again</div></div>').firstElementChild)).toBe(false);
  });

  it('officialGradeSignature berubah hanya saat sinyal resmi berubah', () => {
    const q = el('<div class="que"><div class="info"><div class="state">Not yet answered</div></div></div>').firstElementChild;
    expect(officialGradeSignature(q)).toBe('');
    q.querySelector('.state').textContent = 'Correct';
    expect(officialGradeSignature(q)).toContain('correct');
  });

  it('false untuk Not yet answered, placeholder grade, dan tabel precheck saja', () => {
    const q = el('<div class="que"><div class="info"><div class="state">Not yet answered</div></div><div class="grade">Marked out of 1.00</div><div class="coderunner-test-results">Passed all tests</div></div>').firstElementChild;
    expect(hasOfficialGradeSignal(q)).toBe(false);
  });
});
