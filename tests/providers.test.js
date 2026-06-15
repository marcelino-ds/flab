import { describe, it, expect } from 'vitest';
import { PROVIDERS, DEFAULT_PROVIDER, getProvider, getProviderByHost } from '../src/shared/providers.js';

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
    expect(getProvider('nonexistent-llm')).toBe(PROVIDERS[DEFAULT_PROVIDER]);
  });

  it('chatgpt & claude terdaftar sebagai provider', () => {
    expect(PROVIDERS.chatgpt?.id).toBe('chatgpt');
    expect(PROVIDERS.claude?.id).toBe('claude');
  });

  it('getProvider fallback untuk undefined/null', () => {
    expect(getProvider(undefined).id).toBe(DEFAULT_PROVIDER);
    expect(getProvider(null).id).toBe(DEFAULT_PROVIDER);
  });

  it('DEFAULT_PROVIDER menunjuk entry yang valid', () => {
    expect(PROVIDERS[DEFAULT_PROVIDER]).toBeDefined();
  });
});

describe('getProviderByHost', () => {
  it('cocokkan gemini via host', () => {
    expect(getProviderByHost('gemini.google.com')?.id).toBe('gemini');
  });
  it('cocokkan chatgpt via host', () => {
    expect(getProviderByHost('chatgpt.com')?.id).toBe('chatgpt');
  });
  it('cocokkan claude via host', () => {
    expect(getProviderByHost('claude.ai')?.id).toBe('claude');
  });
  it('host non-provider → null', () => {
    expect(getProviderByHost('example.com')).toBeNull();
  });
});
