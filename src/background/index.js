// ── Background service worker ─────────────────────────────────────────────────
'use strict';

import { getProvider } from '../shared/providers.js';
import { solveViaApi } from '../shared/api-client.js';

// Daftar KANONIK semua key state sesi (HARUS identik dengan SESSION_KEYS di popup.js).
// TIDAK termasuk 'errorLogs' & 'prompt' yang sengaja persisten antar sesi.
const STALE_KEYS = [
  'isBatching', 'batchTabId', 'pendingTabId', 'flabPayload',
  'activeMode', 'batchPrompt', 'ai', 'current', 'total',
  'solveRetryCount', 'precheckError', 'precheckCode', 'precheckRetryCount', 'checkRetryCount', 'solveDispatchCount', 'sessionStats',
  'providerTabId', 'providerTabAi'
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

// Re-injeksi hanya di tab http(s); pembatasan sebenarnya adalah sesi aktif
// (isBatching && batchTabId === tabId). Content script punya guard isMoodle()
// sendiri sehingga halaman non-Moodle tidak diproses.
function isInjectableUrl(url) {
  try { return /^https?:$/.test(new URL(url).protocol); }
  catch { return false; }
}

// ── Re-inject content.js + kick off loop saat tab sesi aktif berpindah halaman ──
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'complete') return;
  if (!tab.url || !isInjectableUrl(tab.url)) return;

  chrome.storage.local.get(['isBatching', 'batchTabId', 'activeMode', 'batchPrompt', 'ai'], d => {
    if (!d.isBatching || d.batchTabId !== tabId) return;

    chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] }, () => {
      if (chrome.runtime.lastError) {
        console.warn('[FLAB BG] executeScript error:', chrome.runtime.lastError.message);
        return;
      }
      chrome.tabs.sendMessage(tabId, {
        action: 'START',
        ai: d.ai || 'gemini',
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
      // Tab persisten: JANGAN tutup tab provider setelah jawaban diekstrak. Tab
      // dipakai ulang untuk soal berikutnya (turn baru di chat yang sama).
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
      // Tab hang → tutup & lupakan, agar retry membuka tab provider yang segar
      // (chat lama mungkin macet/stream tak selesai). Bukan jalur sukses normal.
      if (sender.tab?.id) {
        chrome.storage.local.remove(['providerTabId', 'providerTabAi']);
        setTimeout(() => chrome.tabs.remove(sender.tab.id, () => {
          if (chrome.runtime.lastError) { /* tab sudah tutup */ }
        }), 700);
      }
    });
    return true;
  }

  // Open / reuse provider tab with payload.
  // Tab persisten: bila tab provider yang sama masih hidup, kirim soal berikutnya
  // sebagai turn baru di chat yang sama (NEW_PAYLOAD) tanpa reload. Ini buang biaya
  // cold-load SPA tiap soal dan memberi model konteks percobaan sebelumnya saat retry.
  if (msg.action === 'OPEN_AI') {
    const payload = msg.payload;
    const wantAi = payload?.ai || 'gemini';
    const provider = getProvider(wantAi);
    const providerUrl = provider.url;

    // ── Mode API (opsional) ──────────────────────────────────────────────────
    // Bila user mengaktifkan Mode API & ada key untuk provider ini, jawab via fetch
    // langsung — tanpa tab. Bila gagal/tak ada key, jatuh ke jalur tab di bawah.
    chrome.storage.local.get(['apiMode', `apiKey_${wantAi}`], cfg => {
      const key = cfg[`apiKey_${wantAi}`];
      if (cfg.apiMode && key && provider.api) {
        solveViaApi(provider, key, payload)
          .then(answer => relayAnswerToLms(answer))
          .catch(err => {
            console.warn('[FLAB BG] API mode gagal, fallback ke jalur tab:', err.message);
            openOrReuseTab();
          });
        return;
      }
      openOrReuseTab();
    });

    function relayAnswerToLms(answer) {
      chrome.storage.local.get(['batchTabId', 'current', 'total'], d => {
        chrome.runtime.sendMessage({
          action: 'PROGRESS_UPDATE', current: d.current || '?', total: d.total || '?',
        }, () => { void chrome.runtime.lastError; });
        if (d.batchTabId) {
          chrome.tabs.sendMessage(d.batchTabId, { action: 'FILL_ANSWER', data: answer }, () => {
            void chrome.runtime.lastError;
          });
        }
      });
    }

    function openOrReuseTab() {
    chrome.storage.local.get(['providerTabId', 'providerTabAi'], d => {
      const createFresh = () => {
        const launch = () => chrome.storage.local.set({ flabPayload: payload }, () => {
          chrome.tabs.create({ url: providerUrl }, newTab => {
            chrome.storage.local.set({
              pendingTabId: newTab.id,
              providerTabId: newTab.id,
              providerTabAi: wantAi,
            });
          });
        });
        // Tutup tab lama (provider beda / sesi lama) sebelum buka yang baru.
        if (d.providerTabId) {
          chrome.tabs.remove(d.providerTabId, () => { void chrome.runtime.lastError; launch(); });
        } else {
          launch();
        }
      };

      const canReuse = d.providerTabId && d.providerTabAi === wantAi;
      if (!canReuse) { createFresh(); return; }

      // Tab masih ada? Validasi sebelum reuse — user bisa saja menutupnya.
      chrome.tabs.get(d.providerTabId, tab => {
        if (chrome.runtime.lastError || !tab) { createFresh(); return; }
        chrome.storage.local.set({ flabPayload: payload, pendingTabId: d.providerTabId }, () => {
          chrome.tabs.sendMessage(d.providerTabId, { action: 'NEW_PAYLOAD' }, () => {
            // Tab hidup tapi injector tak merespons (mis. user navigasi keluar) → buka ulang.
            if (chrome.runtime.lastError) createFresh();
          });
        });
      });
    });
    }
    return true;
  }

  // Sinyal batal penuh dari user — bersihkan SEMUA state sesi
  if (msg.action === 'STOP_PROCESS') {
    chrome.storage.local.get(['pendingTabId', 'batchTabId', 'providerTabId'], d => {
      // Forward kill signal to LMS tab to instantly stop polling
      if (d.batchTabId) {
        chrome.tabs.sendMessage(d.batchTabId, { action: 'STOP_PROCESS' }, () => {
          if (chrome.runtime.lastError) { /* ignore if tab is closed */ }
        });
      }

      // Tutup tab provider (pendingTabId & providerTabId bisa berbeda bila reuse) —
      // dedup agar tidak remove dua kali.
      const tabsToClose = [...new Set([d.pendingTabId, d.providerTabId].filter(Boolean))];
      tabsToClose.forEach(id => chrome.tabs.remove(id, () => { void chrome.runtime.lastError; }));

      // Hapus semua key sesi termasuk isBatching agar bot benar-benar berhenti
      chrome.storage.local.remove(STALE_KEYS);
    });
    return true;
  }
});
