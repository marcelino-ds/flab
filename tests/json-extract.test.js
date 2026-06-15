import { describe, it, expect } from 'vitest';
import { matchClosingBrace } from '../src/injector/json-extract.js';

// Helper: ekstrak blok JSON seperti yang dilakukan observeAndExtractJson.
function extractBlock(text) {
  const jPos = text.lastIndexOf('"jawaban"');
  if (jPos === -1) return null;
  const s = text.lastIndexOf('{', jPos);
  if (s === -1) return null;
  const e = matchClosingBrace(text, s);
  if (e === -1 || e <= s) return null;
  return text.slice(s, e + 1);
}

describe('matchClosingBrace', () => {
  it('cocokkan objek sederhana', () => {
    const t = '{"jawaban":"A","index_pilihan":1}';
    expect(matchClosingBrace(t, 0)).toBe(t.length - 1);
  });

  it('abaikan brace di dalam string', () => {
    const t = '{"jawaban":"if (x) { y }","index_pilihan":2}';
    const e = matchClosingBrace(t, 0);
    expect(JSON.parse(t.slice(0, e + 1)).index_pilihan).toBe(2);
  });

  it('abaikan escaped quote di dalam string', () => {
    const t = '{"jawaban":"katakan \\"halo\\" {ok}","index_pilihan":1}';
    const e = matchClosingBrace(t, 0);
    expect(JSON.parse(t.slice(0, e + 1)).index_pilihan).toBe(1);
  });

  it('jawaban koding penuh {} + teks setelah blok (kasus regresi utama)', () => {
    const t = 'Penjelasan dulu. {"jawaban":"public class X { void f(){ if(a){b();} } }","index_pilihan":0} Semoga membantu! }';
    const block = extractBlock(t);
    const obj = JSON.parse(block);
    expect(obj.index_pilihan).toBe(0);
    expect(obj.jawaban).toContain('public class X');
  });

  it('kembalikan -1 bila tidak seimbang', () => {
    expect(matchClosingBrace('{"a":1', 0)).toBe(-1);
  });

  it('nested object dalam jawaban', () => {
    const t = '{"jawaban":"x","meta":{"a":{"b":1}},"index_pilihan":3}';
    const e = matchClosingBrace(t, 0);
    expect(JSON.parse(t.slice(0, e + 1)).index_pilihan).toBe(3);
  });
});
