import { describe, it, expect } from 'vitest';
import { detectQuestionType } from '../src/content/platform.js';

// Bangun elemen .que dengan class + isi tertentu.
function que(className, innerHTML = '') {
  const d = document.createElement('div');
  d.className = className;
  d.innerHTML = innerHTML;
  return d;
}

describe('detectQuestionType — via class .que', () => {
  it('multichoice', () => {
    expect(detectQuestionType(que('que multichoice'))).toBe('multichoice');
  });
  it('shortanswer', () => {
    expect(detectQuestionType(que('que shortanswer'))).toBe('shortanswer');
  });
  it('essay', () => {
    expect(detectQuestionType(que('que essay'))).toBe('essay');
  });
  it('coderunner', () => {
    expect(detectQuestionType(que('que coderunner'))).toBe('coderunner');
  });
  it('numerical', () => {
    expect(detectQuestionType(que('que numerical'))).toBe('numerical');
  });
  it('match', () => {
    expect(detectQuestionType(que('que match'))).toBe('match');
  });
  it('truefalse', () => {
    expect(detectQuestionType(que('que truefalse'))).toBe('truefalse');
  });
});

describe('detectQuestionType — fallback via konten DOM (tanpa class tipe)', () => {
  it('null/undefined → unknown', () => {
    expect(detectQuestionType(null)).toBe('unknown');
  });

  it('.ace_editor → coderunner (cek SEBELUM radio)', () => {
    // Soal koding bisa juga punya radio; .ace_editor harus menang.
    const el = que('que', '<div class="ace_editor"></div><input type="radio">');
    expect(detectQuestionType(el)).toBe('coderunner');
  });

  it('radio → multichoice', () => {
    expect(detectQuestionType(que('que', '<input type="radio">'))).toBe('multichoice');
  });

  it('checkbox → multichoice', () => {
    expect(detectQuestionType(que('que', '<input type="checkbox">'))).toBe('multichoice');
  });

  it('input text → shortanswer', () => {
    expect(detectQuestionType(que('que', '<input type="text">'))).toBe('shortanswer');
  });

  it('textarea → essay', () => {
    expect(detectQuestionType(que('que', '<textarea></textarea>'))).toBe('essay');
  });

  it('kosong → unknown', () => {
    expect(detectQuestionType(que('que', '<p>cuma teks</p>'))).toBe('unknown');
  });

  it('class tipe menang atas konten (coderunner walau ada radio)', () => {
    const el = que('que coderunner', '<input type="radio">');
    expect(detectQuestionType(el)).toBe('coderunner');
  });
});
