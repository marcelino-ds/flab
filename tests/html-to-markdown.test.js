import { describe, it, expect } from 'vitest';
import { htmlToMarkdown } from '../src/content/html-to-markdown.js';

// happy-dom menyediakan document global; bangun elemen dari HTML string.
function el(html) {
  const d = document.createElement('div');
  d.innerHTML = html;
  return d;
}

describe('htmlToMarkdown', () => {
  it('kembalikan string kosong untuk null', () => {
    expect(htmlToMarkdown(null)).toBe('');
  });

  it('paragraf jadi teks polos', () => {
    expect(htmlToMarkdown(el('<p>Halo dunia</p>'))).toContain('Halo dunia');
  });

  it('bold & italic', () => {
    const md = htmlToMarkdown(el('<p>ini <strong>tebal</strong> dan <em>miring</em></p>'));
    expect(md).toContain('**tebal**');
    expect(md).toContain('*miring*');
  });

  it('blok <pre> jadi fenced code block', () => {
    const md = htmlToMarkdown(el('<pre>line1\nline2</pre>'));
    expect(md).toContain('```');
    expect(md).toContain('line1\nline2');
  });

  it('inline <code>', () => {
    const md = htmlToMarkdown(el('<p>pakai <code>printf</code> ya</p>'));
    expect(md).toContain('`printf`');
  });

  it('tabel jadi tabel markdown dengan header & separator', () => {
    const md = htmlToMarkdown(el(
      '<table><tr><th>Input</th><th>Output</th></tr><tr><td>2</td><td>4</td></tr></table>'
    ));
    expect(md).toContain('| Input | Output |');
    expect(md).toContain('| --- | --- |');
    expect(md).toContain('| 2 | 4 |');
  });

  it('unordered list', () => {
    const md = htmlToMarkdown(el('<ul><li>satu</li><li>dua</li></ul>'));
    expect(md).toContain('- satu');
    expect(md).toContain('- dua');
  });

  it('ordered list bernomor', () => {
    const md = htmlToMarkdown(el('<ol><li>pertama</li><li>kedua</li></ol>'));
    expect(md).toContain('1. pertama');
    expect(md).toContain('2. kedua');
  });

  it('MathJax v2 script[type=math/tex] jadi LaTeX inline', () => {
    const md = htmlToMarkdown(el('<p>rumus <script type="math/tex">x^2</script> selesai</p>'));
    expect(md).toContain('$x^2$');
  });

  it('escape pipe di dalam sel tabel', () => {
    const md = htmlToMarkdown(el('<table><tr><th>a</th></tr><tr><td>x|y</td></tr></table>'));
    expect(md).toContain('x\\|y');
  });

  it('img dengan alt', () => {
    const md = htmlToMarkdown(el('<p><img src="x.png" alt="diagram"></p>'));
    expect(md).toContain('[gambar: diagram]');
  });
});
