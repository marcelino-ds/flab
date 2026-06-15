import { describe, it, expect, afterEach } from 'vitest';
import { moodleFillMultichoice } from '../src/content/moodle-fill.js';

afterEach(() => { document.body.innerHTML = ''; });

// Bangun .que multichoice dengan opsi (label = teks). Mengembalikan {que, radios}.
function mc(options, type = 'radio') {
  const d = document.createElement('div');
  d.className = 'que multichoice';
  d.innerHTML = '<div class="answer">' + options.map((txt, i) =>
    `<div class="r${i}"><input type="${type}" id="o${i}"><label for="o${i}">${txt}</label></div>`
  ).join('') + '</div>';
  document.body.appendChild(d);
  return { que: d, radios: [...d.querySelectorAll('input')] };
}

// Helper memanggil sesuai konvensi caller (jaw = uppercase originalJaw).
function fill(que, originalJaw, idxHint) {
  const jaw = Array.isArray(originalJaw)
    ? originalJaw.map(s => String(s).toUpperCase())
    : String(originalJaw).toUpperCase();
  return moodleFillMultichoice(que, originalJaw, jaw, idxHint, () => {});
}

describe('moodleFillMultichoice — single select', () => {
  it('index & teks sepakat → klik opsi itu', () => {
    const { que, radios } = mc(['Merah', 'Hijau', 'Biru']);
    expect(fill(que, 'Hijau', 2)).toBe(true);
    expect(radios[1].checked).toBe(true);
  });

  it('teks cocok walau index tidak diberikan (idxHint 0)', () => {
    const { que, radios } = mc(['Apel', 'Jeruk', 'Mangga']);
    expect(fill(que, 'Mangga', 0)).toBe(true);
    expect(radios[2].checked).toBe(true);
  });

  it('hanya index valid (teks tak cocok) → andalkan index', () => {
    const { que, radios } = mc(['Alpha', 'Beta', 'Gamma']);
    expect(fill(que, 'TidakAda', 1)).toBe(true);
    expect(radios[0].checked).toBe(true);
  });

  it('index salah tapi teks cocok → utamakan teks (anti mis-click)', () => {
    const { que, radios } = mc(['Satu', 'Dua', 'Tiga']);
    // idxHint menunjuk opsi 1 (Satu), tapi teks jelas "Tiga" → harus pilih Tiga
    expect(fill(que, 'Tiga', 1)).toBe(true);
    expect(radios[2].checked).toBe(true);
    expect(radios[0].checked).toBe(false);
  });

  it('fallback huruf A–E bila tak ada match lain', () => {
    const { que, radios } = mc(['opsi-x', 'opsi-y', 'opsi-z']);
    expect(fill(que, 'C', 0)).toBe(true);
    expect(radios[2].checked).toBe(true);
  });

  it('match abai-spasi/normalisasi (√ untuk akar)', () => {
    const { que, radios } = mc(['akar 2', 'pangkat 2']);
    expect(fill(que, 'AKAR2', 0)).toBe(true);
    expect(radios[0].checked).toBe(true);
  });

  it('tidak ada yang cocok → false, tak ada yang tercentang', () => {
    const { que, radios } = mc(['A', 'B']);
    expect(fill(que, 'ZZZ', 0)).toBe(false);
    expect(radios.some(r => r.checked)).toBe(false);
  });

  it('tanpa opsi → false', () => {
    const d = document.createElement('div');
    d.className = 'que multichoice';
    d.innerHTML = '<div class="answer"><p>kosong</p></div>';
    expect(fill(d, 'A', 1)).toBe(false);
  });
});

describe('moodleFillMultichoice — multi select (checkbox)', () => {
  it('centang beberapa opsi sesuai array jawaban', () => {
    const { que, radios } = mc(['HTML', 'CSS', 'JS'], 'checkbox');
    expect(fill(que, ['HTML', 'JS'], 0)).toBe(true);
    expect(radios[0].checked).toBe(true);
    expect(radios[1].checked).toBe(false);
    expect(radios[2].checked).toBe(true);
  });
});
