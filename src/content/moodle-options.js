// Pembacaan opsi multichoice/truefalse — satu sumber kebenaran untuk extract & fill.

// Find label text for a radio/checkbox (robust for Moodle DOM)
export function getRadioLabelText(radio, queEl) {
  // Bersihkan noise Moodle yang meracuni teks opsi (teks a11y "Correct/Incorrect",
  // nomor opsi "a.", ikon feedback, duplikasi MathJax) lalu ubah math → LaTeX.
  const cleanText = el => {
    const clone = el.cloneNode(true);
    clone.querySelectorAll(
      'input, .accesshide, .sr-only, .answernumber, .icon, .feedback, .specificfeedback, [aria-hidden="true"]'
    ).forEach(n => n.remove());
    clone.querySelectorAll('script[type^="math/tex"]').forEach(s => {
      const tex = (s.textContent || '').trim();
      if (tex) s.replaceWith(document.createTextNode(` $${tex}$ `));
    });
    clone.querySelectorAll('mjx-container, math').forEach(m => {
      const anno = m.querySelector('annotation[encoding="application/x-tex"]');
      const tex = (anno?.textContent || m.getAttribute('aria-label') || m.textContent || '').trim();
      if (tex) m.replaceWith(document.createTextNode(` $${tex}$ `));
    });
    return (clone.innerText || clone.textContent || '').replace(/\s+/g, ' ').trim();
  };

  // Strategy 1: Cari parent row (wrapper) dari jawaban ini
  const row = radio.closest('.r0, .r1, .r2, .r3, .r4, .d-flex, .align-items-center, div[class*="answer"] > div');
  if (row) {
    const txt = cleanText(row);
    if (txt) return txt;
  }

  // Strategy 2: label[for="radio.id"]
  if (radio.id) {
    const label = queEl.querySelector(`label[for="${CSS.escape(radio.id)}"]`);
    if (label) {
      const txt = cleanText(label);
      if (txt) return txt;
    }
  }

  // Strategy 3: Parent atau Sibling label/div
  const parentLabel = radio.closest('label');
  if (parentLabel) {
    const txt = cleanText(parentLabel);
    if (txt) return txt;
  }

  let sibling = radio.nextElementSibling;
  while (sibling) {
    if (sibling.tagName === 'LABEL' || sibling.tagName === 'DIV' || sibling.tagName === 'SPAN') {
      const txt = cleanText(sibling);
      if (txt) return txt;
    }
    sibling = sibling.nextElementSibling;
  }

  // Default fallback text kalau nge-blank
  return radio.value || '';
}

// Single source of truth untuk opsi multichoice/truefalse.
// Teks opsi diturunkan dari elemen INPUT yang SAMA yang nanti diklik saat fill.
// Ini menjamin urutan enumerasi (yang dikirim ke AI) == urutan saat klik, sehingga
// index_pilihan dari AI bisa dipercaya sebagai sinyal utama (bukan tebakan).
export function getMoodleOptions(queEl) {
  if (!queEl) return [];
  const inputs = [...queEl.querySelectorAll('input[type="radio"], input[type="checkbox"]')];
  return inputs.map((input, index) => ({
    input,
    index,                                  // 0-based; index_pilihan AI = index + 1
    text: getRadioLabelText(input, queEl),
  }));
}
