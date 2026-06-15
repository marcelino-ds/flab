import { describe, it, expect } from 'vitest';
import { escapeHtml, sleep } from '../src/shared/util.js';

describe('escapeHtml', () => {
  it('escape karakter HTML berbahaya', () => {
    expect(escapeHtml('<script>')).toBe('&lt;script&gt;');
    expect(escapeHtml('a & b')).toBe('a &amp; b');
    expect(escapeHtml('"q"')).toBe('&quot;q&quot;');
    expect(escapeHtml("'s'")).toBe('&#39;s&#39;');
  });

  it('payload XSS umum dinetralkan', () => {
    const out = escapeHtml('<img src=x onerror=alert(1)>');
    expect(out).not.toContain('<img');
    expect(out).toContain('&lt;img');
  });

  it('null/undefined → string kosong', () => {
    expect(escapeHtml(null)).toBe('');
    expect(escapeHtml(undefined)).toBe('');
  });

  it('teks biasa tidak berubah', () => {
    expect(escapeHtml('Halo dunia 123')).toBe('Halo dunia 123');
  });

  it('coerce non-string', () => {
    expect(escapeHtml(42)).toBe('42');
  });
});

describe('sleep', () => {
  it('resolve setelah delay', async () => {
    const t0 = Date.now();
    await sleep(20);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(15);
  });
});
