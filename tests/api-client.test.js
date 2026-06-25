import { describe, it, expect } from 'vitest';
import { __test } from '../src/shared/api-client.js';

const { splitDataUrl, normalizeAnswer, parseJsonLoose, buildUserPrompt } = __test;

describe('splitDataUrl', () => {
  it('memisahkan mime & base64 dari dataURL valid', () => {
    expect(splitDataUrl('data:image/png;base64,AAAB')).toEqual({ mime: 'image/png', base64: 'AAAB' });
  });
  it('mengembalikan null untuk input bukan dataURL', () => {
    expect(splitDataUrl('bukan-data-url')).toBeNull();
    expect(splitDataUrl('')).toBeNull();
    expect(splitDataUrl(null)).toBeNull();
  });
});

describe('normalizeAnswer', () => {
  it('string jawaban → { jawaban, index_pilihan }', () => {
    expect(normalizeAnswer({ jawaban: 'B', index_pilihan: 2 })).toEqual({ jawaban: 'B', index_pilihan: 2 });
  });
  it('array jawaban dipertahankan sebagai array', () => {
    expect(normalizeAnswer({ jawaban: ['x', 'y'], index_pilihan: 0 })).toEqual({ jawaban: ['x', 'y'], index_pilihan: 0 });
  });
  it('index_pilihan default 0 bila tak ada', () => {
    expect(normalizeAnswer({ jawaban: 'A' })).toEqual({ jawaban: 'A', index_pilihan: 0 });
  });
  it('jawaban kosong → null', () => {
    expect(normalizeAnswer({ jawaban: '' })).toBeNull();
    expect(normalizeAnswer({ jawaban: [] })).toBeNull();
    expect(normalizeAnswer(null)).toBeNull();
  });
});

describe('parseJsonLoose', () => {
  it('parse JSON murni', () => {
    expect(parseJsonLoose('{"jawaban":"A","index_pilihan":1}')).toEqual({ jawaban: 'A', index_pilihan: 1 });
  });
  it('ekstrak JSON dari code fence', () => {
    expect(parseJsonLoose('teks\n```json\n{"jawaban":"B"}\n```\nlain')).toEqual({ jawaban: 'B' });
  });
  it('ekstrak objek pertama dari teks bebas', () => {
    expect(parseJsonLoose('jawabannya: {"jawaban":"C"} selesai')).toEqual({ jawaban: 'C' });
  });
  it('mengembalikan null bila tak ada JSON', () => {
    expect(parseJsonLoose('tidak ada json')).toBeNull();
    expect(parseJsonLoose('')).toBeNull();
  });
});

describe('buildUserPrompt', () => {
  it('menyertakan teks soal untuk payload solve_text', () => {
    const p = buildUserPrompt({ type: 'solve_text', text: 'Berapa 2+2?', prompt: '' });
    expect(p).toContain('Berapa 2+2?');
  });
  it('menyertakan instruksi tambahan di depan', () => {
    const p = buildUserPrompt({ type: 'solve_text', text: 'soal', prompt: 'Pakai bahasa Indonesia' });
    expect(p.indexOf('Pakai bahasa Indonesia')).toBeLessThan(p.indexOf('soal'));
  });
  it('payload gambar tak menyertakan teks soal', () => {
    const p = buildUserPrompt({ type: 'solve_image', dataUrl: 'data:image/png;base64,AA', prompt: '' });
    expect(p).toContain('gambar');
  });
  it('payload type "image" (screenshot/snip) juga dianggap gambar', () => {
    const p = buildUserPrompt({ type: 'image', dataUrl: 'data:image/png;base64,AA', prompt: '' });
    expect(p).toContain('gambar');
    expect(p).not.toContain('Berikut soalnya');
  });
});
