// Provider registry — single place to define an LLM chat surface flab can drive.
//
// To add a provider: add an entry below with hostMatch + DOM selectors, add its
// host to manifest host_permissions + a content_script entry pointing at the
// injector, then test against the live site to confirm the selectors.
// Everything provider-specific lives here; the injector logic is generic.
//
// Verification: gemini, chatgpt, and claude are all `verified: true` — their
// selectors have been confirmed against the live sites and drive the injector
// correctly. Gemini remains the DEFAULT_PROVIDER. Maintenance note: all three
// sites are SPAs that periodically change their DOM; a `verified` provider can
// still break if a site ships a layout change, so re-check selectors after such
// updates rather than assuming they stay valid forever.

export const PROVIDERS = {
  gemini: {
    id: 'gemini',
    label: 'Gemini',
    url: 'https://gemini.google.com/app',
    hostMatch: 'gemini.google.com',
    verified: true,
    // Konfigurasi jalur API (opsional). Dipakai hanya bila user mengaktifkan Mode API
    // dan mengisi API key. Model bisa diganti di sini tanpa ubah kode.
    api: { kind: 'gemini', model: 'gemini-2.0-flash', keyUrl: 'https://aistudio.google.com/apikey' },
    // Editor input element (first match wins; ordered specific → generic).
    editorSelectors: [
      'rich-textarea .ql-editor[contenteditable="true"]',
      '.ql-editor[contenteditable="true"]',
      'div[aria-label*="message" i][contenteditable="true"]',
      'rich-textarea div[contenteditable="true"]',
      'div[contenteditable="true"]',
    ],
    // Send button (first enabled & visible match is clicked).
    // CATATAN: jangan pakai selektor super-generik (mis. button[jsname][data-ogsr-up])
    // — di halaman Google itu cocok ke banyak tombol (mic/toolbar) → salah klik.
    sendSelectors: [
      'button[aria-label="Send message"]',
      'button[aria-label="Kirim pesan"]',
      'button[aria-label*="Send" i]',
      'button[aria-label*="Kirim" i]',
      'button[data-mat-icon-name="send"]',
      'button.send-button',
      '[data-test-id="send-button"]',
    ],
    // Response bubbles — used to detect when a new reply has appeared.
    bubbleSelector: 'model-response, .model-response-text, [data-message-author-role="model"], message-content',
  },

  chatgpt: {
    id: 'chatgpt',
    label: 'ChatGPT',
    url: 'https://chatgpt.com/',
    hostMatch: 'chatgpt.com',
    verified: true,
    api: { kind: 'openai', model: 'gpt-4o-mini', keyUrl: 'https://platform.openai.com/api-keys' },
    editorSelectors: [
      'div#prompt-textarea[contenteditable="true"]',
      'div[contenteditable="true"].ProseMirror',
      'textarea#prompt-textarea',
      'div[contenteditable="true"]',
    ],
    sendSelectors: [
      'button[data-testid="send-button"]',
      'button[aria-label*="Send" i]',
      'button[aria-label*="Kirim" i]',
    ],
    bubbleSelector: '[data-message-author-role="assistant"], .markdown.prose',
  },

  claude: {
    id: 'claude',
    label: 'Claude',
    url: 'https://claude.ai/new',
    hostMatch: 'claude.ai',
    verified: true,
    api: { kind: 'anthropic', model: 'claude-haiku-4-5', keyUrl: 'https://console.anthropic.com/settings/keys' },
    editorSelectors: [
      'div[contenteditable="true"].ProseMirror',
      'div[contenteditable="true"][aria-label*="prompt" i]',
      'div[contenteditable="true"]',
    ],
    sendSelectors: [
      'button[aria-label*="Send" i]',
      'button[aria-label*="Kirim" i]',
      'button[data-testid="send-button"]',
    ],
    bubbleSelector: '[data-testid="message-content"], .font-claude-message, div[data-is-streaming]',
  },
};

export const DEFAULT_PROVIDER = 'gemini';

export function getProvider(id) {
  return PROVIDERS[id] || PROVIDERS[DEFAULT_PROVIDER];
}

// Cari provider berdasarkan hostname (dipakai injector untuk self-identify).
export function getProviderByHost(hostname) {
  return Object.values(PROVIDERS).find(p => hostname.includes(p.hostMatch)) || null;
}

