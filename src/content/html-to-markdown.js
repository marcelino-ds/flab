// HTML → Markdown (structure-preserving extraction).
// Bekerja pada clone agar tidak menyentuh DOM halaman. Mengubah math (MathJax v2/v3,
// MathML) jadi LaTeX, tabel jadi tabel markdown, <pre> jadi fenced code block.

export function htmlToMarkdown(rootEl) {
  if (!rootEl) return '';
  const clone = rootEl.cloneNode(true);

  // Buang noise (kecuali script math/tex yang justru sumber LaTeX-nya)
  clone.querySelectorAll('style, noscript').forEach(n => n.remove());
  clone.querySelectorAll('script:not([type^="math/tex"])').forEach(n => n.remove());

  // MathJax v2: <script type="math/tex"> berisi sumber LaTeX
  clone.querySelectorAll('script[type^="math/tex"]').forEach(s => {
    const tex = (s.textContent || '').trim();
    const display = (s.getAttribute('type') || '').includes('mode=display');
    if (tex) s.replaceWith(document.createTextNode(display ? `\n$$${tex}$$\n` : ` $${tex}$ `));
  });

  // MathJax v3 + MathML: ambil annotation LaTeX kalau ada, fallback ke aria-label
  clone.querySelectorAll('mjx-container, math').forEach(m => {
    const texAnno = m.querySelector('annotation[encoding="application/x-tex"]');
    let tex = texAnno?.textContent?.trim();
    if (!tex) tex = (m.getAttribute('aria-label') || m.textContent || '').trim();
    const display = m.getAttribute('display') === 'true' ||
                    (m.tagName.toLowerCase() === 'mjx-container' && m.hasAttribute('display'));
    if (tex) m.replaceWith(document.createTextNode(display ? `\n$$${tex}$$\n` : ` $${tex}$ `));
  });

  return nodeToMarkdown(clone).replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

function nodeToMarkdown(node) {
  let out = '';
  for (const child of node.childNodes) {
    if (child.nodeType === Node.TEXT_NODE) {
      out += child.textContent.replace(/\s+/g, ' ');
      continue;
    }
    if (child.nodeType !== Node.ELEMENT_NODE) continue;

    const tag = child.tagName.toLowerCase();
    switch (tag) {
      case 'br': out += '\n'; break;
      case 'hr': out += '\n---\n'; break;
      case 'p': case 'div': case 'section': case 'article':
        out += '\n' + nodeToMarkdown(child) + '\n'; break;
      case 'h1': case 'h2': case 'h3': case 'h4': case 'h5': case 'h6':
        out += '\n' + '#'.repeat(Number(tag[1])) + ' ' + nodeToMarkdown(child).trim() + '\n'; break;
      case 'strong': case 'b': out += '**' + nodeToMarkdown(child).trim() + '**'; break;
      case 'em': case 'i': out += '*' + nodeToMarkdown(child).trim() + '*'; break;
      case 'code':
        // <code> di dalam <pre> ditangani oleh case 'pre'; ini hanya inline code
        if (child.closest('pre')) { out += child.textContent || ''; }
        else out += '`' + (child.textContent || '') + '`';
        break;
      case 'pre': {
        const code = (child.innerText ?? child.textContent ?? '').replace(/\n+$/, '');
        out += '\n```\n' + code + '\n```\n'; break;
      }
      case 'ul': case 'ol': out += '\n' + listToMarkdown(child, tag === 'ol') + '\n'; break;
      case 'table': out += '\n' + tableToMarkdown(child) + '\n'; break;
      case 'img': {
        const alt = child.getAttribute('alt') || '';
        out += alt ? `[gambar: ${alt}]` : '[gambar]'; break;
      }
      default: out += nodeToMarkdown(child);
    }
  }
  return out;
}

function listToMarkdown(listEl, ordered) {
  const items = [...listEl.children].filter(c => c.tagName === 'LI');
  return items.map((li, i) => {
    const marker = ordered ? `${i + 1}.` : '-';
    const text = nodeToMarkdown(li).trim().replace(/\n+/g, ' ');
    return `${marker} ${text}`;
  }).join('\n');
}

function tableToMarkdown(tableEl) {
  const rows = [...tableEl.querySelectorAll('tr')];
  if (rows.length === 0) return '';

  const grid = rows.map(r =>
    [...r.querySelectorAll('th, td')].map(c =>
      (c.innerText || c.textContent || '').trim().replace(/\n+/g, ' ').replace(/\|/g, '\\|')
    )
  );

  const cols = Math.max(...grid.map(r => r.length));
  const pad = r => { const a = r.slice(); while (a.length < cols) a.push(''); return a; };

  const header = pad(grid[0]);
  let md = '| ' + header.join(' | ') + ' |\n';
  md += '| ' + header.map(() => '---').join(' | ') + ' |\n';
  for (let i = 1; i < grid.length; i++) md += '| ' + pad(grid[i]).join(' | ') + ' |\n';
  return md;
}
