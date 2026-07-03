import { describe, it, expect, afterEach } from 'vitest';
import { getExistingCode } from '../src/content/ace-editor.js';

afterEach(() => { document.body.innerHTML = ''; });

function que(innerHTML) {
  const q = document.createElement('div');
  q.className = 'que coderunner';
  q.innerHTML = innerHTML;
  document.body.appendChild(q);
  return q;
}

describe('getExistingCode', () => {
  it('memakai Ace API bila tersedia', () => {
    const q = que('<div class="ace_editor"></div><textarea name="answer">textarea</textarea>');
    q.querySelector('.ace_editor').env = { editor: { getValue: () => 'ace-api' } };
    expect(getExistingCode(q)).toBe('ace-api');
  });

  it('memilih hidden textarea sebelum .ace_line visible', () => {
    const q = que('<div class="ace_editor"><div class="ace_line">visible only</div></div><textarea name="answer">full hidden code</textarea>');
    expect(getExistingCode(q)).toBe('full hidden code');
  });

  it('fallback ke .ace_line jika tidak ada textarea/API', () => {
    const q = que('<div class="ace_editor"><div class="ace_line">line 1</div><div class="ace_line">line 2</div></div>');
    expect(getExistingCode(q)).toBe('line 1\nline 2');
  });
});
