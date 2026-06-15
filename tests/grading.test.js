import { describe, it, expect, afterEach } from 'vitest';
import { parsePrecheckResult, checkIfCorrect } from '../src/content/grading.js';

afterEach(() => { document.body.innerHTML = ''; });

function el(html) {
  const d = document.createElement('div');
  d.innerHTML = html;
  document.body.appendChild(d);
  return d;
}

describe('parsePrecheckResult — text indicators', () => {
  it('"passed all tests" → true', () => {
    const e = el('<p>Passed all tests</p>');
    expect(parsePrecheckResult('Passed all tests', e)).toBe(true);
  });

  it('"passed" tunggal tanpa fail → true', () => {
    const e = el('<p>Passed</p>');
    expect(parsePrecheckResult('Passed', e)).toBe(true);
  });

  it('"Test 1 passed, Test 2 failed" → false (ada fail)', () => {
    const e = el('<p>Test 1 passed, Test 2 failed</p>');
    expect(parsePrecheckResult('Test 1 passed, Test 2 failed', e)).toBe(false);
  });

  it('"not passed" → false', () => {
    const e = el('<p>not passed</p>');
    expect(parsePrecheckResult('not passed', e)).toBe(false);
  });

  it('teks kosong/tak dikenal → false (konservatif, picu retry)', () => {
    const e = el('<p></p>');
    expect(parsePrecheckResult('', e)).toBe(false);
  });
});

describe('parsePrecheckResult — result table', () => {
  it('semua row bertanda Pass/centang → true', () => {
    const e = el(`<table>
      <tr><th>Test</th><th>Status</th></tr>
      <tr><td>1</td><td>Pass</td></tr>
      <tr><td>2</td><td>Pass</td></tr>
    </table>`);
    expect(parsePrecheckResult('', e)).toBe(true);
  });

  it('Expected == Got di semua row → true', () => {
    const e = el(`<table>
      <tr><th>Test</th><th>Expected</th><th>Got</th></tr>
      <tr><td>a</td><td>5</td><td>5</td></tr>
      <tr><td>b</td><td>10</td><td>10</td></tr>
    </table>`);
    expect(parsePrecheckResult('', e)).toBe(true);
  });

  it('Expected != Got → false', () => {
    const e = el(`<table>
      <tr><th>Test</th><th>Expected</th><th>Got</th></tr>
      <tr><td>a</td><td>5</td><td>4</td></tr>
    </table>`);
    expect(parsePrecheckResult('', e)).toBe(false);
  });

  it('baris tak lengkap → false (konservatif, tidak diklaim lulus)', () => {
    const e = el(`<table>
      <tr><th>Test</th><th>Expected</th><th>Got</th></tr>
      <tr><td>a</td></tr>
    </table>`);
    expect(parsePrecheckResult('', e)).toBe(false);
  });
});

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
});
