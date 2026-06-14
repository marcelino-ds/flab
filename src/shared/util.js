// Util bersama lintas surface. Hanya fungsi yang BENAR-BENAR identik di semua tempat.
// Catatan: waitFor TIDAK di sini — versi content sadar __flabAborted, versi injector
// tidak; menyatukannya akan mengubah perilaku.

// Escape karakter HTML untuk cegah XSS saat menyisipkan data ke innerHTML.
export function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}
