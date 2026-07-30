// ── Background service worker ─────────────────────────────────────────────────
'use strict';

import { getProvider } from '../shared/providers.js';
import { solveViaApi } from '../shared/api-client.js';
import { isCurrentRequest, requestKey } from '../shared/session-guard.js';
import { STALE_KEYS, SESSION_KEYS, PROVIDER_TAB_KEYS } from '../shared/session-keys.js';

// STALE_KEYS (inti + key tab provider) & SESSION_KEYS (inti) kini single source of
// truth (shared/session-keys.js) — bukan lagi dua array manual yang harus identik.

const apiControllers = new Map();

function abortApi(key) {
  if (!key) return;
  const ctrl = apiControllers.get(key);
  if (ctrl) {
    ctrl.abort();
    apiControllers.delete(key);
  }
}

function abortAllApis() {
  for (const ctrl of apiControllers.values()) ctrl.abort();
  apiControllers.clear();
}

function currentStorage(cb) {
  chrome.storage.local.get(['isBatching', 'sessionId', 'activeRequestId', 'batchTabId', 'current', 'total'], cb);
}

function clearStaleSession(reason) {
  abortAllApis();
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

  chrome.storage.local.get(['isBatching', 'batchTabId', 'activeMode', 'batchPrompt', 'ai', 'sessionId'], d => {
    if (!d.isBatching || d.batchTabId !== tabId) return;

    chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] }, () => {
      if (chrome.runtime.lastError) {
        console.warn('[FLAB BG] executeScript error:', chrome.runtime.lastError.message);
        return;
      }
      chrome.tabs.sendMessage(tabId, {
        action: 'START',
        sessionId: d.sessionId,
        ai: d.ai || 'gemini',
        mode: d.activeMode || 'solve',
        prompt: d.batchPrompt || '',
      }, () => {
        if (chrome.runtime.lastError) { /* tab mungkin belum siap, abaikan */ }
      });
    });
  });
});

function samePayloadIdentity(a, b) {
  return !!a && !!b && a.sessionId === b.sessionId && a.requestId === b.requestId;
}

function removePayloadIfCurrent(identity, pendingTabId) {
  chrome.storage.local.get(['flabPayload', 'pendingTabId'], cur => {
    if (samePayloadIdentity(cur.flabPayload, identity) && cur.pendingTabId === pendingTabId) {
      chrome.storage.local.remove(['flabPayload', 'pendingTabId']);
    }
  });
}

function relayProgress(d) {
  chrome.runtime.sendMessage({
    action: 'PROGRESS_UPDATE',
    current: d.current || '?',
    total: d.total || '?',
  }, () => { void chrome.runtime.lastError; });
}

function relayAnswerToLms(d, answer, identity) {
  relayProgress(d);
  if (d.batchTabId) {
    chrome.tabs.sendMessage(d.batchTabId, {
      action: 'FILL_ANSWER',
      sessionId: identity.sessionId,
      requestId: identity.requestId,
      data: answer,
    }, () => {
      if (chrome.runtime.lastError) {
        console.warn('[FLAB BG] sendMessage to LMS tab error:', chrome.runtime.lastError.message);
      }
    });
  }
}

function relayRetryToLms(d, identity) {
  if (d.batchTabId) {
    chrome.tabs.sendMessage(d.batchTabId, {
      action: 'RETRY_SOLVE',
      sessionId: identity.sessionId,
      requestId: identity.requestId,
    }, () => {
      if (chrome.runtime.lastError) {
        console.warn('[FLAB BG] sendMessage RETRY_SOLVE error:', chrome.runtime.lastError.message);
      }
    });
  }
}

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

  // Provider → LMS answer bridge
  if (msg.action === 'SOLVER_JSON_RESULT') {
    currentStorage(d => {
      if (!isCurrentRequest(d, msg)) {
        console.log('[FLAB BG] Drop SOLVER_JSON_RESULT stale.');
        return;
      }
      relayAnswerToLms(d, msg.data, msg);
      // Tab persisten: JANGAN tutup tab provider setelah jawaban diekstrak. Tab
      // dipakai ulang untuk soal berikutnya (turn baru di chat yang sama).
    });
    return true;
  }

  // Sinyal timeout dari provider → relay retry ke LMS tab
  if (msg.action === 'SOLVER_TIMEOUT') {
    currentStorage(d => {
      if (!isCurrentRequest(d, msg)) {
        console.log('[FLAB BG] Drop SOLVER_TIMEOUT stale.');
        return;
      }
      relayRetryToLms(d, msg);
      // Tab hang → tutup & lupakan, agar retry membuka tab provider yang segar
      // (chat lama mungkin macet/stream tak selesai). Bukan jalur sukses normal.
      if (sender.tab?.id) {
        chrome.storage.local.remove(PROVIDER_TAB_KEYS);
        setTimeout(() => chrome.tabs.remove(sender.tab.id, () => {
          if (chrome.runtime.lastError) { /* tab sudah tutup */ }
        }), 700);
      }
    });
    return true;
  }

  // Provider setup failure → retry current request from LMS and refresh provider tab.
  if (msg.action === 'PROVIDER_SETUP_FAILED') {
    currentStorage(d => {
      if (!isCurrentRequest(d, msg)) {
        console.log('[FLAB BG] Drop PROVIDER_SETUP_FAILED stale.');
        return;
      }
      console.warn(`[FLAB BG] Provider setup failed (${msg.providerId || '?'}:${msg.stage || '?'})`);
      relayRetryToLms(d, msg);
      if (sender.tab?.id) {
        chrome.storage.local.remove(PROVIDER_TAB_KEYS);
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
    const payload = msg.payload || {};
    const identity = {
      sessionId: msg.sessionId ?? payload.sessionId,
      requestId: msg.requestId ?? payload.requestId,
    };
    const keyForRequest = requestKey(identity);
    const wantAi = payload.ai || 'gemini';
    const provider = getProvider(wantAi);
    const providerUrl = provider.url;

    currentStorage(d => {
      if (!isCurrentRequest(d, identity)) {
        console.log('[FLAB BG] Drop OPEN_AI stale.');
        return;
      }

      // Request baru menyupersede API request lama; tab-path masih dijaga oleh requestId.
      for (const key of [...apiControllers.keys()]) {
        if (key !== keyForRequest) abortApi(key);
      }

      // ── Mode API (opsional) ──────────────────────────────────────────────────
      // Bila user mengaktifkan Mode API & ada key untuk provider ini, jawab via fetch
      // langsung — tanpa tab. Bila gagal/tak ada key, jatuh ke jalur tab di bawah.
      chrome.storage.local.get(['apiMode', `apiKey_${wantAi}`], cfg => {
        currentStorage(fresh => {
          if (!isCurrentRequest(fresh, identity)) {
            console.log('[FLAB BG] Drop OPEN_AI after config load: stale.');
            return;
          }

          const apiKey = cfg[`apiKey_${wantAi}`];
          if (cfg.apiMode && apiKey && provider.api) {
            abortApi(keyForRequest);
            const ctrl = new AbortController();
            apiControllers.set(keyForRequest, ctrl);
            solveViaApi(provider, apiKey, payload, { signal: ctrl.signal })
              .then(answer => {
                apiControllers.delete(keyForRequest);
                currentStorage(latest => {
                  if (!isCurrentRequest(latest, identity)) {
                    console.log('[FLAB BG] Drop API result stale.');
                    return;
                  }
                  relayAnswerToLms(latest, answer, identity);
                });
              })
              .catch(err => {
                apiControllers.delete(keyForRequest);
                if (err?.name === 'AbortError') return;
                currentStorage(latest => {
                  if (!isCurrentRequest(latest, identity)) {
                    console.log('[FLAB BG] Drop API fallback stale.');
                    return;
                  }
                  console.warn('[FLAB BG] API mode gagal, fallback ke jalur tab:', err?.message || err);
                  openOrReuseTab(identity);
                });
              });
            return;
          }
          openOrReuseTab(identity);
        });
      });
    });

    function openOrReuseTab(identityForPayload) {
      currentStorage(latest => {
        if (!isCurrentRequest(latest, identityForPayload)) {
          console.log('[FLAB BG] Drop provider-tab launch stale.');
          return;
        }
        chrome.storage.local.get(['providerTabId', 'providerTabAi'], d => {
          currentStorage(now => {
            if (!isCurrentRequest(now, identityForPayload)) {
              console.log('[FLAB BG] Drop provider-tab launch after tab lookup: stale.');
              return;
            }

            const createFresh = () => {
              const launch = () => {
                currentStorage(beforeLaunch => {
                  if (!isCurrentRequest(beforeLaunch, identityForPayload)) {
                    console.log('[FLAB BG] Drop provider-tab fresh launch stale.');
                    return;
                  }
                  chrome.storage.local.set({ flabPayload: payload }, () => {
                    currentStorage(afterPayload => {
                      if (!isCurrentRequest(afterPayload, identityForPayload)) {
                        removePayloadIfCurrent(identityForPayload, afterPayload.pendingTabId);
                        console.log('[FLAB BG] Drop provider-tab create after payload write: stale.');
                        return;
                      }
                      // active:true → tab provider dibuka & DIFOKUS. Gemini (Angular SPA) menunda
                      // render saat tab di background → editor tak siap, injeksi gagal, stuck.
                      // Setelah soal terkirim, injector memicu REFOCUS_LMS untuk balik ke iLab.
                      chrome.tabs.create({ url: providerUrl, active: true }, newTab => {
                        currentStorage(afterCreate => {
                          if (!isCurrentRequest(afterCreate, identityForPayload)) {
                            chrome.tabs.remove(newTab.id, () => { void chrome.runtime.lastError; });
                            return;
                          }
                          chrome.storage.local.set({
                            pendingTabId: newTab.id,
                            providerTabId: newTab.id,
                            providerTabAi: wantAi,
                          });
                        });
                      });
                    });
                  });
                });
              };
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
              currentStorage(current => {
                if (!isCurrentRequest(current, identityForPayload)) {
                  console.log('[FLAB BG] Drop provider-tab reuse stale.');
                  return;
                }
                // Fokus tab provider dulu: Gemini SPA menunda render di background → editor
                // tak siap & NEW_PAYLOAD gagal inject. Setelah terkirim, REFOCUS_LMS balik ke iLab.
                chrome.tabs.update(d.providerTabId, { active: true }, () => { void chrome.runtime.lastError; });
                chrome.storage.local.set({ flabPayload: payload, pendingTabId: d.providerTabId }, () => {
                  currentStorage(afterPayload => {
                    if (!isCurrentRequest(afterPayload, identityForPayload)) {
                      removePayloadIfCurrent(identityForPayload, afterPayload.pendingTabId);
                      console.log('[FLAB BG] Drop provider-tab reuse after payload write: stale.');
                      return;
                    }
                    chrome.tabs.sendMessage(d.providerTabId, { action: 'NEW_PAYLOAD', ...identityForPayload }, () => {
                      // Tab hidup tapi injector tak merespons (mis. user navigasi keluar) → buka ulang.
                      if (chrome.runtime.lastError) createFresh();
                    });
                  });
                });
              });
            });
          });
        });
      });
    }
    return true;
  }

  // Soal sudah terkirim ke provider → balik fokus ke tab iLab/Moodle agar user
  // melihat progres "soal ke-N". Tab provider tetap di belakang menyelesaikan jawaban
  // (MutationObserver tahan throttle). Dipicu injector tepat setelah clickSend sukses.
  if (msg.action === 'REFOCUS_LMS') {
    chrome.storage.local.get(['batchTabId'], d => {
      if (d.batchTabId) {
        chrome.tabs.update(d.batchTabId, { active: true }, tab => {
          void chrome.runtime.lastError;
          if (tab?.windowId != null) chrome.windows.update(tab.windowId, { focused: true }, () => { void chrome.runtime.lastError; });
        });
      }
    });
    return true;
  }

  // Sesi selesai normal — fokuskan kembali tab iLab/Moodle & bersihkan key sesi.
  // Tab provider SENGAJA TIDAK ditutup: dipertahankan agar sesi berikutnya reuse chat
  // yang sama (tanpa cold-load) dan user bisa lihat histori jawaban bila perlu.
  if (msg.action === 'SESSION_DONE') {
    chrome.storage.local.get(['batchTabId'], d => {
      if (d.batchTabId) {
        chrome.tabs.update(d.batchTabId, { active: true }, tab => {
          void chrome.runtime.lastError;
          if (tab?.windowId != null) chrome.windows.update(tab.windowId, { focused: true }, () => { void chrome.runtime.lastError; });
        });
      }
      // Pertahankan providerTabId/providerTabAi untuk reuse; buang sisa key sesi lain.
      chrome.storage.local.remove(SESSION_KEYS);
    });
    return true;
  }

  // Sinyal batal penuh dari user — bersihkan SEMUA state sesi
  if (msg.action === 'STOP_PROCESS') {
    chrome.storage.local.get(['pendingTabId', 'batchTabId', 'providerTabId', 'sessionId', 'activeRequestId'], d => {
      const senderTabId = sender.tab?.id ?? null;
      const hasIdentity = !!(msg.sessionId || msg.requestId);
      const identityMatches = hasIdentity &&
        d.sessionId === msg.sessionId &&
        d.activeRequestId === msg.requestId;
      const senderIsCurrentSessionTab = senderTabId &&
        (senderTabId === d.batchTabId || senderTabId === d.providerTabId || senderTabId === d.pendingTabId);
      if (!hasIdentity || !identityMatches || !senderIsCurrentSessionTab) {
        console.log('[FLAB BG] Drop STOP_PROCESS stale/untrusted.');
        return;
      }

      abortAllApis();

      // Forward kill signal to LMS tab to instantly stop polling
      if (d.batchTabId) {
        chrome.tabs.sendMessage(d.batchTabId, {
          action: 'STOP_PROCESS',
          sessionId: d.sessionId,
          requestId: d.activeRequestId,
        }, () => {
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
