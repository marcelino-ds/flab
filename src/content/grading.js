// Penentuan benar/salah hasil CHECK Moodle. Fungsi murni baca DOM.
// Konservatif: bila tidak yakin, kembalikan null agar tidak salah klaim.

function textOf(el) {
  return (el?.innerText || el?.textContent || '').trim();
}

function hasGradeValue(text) {
  return /(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)/.test(text) ||
    /(\d+(?:\.\d+)?)\s*out\s*of\s*(\d+(?:\.\d+)?)/i.test(text);
}

export function officialGradeSignature(queEl) {
  if (!queEl) return '';
  const cl = queEl.classList;
  const classSig = ['correct', 'incorrect', 'partiallycorrect'].filter(c => cl.contains(c)).join('|');
  const stateText = textOf(queEl.querySelector('.info .state, .state')).toLowerCase();
  const officialState = stateText && !/not\s*yet\s*answered|belum\s*dijawab/.test(stateText) &&
    /correct|incorrect|benar|salah/.test(stateText) ? stateText : '';
  const gradeText = textOf(queEl.querySelector('.grade, .mark'));
  const officialGrade = hasGradeValue(gradeText) ? gradeText : '';
  return [classSig, officialState, officialGrade].filter(Boolean).join('::');
}

export function hasOfficialGradeSignal(queEl) {
  return !!officialGradeSignature(queEl);
}

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
  const stateText = textOf(stateEl).toLowerCase();
  if (stateText) {
    if (/not\s*yet\s*answered|belum\s*dijawab/.test(stateText)) return null;
    if (/partially\s*correct|sebagian\s*benar/.test(stateText)) return false;
    if (/incorrect|tidak\s+benar|\bsalah\b/.test(stateText)) return false;
    if (/\bcorrect\b|\bbenar\b/.test(stateText)) return true;
  }

  // Jangan jadikan tabel CodeRunner/precheck sebagai bukti resmi CHECK:
  // tabel itu bisa stale dari PRECHECK dan tidak selalu mengubah status Moodle.

  const feedback = queEl.querySelector('.outcome, .feedback');
  if (feedback) {
    const text = textOf(feedback).toLowerCase();
    if (/try\s*again|must\s*pass\s*all\s*tests|incorrect|tidak\s+benar|\bsalah\b/.test(text)) return false;
    if (/\bcorrect\b|\bbenar\b/.test(text)) return true;
  }

  const grade = queEl.querySelector('.grade, .mark');
  if (grade) {
    const text = textOf(grade);
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
