import { describe, it, expect, afterEach } from 'vitest';
import { codeFilledOk } from '../src/content/moodle-fill.js';

afterEach(() => { document.body.innerHTML = ''; });

// Bangun .que CodeRunner yang getExistingCode() baca dari textarea[name*=answer].
function queWithCode(code) {
  const d = document.createElement('div');
  d.className = 'que coderunner';
  d.innerHTML = `<div class="answer"><textarea name="answer">${code}</textarea></div>`;
  document.body.appendChild(d);
  return d;
}

const EXPECTED = [
  'import java.util.*;',
  'public class Solution {',
  '  public static int solve(int[] nums) {',
  '    int sum = 0;',
  '    for (int n : nums) sum += n;',
  '    return sum;',
  '  }',
  '}',
].join('\n');

describe('codeFilledOk', () => {
  it('benar bila editor berisi kode yang persis sama', () => {
    expect(codeFilledOk(queWithCode(EXPECTED), EXPECTED)).toBe(true);
  });

  it('benar walau Ace menormalkan whitespace/indentasi', () => {
    const noisy = EXPECTED.replace(/\n/g, ' \n').replace(/ {2,}/g, '    ');
    expect(codeFilledOk(queWithCode(noisy), EXPECTED)).toBe(true);
  });

  it('salah bila editor kosong', () => {
    expect(codeFilledOk(queWithCode(''), EXPECTED)).toBe(false);
  });

  it('salah bila kode belum terisi — hanya awalan sama (anti prefix-only)', () => {
    // Awalan identik 60 char, tapi isi fungsi belum masuk → harus TOLAK.
    const prefixOnly = EXPECTED.slice(0, 60) + ' // not implemented';
    expect(codeFilledOk(queWithCode(prefixOnly), EXPECTED)).toBe(false);
  });

  it('salah bila Ace menyisakan template lama yang jauh lebih panjang', () => {
    // Konten inti expected ada di dalamnya, tapi banyak kode lama menempel → tolak.
    const staleTemplate = EXPECTED + '\n'.repeat(1) + EXPECTED + '\n'.repeat(1) +
      'class OldLeftover { void dead() { /* template lama */ } }';
    expect(codeFilledOk(queWithCode(staleTemplate), EXPECTED)).toBe(false);
  });

  it('toleran terhadap boilerplate wajar (sedikit lebih panjang, <= 1.5x)', () => {
    const withComment = EXPECTED + '\n// trailing newline/comment wajar';
    expect(codeFilledOk(queWithCode(withComment), EXPECTED)).toBe(true);
  });
});
