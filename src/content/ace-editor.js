// Integrasi Ace editor (Moodle CodeRunner). Baca/sinkronkan kode editor.

export function getAceEditor(queEl) {
  const aceEl = queEl?.querySelector('.ace_editor');
  if (!aceEl) return null;
  // Moodle/CodeRunner stores the editor instance on the element
  return aceEl.env?.editor || aceEl.__ace_editor || null;
}

export function getExistingCode(queEl) {
  // Method 1: Ace editor API
  const editor = getAceEditor(queEl);
  if (editor) {
    try { return editor.getValue(); } catch { /**/ }
  }
  // Method 2: Read from Ace gutter (visible lines)
  const aceLines = queEl?.querySelectorAll('.ace_line');
  if (aceLines && aceLines.length > 0) {
    return [...aceLines].map(l => l.textContent).join('\n');
  }
  // Method 3: Hidden textarea (Moodle CodeRunner syncs to this)
  const textarea = queEl?.querySelector('textarea[name*="answer"]') || queEl?.querySelector('textarea');
  if (textarea) return textarea.value || '';
  return '';
}

// Sync Ace editor content to the hidden Moodle textarea
export function syncAceToTextarea(queEl) {
  const editor = getAceEditor(queEl);
  if (!editor) return;
  const textarea = queEl?.querySelector('textarea[name*="answer"]') || queEl?.querySelector('textarea');
  if (textarea) {
    const code = editor.getValue();
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
    if (setter) setter.call(textarea, code);
    else textarea.value = code;
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    textarea.dispatchEvent(new Event('change', { bubbles: true }));
  }
}
