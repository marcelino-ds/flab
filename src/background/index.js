// ── Background service worker ─────────────────────────────────────────────────
'use strict';

import { getProvider } from '../shared/providers.js';

// Daftar KANONIK semua key state sesi (HARUS identik dengan SESSION_KEYS di popup.js).
// TIDAK termasuk 'errorLogs' & 'prompt' yang sengaja persisten antar sesi.
const STALE_KEYS = [
  'isBatching', 'batchTabId', 'pendingTabId', 'flabPayload',
  'activeMode', 'batchPrompt', 'ai', 'current', 'total',
  'solveRetryCount', 'precheckError', 'precheckCode', 'precheckRetryCount', 'checkRetryCount', 'solveDispatchCount'
];

function clearStaleSession(reason) {
  chrome.storage.local.remove(STALE_KEYS, () => {
    console.log(`[FLAB BG] Stale session cleared (${reason}).`);
  });
}

// Cleanup saat extension/browser restart
chrome.runtime.onStartup.addListener(() => clearStaleSession('startup'));

// Cleanup saat extension di-install/update
chrome.runtime.onInstalled.addListener(() => clearStaleSession('install/update'));

// URL provider LLM di-resolve dari registry berdasarkan payload.ai (default: gemini).

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
        console.warn('[FLAB BG] executeScript error:', chrome.runtime.lastError.message);
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
  // Defense-in-depth: hanya terima pesan dari konteks ekstensi ini sendiri
  // (content script / popup / injector kita). Tolak origin tak terduga.
  if (sender.id !== chrome.runtime.id) return;

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
        console.warn('[FLAB BG] captureVisibleTab error:', chrome.runtime.lastError.message);
        sendResponse({ dataUrl: null });
      } else {
        sendResponse({ dataUrl });
      }
    });
    return true; // keep channel open for async response
  }

  // Gemini → LMS answer bridge
  if (msg.action === 'SOLVER_JSON_RESULT') {
    chrome.storage.local.get(['batchTabId', 'current', 'total'], d => {
      chrome.runtime.sendMessage({
        action: 'PROGRESS_UPDATE',
        current: d.current || '?',
        total: d.total || '?'
      }, () => { if(chrome.runtime.lastError){} });

      if (d.batchTabId) {
        chrome.tabs.sendMessage(d.batchTabId, { action: 'FILL_ANSWER', data: msg.data }, () => {
          if (chrome.runtime.lastError) {
            console.warn('[FLAB BG] sendMessage to LMS tab error:', chrome.runtime.lastError.message);
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
            console.warn('[FLAB BG] sendMessage RETRY_SOLVE error:', chrome.runtime.lastError.message);
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
        const providerUrl = getProvider(msg.payload?.ai).url;
        chrome.storage.local.set({ flabPayload: msg.payload }, () => {
          chrome.tabs.create({ url: providerUrl }, newTab => {
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
    chrome.storage.local.get(['pendingTabId', 'batchTabId'], d => {
      // Forward kill signal to LMS tab to instantly stop polling
      if (d.batchTabId) {
        chrome.tabs.sendMessage(d.batchTabId, { action: 'STOP_PROCESS' }, () => {
          if (chrome.runtime.lastError) { /* ignore if tab is closed */ }
        });
      }
      
      if (d.pendingTabId) {
        chrome.tabs.remove(d.pendingTabId, () => {
          if (chrome.runtime.lastError) console.warn('[FLAB] tab remove error', chrome.runtime.lastError);
        });
      }
      // Hapus semua key sesi termasuk isBatching agar bot benar-benar berhenti
      chrome.storage.local.remove(STALE_KEYS);
    });
    return true;
  }
});
