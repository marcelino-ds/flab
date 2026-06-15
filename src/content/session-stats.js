// Agregasi hasil sesi (murni, tanpa chrome.*). Storage glue ada di content/index.js.
// Bentuk objek: { solved, correct, failed } — semua integer >= 0.

export function emptyStats() {
  return { solved: 0, correct: 0, failed: 0 };
}

// Normalisasi objek apa pun (mis. dari storage yang mungkin undefined/parsial) ke bentuk valid.
export function normalizeStats(s) {
  const n = v => {
    const x = Number(v);
    return Number.isFinite(x) && x > 0 ? Math.floor(x) : 0;
  };
  return {
    solved: n(s?.solved),
    correct: n(s?.correct),
    failed: n(s?.failed),
  };
}

// Catat satu soal yang sudah di-CHECK. outcome: 'correct' | 'failed' | 'unknown'.
// 'solved' selalu naik (soal sudah diproses); correct/failed naik sesuai hasil.
export function recordOutcome(stats, outcome) {
  const s = normalizeStats(stats);
  s.solved += 1;
  if (outcome === 'correct') s.correct += 1;
  else if (outcome === 'failed') s.failed += 1;
  return s;
}

// Ringkasan human-readable untuk ditampilkan di UI akhir sesi.
export function summarize(stats) {
  const s = normalizeStats(stats);
  const parts = [`${s.solved} soal diproses`];
  if (s.correct > 0) parts.push(`${s.correct} benar`);
  if (s.failed > 0) parts.push(`${s.failed} gagal`);
  return parts.join(' · ');
}
