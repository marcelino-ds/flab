import { describe, it, expect, vi, afterEach } from 'vitest';
import { makeId } from '../src/shared/id.js';

afterEach(() => { vi.restoreAllMocks(); });

describe('makeId', () => {
  it('membuat id dengan prefix, timestamp base36, dan suffix random', () => {
    vi.spyOn(Date, 'now').mockReturnValue(123456789);
    vi.spyOn(Math, 'random').mockReturnValue(0.123456789);
    expect(makeId('req')).toMatch(/^req_[a-z0-9]+_[a-z0-9]+$/);
  });
});
