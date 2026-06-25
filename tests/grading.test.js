import { describe, it, expect, afterEach } from 'vitest';
import { checkIfCorrect } from '../src/content/grading.js';

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

  it('badge .info .state "Not yet answered" → null (belum dinilai)', () => {
    const q = el('<div class="que coderunner"><div class="info"><div class="state">Not yet answered</div></div></div>').firstElementChild;
    expect(checkIfCorrect(q)).toBe(null);
  });

  it('tabel CodeRunner "must pass all tests... Try again" → false', () => {
    const q = el(`<div class="que coderunner"><div class="coderunner-test-results">
      <table><tr><th>Test</th></tr><tr><td>Kompilasi gagal. Pengujian dibatalkan!</td></tr></table>
      Your code must pass all tests to earn any marks. Try again.
    </div></div>`).firstElementChild;
    expect(checkIfCorrect(q)).toBe(false);
  });

  it('tabel CodeRunner "Passed all tests" → true', () => {
    const q = el('<div class="que coderunner"><div class="coderunner-test-results">Passed all tests!</div></div>').firstElementChild;
    expect(checkIfCorrect(q)).toBe(true);
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
