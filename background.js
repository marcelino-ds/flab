// ── Background service worker ─────────────────────────────────────────────────
'use strict';

// Keys yang perlu dibersihkan saat sesi lama stale
const STALE_KEYS = [
  'isBatching', 'batchTabId', 'pendingTabId', 'prelabPayload',
  'solveRetryCount', 'precheckError', 'precheckCode', 'precheckRetryCount',
];

function clearStaleSession(reason) {
  chrome.storage.local.remove(STALE_KEYS, () => {
    console.log(`[Prelab BG] Stale session cleared (${reason}).`);
  });
}

// Cleanup saat extension/browser restart
chrome.runtime.onStartup.addListener(() => clearStaleSession('startup'));

// Cleanup saat extension di-install/update
chrome.runtime.onInstalled.addListener(() => clearStaleSession('install/update'));

const GEMINI_URL = 'https://gemini.google.com/app';

// Allowed LMS hosts
const LMS_HOSTS = [
  'praktikum.gunadarma.ac.id',  // iLab
  'v-class.gunadarma.ac.id',    // vClass
];

function isLmsUrl(url) {
  try { return LMS_HOSTS.some(h => new URL(url).hostname === h); }
  catch { return false; }
}

// ── Re-inject content.js + kick off loop saat halaman LMS berpindah ───────────
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'complete') return;
  if (!tab.url || !isLmsUrl(tab.url)) return;

  chrome.storage.local.get(['isBatching', 'batchTabId', 'activeMode', 'batchPrompt'], d => {
    if (!d.isBatching || d.batchTabId !== tabId) return;

    chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] }, () => {
      if (chrome.runtime.lastError) {
        console.warn('[Prelab BG] executeScript error:', chrome.runtime.lastError.message);
        return;
      }
      chrome.tabs.sendMessage(tabId, {
        action: 'START',
        ai: 'gemini',
        mode: d.activeMode || 'solve',
        prompt: d.batchPrompt || '',
      }, () => {
        if (chrome.runtime.lastError) { /* tab mungkin belum siap, abaikan */ }
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
        console.warn('[Prelab BG] captureVisibleTab error:', chrome.runtime.lastError.message);
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
            console.warn('[Prelab BG] sendMessage to LMS tab error:', chrome.runtime.lastError.message);
          }
        });
      }
      // Close Gemini shadow tab after extracting answer
      if (sender.tab?.id) {
        setTimeout(() => chrome.tabs.remove(sender.tab.id, () => {
          if (chrome.runtime.lastError) { /* tab sudah tutup */ }
        }), 500);
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
            console.warn('[Prelab BG] sendMessage RETRY_SOLVE error:', chrome.runtime.lastError.message);
          }
        });
      }
      // Tutup tab Gemini yang gagal / hang
      if (sender.tab?.id) {
        setTimeout(() => chrome.tabs.remove(sender.tab.id, () => {
          if (chrome.runtime.lastError) { /* tab sudah tutup */ }
        }), 700);
      }
    });
    return true;
  }

  // Open Gemini tab with payload
  if (msg.action === 'OPEN_AI') {
    chrome.storage.local.get(['pendingTabId'], d => {
      const openNewTab = () => {
        chrome.storage.local.set({ prelabPayload: msg.payload }, () => {
          chrome.tabs.create({ url: GEMINI_URL }, newTab => {
            chrome.storage.local.set({ pendingTabId: newTab.id });
          });
        });
      };

      // Tutup tab Gemini lama jika masih terbuka
      if (d.pendingTabId) {
        chrome.tabs.remove(d.pendingTabId, () => {
          if (chrome.runtime.lastError) { /* tab mungkin sudah tutup, ignore */ }
          chrome.storage.local.remove(['pendingTabId'], openNewTab);
        });
      } else {
        openNewTab();
      }
    });
    return true;
  }

  // Sinyal batal penuh dari user — bersihkan SEMUA state sesi
  if (msg.action === 'STOP_PROCESS') {
    chrome.storage.local.get(['pendingTabId'], d => {
      if (d.pendingTabId) {
        chrome.tabs.remove(d.pendingTabId, () => {
          if (chrome.runtime.lastError) console.warn('[Prelab] tab remove error', chrome.runtime.lastError);
        });
      }
      // Hapus semua key sesi termasuk isBatching agar bot benar-benar berhenti
      chrome.storage.local.remove(STALE_KEYS);
    });
    return true;
  }
});
