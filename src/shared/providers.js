// Provider registry — single place to define an LLM chat surface flab can drive.
//
// To add a provider: add an entry below with hostMatch + DOM selectors, add its
// host to manifest host_permissions + a content_script entry pointing at the
// injector, then test against the live site to confirm the selectors.
// Everything provider-specific lives here; the injector logic is generic.
//
// NOTE: selectors for chatgpt/claude are best-effort and may need updating when
// those sites change their DOM. Gemini is the verified, primary provider.

export const PROVIDERS = {
  gemini: {
    id: 'gemini',
    label: 'Gemini',
    url: 'https://gemini.google.com/app',
    hostMatch: 'gemini.google.com',
    verified: true,
    // Editor input element (first match wins; ordered specific → generic).
    editorSelectors: [
      'rich-textarea .ql-editor[contenteditable="true"]',
      '.ql-editor[contenteditable="true"]',
      'div[aria-label*="message" i][contenteditable="true"]',
      'rich-textarea div[contenteditable="true"]',
      'div[contenteditable="true"]',
    ],
    // Send button (first enabled & visible match is clicked).
    sendSelectors: [
      'button[aria-label="Send message"]',
      'button[aria-label="Kirim pesan"]',
      'button[aria-label*="Send" i]',
      'button[aria-label*="Kirim" i]',
      'button[data-mat-icon-name="send"]',
      'button[jsname][data-ogsr-up]',
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

