// Penentuan benar/salah hasil CHECK Moodle. Fungsi murni baca DOM.
// Konservatif: bila tidak yakin, kembalikan null agar tidak salah klaim.

// Tentukan benar/salah setelah CHECK dari feedback Moodle.
// Return true (benar) / false (salah) / null (tidak diketahui).
export function checkIfCorrect(queEl) {
  if (!queEl) return null;

  const cl = queEl.classList;
  if (cl.contains('correct') && !cl.contains('incorrect')) return true;
  if (cl.contains('incorrect')) return false;
  if (cl.contains('partiallycorrect')) return false;

  // Badge status resmi Moodle (.info .state) paling andal — selalu ada walau
  // `.que` tak diberi kelas (kasus iLab Gunadarma). "Not yet answered" → belum
  // dinilai (null), bukan benar/salah.
  const stateEl = queEl.querySelector('.info .state, .state');
  const stateText = (stateEl?.innerText || stateEl?.textContent || '').toLowerCase();
  if (stateText) {
    if (/not\s*yet\s*answered|belum\s*dijawab/.test(stateText)) return null;
    if (/partially\s*correct|sebagian\s*benar/.test(stateText)) return false;
    if (/incorrect|\bsalah\b/.test(stateText)) return false;
    if (/\bcorrect\b|\bbenar\b/.test(stateText)) return true;
  }

  // Tabel hasil CodeRunner: deteksi kegagalan eksplisit (kompilasi gagal, run
  // error, "must pass all tests... try again", baris bertanda gagal/✗).
  const results = queEl.querySelector(
    '.coderunner-test-results, .CodeRunner-test-results, .que-coderunner-result, table.coderunner_test_results'
  );
  if (results) {
    const rt = (results.innerText || results.textContent || '').toLowerCase();
    if (/try\s*again|must\s*pass\s*all\s*tests|run\s*error|compil|kompilasi\s*gagal|pengujian\s*dibatalkan|\bfailed\b|\bwrong\b|✗|✘/.test(rt)) {
      return false;
    }
    if (/passed\s*all\s*tests|all\s*tests\s*passed|semua\s*(tes|test).*lulus/.test(rt)) {
      return true;
    }
  }

  const feedback = queEl.querySelector('.outcome, .feedback');
  if (feedback) {
    const text = feedback.innerText?.toLowerCase() || '';
    if (/try\s*again|must\s*pass\s*all\s*tests|incorrect|\bsalah\b/.test(text)) return false;
    if (/\bcorrect\b|\bbenar\b/.test(text)) return true;
  }

  const grade = queEl.querySelector('.grade, .mark');
  if (grade) {
    const text = grade.innerText || '';
    const match = text.match(/(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)/) ||
      text.match(/(\d+(?:\.\d+)?)\s*out\s*of\s*(\d+(?:\.\d+)?)/i);
    if (match) {
      const [, got, total] = match;
      if (parseFloat(total) === 0) return null;
      return parseFloat(got) >= parseFloat(total);
    }
  }

  return null;
}
