// Ekstraksi blok JSON dari teks respons LLM.

// Cari index '}' yang menutup '{' di posisi `start`, dengan balanced depth dan
// sadar string JSON + escape. Kembalikan -1 bila tidak ada penutup seimbang.
export function matchClosingBrace(text, start) {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escaped) { escaped = false; continue; }
    if (ch === '\\') { if (inString) escaped = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) return i; }
  }
  return -1;
}
