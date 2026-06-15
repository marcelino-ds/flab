import { describe, it, expect, afterEach } from 'vitest';
import {
  findButton, findUnansweredQuestion, setNativeValue,
} from '../src/content/dom-utils.js';

afterEach(() => { document.body.innerHTML = ''; });

function que(innerHTML, className = 'que') {
  const d = document.createElement('div');
  d.className = className;
  d.innerHTML = innerHTML;
  document.body.appendChild(d);
  return d;
}

describe('findButton — keyword match + precheck/check disambiguation', () => {
  it('temukan tombol Check', () => {
    const q = que('<button>Check</button>');
    expect(findButton(q, ['check'])?.innerText).toBe('Check');
  });

  it('JANGAN klik Precheck saat mencari "check"', () => {
    const q = que('<button>Precheck</button>');
    expect(findButton(q, ['check'], ['precheck'])).toBeNull();
  });

  it('pilih Check, bukan Precheck, saat keduanya ada', () => {
    const q = que('<button>Precheck</button><button>Check</button>');
    expect(findButton(q, ['check'], ['precheck'])?.innerText).toBe('Check');
  });

  it('temukan Precheck saat memang mencari precheck', () => {
    const q = que('<button>Precheck</button>');
    expect(findButton(q, ['precheck'])?.innerText).toBe('Precheck');
  });

  it('cocok via value pada input submit', () => {
    const q = que('<input type="submit" value="Periksa">');
    expect(findButton(q, ['periksa'])?.value).toBe('Periksa');
  });

  it('null bila tidak ada yang cocok', () => {
    const q = que('<button>Batal</button>');
    expect(findButton(q, ['check'])).toBeNull();
  });
});

describe('findUnansweredQuestion', () => {
  it('pilih soal yang belum complete', () => {
    const a = que('<input type="radio" checked>', 'que complete');
    const b = que('<input type="radio">', 'que');
    expect(findUnansweredQuestion([a, b])).toBe(b);
  });

  it('soal dengan text input kosong dianggap belum dijawab', () => {
    const q = que('<input type="text" value="">', 'que complete');
    expect(findUnansweredQuestion([q])).toBe(q);
  });

  it('soal complete dengan radio tercentang dilewati', () => {
    const q = que('<input type="radio" checked>', 'que complete');
    expect(findUnansweredQuestion([q])).toBeNull();
  });
});

describe('setNativeValue', () => {
  it('set value input + dispatch input/change', () => {
    const input = document.createElement('input');
    let inputFired = false, changeFired = false;
    input.addEventListener('input', () => { inputFired = true; });
    input.addEventListener('change', () => { changeFired = true; });
    setNativeValue(input, 'halo');
    expect(input.value).toBe('halo');
    expect(inputFired).toBe(true);
    expect(changeFired).toBe(true);
  });

  it('set value textarea (isTextarea=true)', () => {
    const ta = document.createElement('textarea');
    setNativeValue(ta, 'baris', true);
    expect(ta.value).toBe('baris');
  });
});

// Catatan: findNextButton tidak diunit-test di sini — ia memfilter tombol via
// offsetWidth/offsetHeight (visibility), dan happy-dom tidak melakukan layout
// sehingga dimensi selalu 0. Verifikasi visibilitas dilakukan di browser nyata.
