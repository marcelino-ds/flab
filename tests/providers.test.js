import { describe, it, expect } from 'vitest';
import { PROVIDERS, DEFAULT_PROVIDER, getProvider } from '../src/shared/providers.js';

describe('provider registry', () => {
  it('gemini terdaftar dengan config lengkap', () => {
    const p = PROVIDERS.gemini;
    expect(p.url).toContain('gemini.google.com');
    expect(Array.isArray(p.editorSelectors)).toBe(true);
    expect(p.editorSelectors.length).toBeGreaterThan(0);
    expect(Array.isArray(p.sendSelectors)).toBe(true);
    expect(typeof p.bubbleSelector).toBe('string');
  });

  it('getProvider mengembalikan provider yang diminta', () => {
    expect(getProvider('gemini').id).toBe('gemini');
  });

  it('getProvider fallback ke default untuk id tak dikenal', () => {
    expect(getProvider('chatgpt')).toBe(PROVIDERS[DEFAULT_PROVIDER]);
  });

  it('getProvider fallback untuk undefined/null', () => {
    expect(getProvider(undefined).id).toBe(DEFAULT_PROVIDER);
    expect(getProvider(null).id).toBe(DEFAULT_PROVIDER);
  });

  it('DEFAULT_PROVIDER menunjuk entry yang valid', () => {
    expect(PROVIDERS[DEFAULT_PROVIDER]).toBeDefined();
  });
});
