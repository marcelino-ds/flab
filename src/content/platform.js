// Deteksi Moodle & tipe soal. Fungsi murni baca DOM/location.

// Deteksi runtime: apakah halaman ini Moodle? (lintas-kampus, bukan per-hostname).
// Memakai penanda khas Moodle: body class, path /mod/quiz/, atau elemen .que/#responseform.
export function isMoodle() {
  const byBody = document.body && /(^|\s)(path-mod-quiz|format-|pagelayout-)/.test(document.body.className);
  const byDom = !!document.querySelector('.que, #responseform, #page-mod-quiz-attempt, [id^="question-"]');
  const byPath = location.pathname.includes('/mod/quiz/');
  return !!(byBody || byDom || byPath);
}

// Platform selalu 'moodle' bila terdeteksi Moodle, selain itu 'generic'.
export function detectPlatform() {
  return isMoodle() ? 'moodle' : 'generic';
}

export function detectMoodleQuiz() {
  const onQuizPage = !!document.querySelector('.que, #responseform, .quiz-attempt');
  const hasQuestions = document.querySelectorAll('.que').length > 0;
  const isAttemptPage = location.pathname.includes('/mod/quiz/attempt.php');
  const isSummaryPage = location.pathname.includes('/mod/quiz/summary.php');
  const isReviewPage = location.pathname.includes('/mod/quiz/review.php');

  return {
    isQuiz: onQuizPage || isAttemptPage,
    hasQuestions,
    isAttemptPage,
    isSummaryPage,
    isReviewPage,
    questionCount: document.querySelectorAll('.que').length,
  };
}

// Detect tipe soal Moodle dari class .que
export function detectQuestionType(queEl) {
  if (!queEl) return 'unknown';
  const cl = queEl.classList;
  if (cl.contains('multichoice')) return 'multichoice';
  if (cl.contains('shortanswer')) return 'shortanswer';
  if (cl.contains('essay')) return 'essay';
  if (cl.contains('coderunner')) return 'coderunner';
  if (cl.contains('numerical')) return 'numerical';
  if (cl.contains('match')) return 'match';
  if (cl.contains('truefalse')) return 'truefalse';
  // Fallback bila class tidak ada: urut dari paling spesifik ke paling umum.
  // .ace_editor paling unik (CodeRunner) — cek SEBELUM radio, karena soal koding
  // bisa saja punya elemen radio dan akan salah dideteksi jadi multichoice.
  if (queEl.querySelector('.ace_editor')) return 'coderunner';
  if (queEl.querySelector('input[type="radio"], input[type="checkbox"]')) return 'multichoice';
  if (queEl.querySelector('input[type="text"]')) return 'shortanswer';
  if (queEl.querySelector('textarea')) return 'essay';
  return 'unknown';
}
