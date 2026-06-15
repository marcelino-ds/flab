import { describe, it, expect, afterEach } from 'vitest';
import {
  moodleFillShortAnswer, moodleFillEssay, genericFillInQuestion,
} from '../src/content/moodle-fill.js';

afterEach(() => { document.body.innerHTML = ''; });

function que(innerHTML) {
  const d = document.createElement('div');
  d.className = 'que';
  d.innerHTML = innerHTML;
  document.body.appendChild(d);
  return d;
}

const noop = () => {};

describe('moodleFillShortAnswer', () => {
  it('isi satu kotak teks', () => {
    const q = que('<div class="answer"><input type="text" name="answer"></div>');
    expect(moodleFillShortAnswer(q, 'jawaban', noop)).toBe(true);
    expect(q.querySelector('input').value).toBe('jawaban');
  });

  it('isi banyak kotak dari array (cloze)', () => {
    const q = que('<div class="answer"><input type="text" name="answer1"><input type="text" name="answer2"></div>');
    expect(moodleFillShortAnswer(q, ['satu', 'dua'], noop)).toBe(true);
    const inputs = q.querySelectorAll('input');
    expect(inputs[0].value).toBe('satu');
    expect(inputs[1].value).toBe('dua');
  });

  it('tanpa input → false', () => {
    expect(moodleFillShortAnswer(que('<div class="answer"></div>'), 'x', noop)).toBe(false);
  });
});

describe('moodleFillEssay', () => {
  it('isi contenteditable (Atto), newline → <br>', () => {
    const q = que('<div contenteditable="true"></div>');
    expect(moodleFillEssay(q, 'baris1\\nbaris2', noop)).toBe(true);
    expect(q.querySelector('[contenteditable]').innerHTML).toContain('<br>');
  });

  it('escape HTML di essay (anti-XSS)', () => {
    const q = que('<div contenteditable="true"></div>');
    moodleFillEssay(q, '<script>alert(1)</script>', noop);
    const html = q.querySelector('[contenteditable]').innerHTML;
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('fallback ke textarea bila tak ada contenteditable', () => {
    const q = que('<textarea></textarea>');
    expect(moodleFillEssay(q, 'isi esai', noop)).toBe(true);
    expect(q.querySelector('textarea').value).toBe('isi esai');
  });
});

describe('genericFillInQuestion', () => {
  it('isi textarea untuk tipe tak dikenal', () => {
    const q = que('<textarea></textarea>');
    expect(genericFillInQuestion(q, 'apa saja', 'APA SAJA', 0, noop)).toBe(true);
    expect(q.querySelector('textarea').value).toBe('apa saja');
  });

  it('cocokkan radio via value', () => {
    const q = que('<input type="radio" value="B"><input type="radio" value="C">');
    expect(genericFillInQuestion(q, 'B', 'B', 0, noop)).toBe(true);
    expect(q.querySelectorAll('input')[0].checked).toBe(true);
  });

  it('tanpa target → false', () => {
    expect(genericFillInQuestion(que('<p>kosong</p>'), 'x', 'X', 0, noop)).toBe(false);
  });
});
