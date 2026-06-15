// Penentuan benar/salah hasil PRECHECK & CHECK Moodle. Fungsi murni baca DOM.
// Konservatif: bila tidak yakin, kembalikan false/null agar memicu retry, bukan
// mengklaim lulus secara keliru.

// Parse hasil PRECHECK CodeRunner — true bila semua test lulus.
export function parsePrecheckResult(text, el) {
  const lower = text.toLowerCase();

  // Indikator lulus eksplisit. Cek 'passed' sebagai whole-word agar tidak cocok
  // dengan "Test 1 passed, Test 2 failed".
  const passedWholeWord = /\bpassed\b/i.test(text);
  const notPassedPhrase = /\bnot passed\b/i.test(text);
  if (lower.includes('passed all') || lower.includes('all correct') ||
    lower.includes('semua benar') || lower.includes('mark: 1') ||
    (passedWholeWord && !notPassedPhrase)) {
    if (!lower.includes('fail') && !lower.includes('error') && !lower.includes('wrong')) {
      return true;
    }
  }

  // Tabel CodeRunner: prioritaskan tanda lulus (class correct / centang) dulu.
  const rows = el.querySelectorAll('tr');
  if (rows.length > 1) {
    // Strategy 1: class correct/pass atau centang hijau di tiap baris.
    const allPassed = [...rows].slice(1).every(row => {
      if (row.classList.contains('correct') || row.classList.contains('pass')) return true;
      const cells = row.querySelectorAll('td');
      return [...cells].some(c =>
        c.classList.contains('correct') ||
        c.classList.contains('pass') ||
        c.innerText?.includes('✓') ||
        c.innerText?.includes('Pass')
      );
    });
    if (allPassed) return true;

    // Strategy 2: bandingkan kolom Expected vs Got (toleran whitespace ganda).
    let expectedIdx = -1;
    let gotIdx = -1;
    const headers = rows[0].querySelectorAll('th');
    headers.forEach((th, i) => {
      const hd = (th.innerText || th.textContent || '').toLowerCase().trim();
      if (hd === 'expected') expectedIdx = i;
      if (hd === 'got') gotIdx = i;
    });

    if (expectedIdx !== -1 && gotIdx !== -1) {
      const allMatched = [...rows].slice(1).every(row => {
        const cells = row.querySelectorAll('td');
        if (!cells[expectedIdx] || !cells[gotIdx]) return false; // baris tak lengkap → jangan klaim lulus
        const expected = (cells[expectedIdx].innerText || cells[expectedIdx].textContent || '').trim().replace(/\s+/g, ' ');
        const got = (cells[gotIdx].innerText || cells[gotIdx].textContent || '').trim().replace(/\s+/g, ' ');
        return expected !== '' && expected === got;
      });
      if (allMatched) return true;
      return false;
    }
  }

  // Indikator gagal eksplisit.
  if (lower.includes('fail') || lower.includes('error') || lower.includes('wrong') ||
    lower.includes('salah') || lower.includes('expected') || lower.includes('got')) {
    return false;
  }

  // Tidak diketahui — anggap gagal agar memicu retry.
  return false;
}

// Tentukan benar/salah setelah CHECK dari feedback Moodle.
// Return true (benar) / false (salah) / null (tidak diketahui).
export function checkIfCorrect(queEl) {
  if (!queEl) return null;

  const cl = queEl.classList;
  if (cl.contains('correct')) return true;
  if (cl.contains('incorrect')) return false;
  if (cl.contains('partiallycorrect')) return false;

  const feedback = queEl.querySelector('.outcome, .feedback, .state');
  if (feedback) {
    const text = feedback.innerText?.toLowerCase() || '';
    if (text.includes('correct') || text.includes('benar')) return true;
    if (text.includes('incorrect') || text.includes('salah')) return false;
  }

  const grade = queEl.querySelector('.grade, .mark');
  if (grade) {
    const text = grade.innerText || '';
    const match = text.match(/(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)/);
    if (match) {
      const [, got, total] = match;
      return parseFloat(got) >= parseFloat(total);
    }
  }

  return null;
}
