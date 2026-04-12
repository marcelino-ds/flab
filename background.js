// ── Background service worker ─────────────────────────────────────────────────
'use strict';

const GEMINI_URL = 'https://gemini.google.com/app';

// ── Re-inject content.js + kick off loop saat halaman LMS berpindah ───────────
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'complete') return;
  if (!tab.url || tab.url.startsWith('chrome://') || tab.url.startsWith('chrome-extension://')) return;

  chrome.storage.local.get(['isBatching', 'batchTabId', 'activeMode', 'batchPrompt'], d => {
    if (!d.isBatching || d.batchTabId !== tabId) return;

    chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] }, () => {
      if (chrome.runtime.lastError) {
        console.warn('[PrelabAI BG] executeScript error:', chrome.runtime.lastError.message);
        return;
      }
      chrome.tabs.sendMessage(tabId, {
        action: 'START',
        ai: 'gemini',
        mode: d.activeMode || 'solve',
        prompt: d.batchPrompt || '',
      });
    });
  });
});

// ── Message bus ───────────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {

  // Injector asking its own tab ID
  if (msg.action === '__GET_TAB_ID__') {
    sendResponse({ tabId: sender.tab?.id ?? null });
    return true;
  }

  // Screenshot capture relay
  if (msg.action === 'CAPTURE') {
    const windowId = sender.tab?.windowId;
    if (!windowId) { sendResponse({ dataUrl: null }); return true; }
    chrome.tabs.captureVisibleTab(windowId, { format: 'jpeg', quality: 70 }, dataUrl => {
      if (chrome.runtime.lastError) {
        console.warn('[PrelabAI BG] captureVisibleTab error:', chrome.runtime.lastError.message);
        sendResponse({ dataUrl: null });
      } else {
        sendResponse({ dataUrl });
      }
    });
    return true; // keep channel open for async response
  }

  // Gemini → LMS answer bridge
  if (msg.action === 'SOLVER_JSON_RESULT') {
    chrome.storage.local.get(['batchTabId'], d => {
      if (d.batchTabId) {
        chrome.tabs.sendMessage(d.batchTabId, { action: 'FILL_ANSWER', data: msg.data }, () => {
          if (chrome.runtime.lastError) {
            console.warn('[PrelabAI BG] sendMessage to LMS tab error:', chrome.runtime.lastError.message);
          }
        });
      }
      // Close Gemini shadow tab after extracting answer
      if (sender.tab?.id) {
        setTimeout(() => chrome.tabs.remove(sender.tab.id), 500);
      }
    });
    return true;
  }

  // Sinyal timeout dari Gemini → relay retry ke LMS tab
  if (msg.action === 'SOLVER_TIMEOUT') {
    chrome.storage.local.get(['batchTabId'], d => {
      if (d.batchTabId) {
        chrome.tabs.sendMessage(d.batchTabId, { action: 'RETRY_SOLVE' }, () => {
          if (chrome.runtime.lastError) {
            console.warn('[PrelabAI BG] sendMessage RETRY_SOLVE error:', chrome.runtime.lastError.message);
          }
        });
      }
      // Tutup tab Gemini yang gagal / hang
      if (sender.tab?.id) {
        setTimeout(() => chrome.tabs.remove(sender.tab.id), 700);
      }
    });
    return true;
  }

  // Open Gemini tab with payload
  if (msg.action === 'OPEN_AI') {
    chrome.storage.local.set({ prelabPayload: msg.payload }, () => {
      chrome.tabs.create({ url: GEMINI_URL }, newTab => {
        chrome.storage.local.set({ pendingTabId: newTab.id });
      });
    });
    return true;
  }
});
