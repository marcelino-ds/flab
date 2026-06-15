import { describe, it, expect } from 'vitest';
import { getRadioLabelText, getMoodleOptions } from '../src/content/moodle-options.js';

function que(innerHTML) {
  const d = document.createElement('div');
  d.className = 'que multichoice';
  d.innerHTML = innerHTML;
  return d;
}

describe('getRadioLabelText — bersihkan noise Moodle', () => {
  it('ambil teks opsi dari row pembungkus', () => {
    const q = que('<div class="answer"><div class="r0"><input type="radio" id="o1"><label for="o1">Jakarta</label></div></div>');
    const radio = q.querySelector('input');
    expect(getRadioLabelText(radio, q)).toBe('Jakarta');
  });

  it('buang teks a11y .accesshide (mis. "Correct" setelah CHECK)', () => {
    const q = que('<div class="answer"><div class="r0"><input type="radio" id="o1"><label for="o1">Bandung<span class="accesshide">Correct</span></label></div></div>');
    const radio = q.querySelector('input');
    const txt = getRadioLabelText(radio, q);
    expect(txt).toContain('Bandung');
    expect(txt).not.toContain('Correct');
  });

  it('buang .answernumber (prefix "a.")', () => {
    const q = que('<div class="answer"><div class="r0"><input type="radio" id="o1"><label for="o1"><span class="answernumber">a.</span>Surabaya</label></div></div>');
    const radio = q.querySelector('input');
    const txt = getRadioLabelText(radio, q);
    expect(txt).toContain('Surabaya');
    expect(txt).not.toContain('a.');
  });

  it('MathJax v2 script[type=math/tex] → LaTeX', () => {
    const q = que('<div class="answer"><div class="r0"><input type="radio" id="o1"><label for="o1"><script type="math/tex">x^2</script></label></div></div>');
    const radio = q.querySelector('input');
    expect(getRadioLabelText(radio, q)).toContain('$x^2$');
  });

  it('fallback ke value bila label kosong', () => {
    const q = que('<div class="answer"><input type="radio" value="opt-A"></div>');
    const radio = q.querySelector('input');
    expect(getRadioLabelText(radio, q)).toBe('opt-A');
  });
});

describe('getMoodleOptions — alignment index↔input', () => {
  it('urutan opsi mengikuti urutan input di DOM', () => {
    const q = que(`
      <div class="answer">
        <div class="r0"><input type="radio" id="a"><label for="a">Merah</label></div>
        <div class="r1"><input type="radio" id="b"><label for="b">Hijau</label></div>
        <div class="r2"><input type="radio" id="c"><label for="c">Biru</label></div>
      </div>`);
    const opts = getMoodleOptions(q);
    expect(opts.map(o => o.text)).toEqual(['Merah', 'Hijau', 'Biru']);
    expect(opts.map(o => o.index)).toEqual([0, 1, 2]);
  });

  it('index 0-based; index_pilihan AI = index + 1', () => {
    const q = que(`
      <div class="answer">
        <div class="r0"><input type="radio" id="a"><label for="a">Satu</label></div>
        <div class="r1"><input type="radio" id="b"><label for="b">Dua</label></div>
      </div>`);
    const opts = getMoodleOptions(q);
    // opsi ke-2 (yang dilihat AI sebagai "2") harus berada di opts[1]
    expect(opts[2 - 1].text).toBe('Dua');
  });

  it('setiap opsi merujuk elemen input yang sama untuk diklik', () => {
    const q = que('<div class="answer"><div class="r0"><input type="radio" id="a"><label for="a">X</label></div></div>');
    const opts = getMoodleOptions(q);
    expect(opts[0].input).toBe(q.querySelector('input'));
  });

  it('checkbox (multi-select) juga terbaca', () => {
    const q = que(`
      <div class="answer">
        <div class="r0"><input type="checkbox" id="a"><label for="a">P</label></div>
        <div class="r1"><input type="checkbox" id="b"><label for="b">Q</label></div>
      </div>`);
    const opts = getMoodleOptions(q);
    expect(opts).toHaveLength(2);
    expect(opts.map(o => o.text)).toEqual(['P', 'Q']);
  });

  it('queEl kosong → array kosong', () => {
    expect(getMoodleOptions(null)).toEqual([]);
    expect(getMoodleOptions(que('<p>tidak ada opsi</p>'))).toEqual([]);
  });
});
