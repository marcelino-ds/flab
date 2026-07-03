import { describe, it, expect } from 'vitest';
import {
  extractAnswerObject,
  matchClosingBrace,
  normalizeAnswer,
  parseAnswerFromText,
} from '../src/shared/answer-parser.js';

describe('answer-parser shared helpers', () => {
  it('matchClosingBrace mengabaikan brace di dalam string kode', () => {
    const text = '{"jawaban":"class X { void f(){ if (ok) { run(); } } }","index_pilihan":0} tail }';
    const end = matchClosingBrace(text, 0);
    expect(JSON.parse(text.slice(0, end + 1)).jawaban).toContain('class X');
  });

  it('mengambil objek terakhir yang berisi jawaban', () => {
    const text = 'draft {"jawaban":"A","index_pilihan":1}\nfinal {"jawaban":"B","index_pilihan":2}';
    expect(extractAnswerObject(text)).toEqual({ jawaban: 'B', index_pilihan: 2 });
  });

  it('mengambil JSON dari code fence meski ada prose setelahnya', () => {
    const text = 'penalaran\n```json\n{"jawaban":["HTML","CSS"],"index_pilihan":0}\n```\nselesai';
    expect(parseAnswerFromText(text)).toEqual({ jawaban: ['HTML', 'CSS'], index_pilihan: 0 });
  });

  it('smart quotes dinormalisasi secara aman sebelum parse', () => {
    const text = 'hasil: {“jawaban”:“Benar”,“index_pilihan”:1}';
    expect(parseAnswerFromText(text)).toEqual({ jawaban: 'Benar', index_pilihan: 1 });
  });

  it('menolak jawaban kosong/nullish/object', () => {
    expect(normalizeAnswer({ jawaban: '' })).toBeNull();
    expect(normalizeAnswer({ jawaban: 'null' })).toBeNull();
    expect(normalizeAnswer({ jawaban: [] })).toBeNull();
    expect(normalizeAnswer({ jawaban: ['A', ''] })).toBeNull();
    expect(normalizeAnswer({ jawaban: { teks: 'A' } })).toBeNull();
  });

  it('index_pilihan invalid dinormalkan ke 0', () => {
    expect(normalizeAnswer({ jawaban: 'A', index_pilihan: 'oops' })).toEqual({ jawaban: 'A', index_pilihan: 0 });
  });

  it('fallback longgar memulihkan jawaban kode dengan raw newline dalam string', () => {
    const text = `\`\`\`json
{"jawaban":"public class X {
  void f() {}
}","index_pilihan":0}
\`\`\``;
    expect(parseAnswerFromText(text)).toEqual({ jawaban: `public class X {
  void f() {}
}`, index_pilihan: 0 });
  });

  it('fallback longgar mendekode escaped quote dalam kode', () => {
    const text = `\`\`\`json
{"jawaban":"System.out.println(\\"OK\\");
return;","index_pilihan":0}
\`\`\``;
    expect(parseAnswerFromText(text)).toEqual({ jawaban: 'System.out.println("OK");\nreturn;', index_pilihan: 0 });
  });
});
