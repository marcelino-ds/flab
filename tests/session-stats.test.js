import { describe, it, expect } from 'vitest';
import { emptyStats, normalizeStats, recordOutcome, summarize } from '../src/content/session-stats.js';

describe('session-stats', () => {
  it('emptyStats mengembalikan nol semua', () => {
    expect(emptyStats()).toEqual({ solved: 0, correct: 0, failed: 0 });
  });

  it('normalizeStats menangani undefined/null/parsial', () => {
    expect(normalizeStats(undefined)).toEqual({ solved: 0, correct: 0, failed: 0 });
    expect(normalizeStats(null)).toEqual({ solved: 0, correct: 0, failed: 0 });
    expect(normalizeStats({ solved: 3 })).toEqual({ solved: 3, correct: 0, failed: 0 });
  });

  it('normalizeStats membuang nilai negatif/NaN dan membulatkan ke bawah', () => {
    expect(normalizeStats({ solved: -2, correct: 'x', failed: 1.9 }))
      .toEqual({ solved: 0, correct: 0, failed: 1 });
  });

  it('recordOutcome correct → solved & correct naik', () => {
    expect(recordOutcome(emptyStats(), 'correct')).toEqual({ solved: 1, correct: 1, failed: 0 });
  });

  it('recordOutcome failed → solved & failed naik', () => {
    expect(recordOutcome(emptyStats(), 'failed')).toEqual({ solved: 1, correct: 0, failed: 1 });
  });

  it('recordOutcome unknown → hanya solved naik', () => {
    expect(recordOutcome(emptyStats(), 'unknown')).toEqual({ solved: 1, correct: 0, failed: 0 });
  });

  it('recordOutcome akumulatif lintas pemanggilan', () => {
    let s = emptyStats();
    s = recordOutcome(s, 'correct');
    s = recordOutcome(s, 'failed');
    s = recordOutcome(s, 'correct');
    expect(s).toEqual({ solved: 3, correct: 2, failed: 1 });
  });

  it('summarize menampilkan hanya bagian yang relevan', () => {
    expect(summarize({ solved: 0, correct: 0, failed: 0 })).toBe('0 soal diproses');
    expect(summarize({ solved: 3, correct: 3, failed: 0 })).toBe('3 soal diproses · 3 benar');
    expect(summarize({ solved: 5, correct: 3, failed: 2 })).toBe('5 soal diproses · 3 benar · 2 gagal');
  });
});
