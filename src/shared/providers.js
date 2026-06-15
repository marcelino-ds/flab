// Provider registry — single place to define an LLM chat surface flab can drive.
//
// To add a provider (e.g. ChatGPT, Claude): add an entry below with the site's
// DOM selectors, add its host to manifest host_permissions + a content_script
// entry pointing at the injector, then test against the live site to confirm the
// selectors. Everything provider-specific lives here; the injector logic is generic.

export const PROVIDERS = {
  gemini: {
    id: 'gemini',
    label: 'Gemini',
    url: 'https://gemini.google.com/app',
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
};

export const DEFAULT_PROVIDER = 'gemini';

export function getProvider(id) {
  return PROVIDERS[id] || PROVIDERS[DEFAULT_PROVIDER];
}
