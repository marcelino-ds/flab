// SATU sumber kebenaran untuk daftar key state sesi yang dibersihkan saat sesi
// selesai/batal/START baru. Dipakai oleh popup (SESSION_KEYS) & background
// (STALE_KEYS). Menaruh daftar di sini mencegah drift diam-diam antar surface.
//
// Perilaku dipertahankan identik dengan sebelumnya:
// - `SESSION_KEYS` (inti) dibersihkan baik oleh popup saat START maupun background.
// - `PROVIDER_TAB_KEYS` hanya dikelola background (lifecycle tab provider milik BG);
//   popup TIDAK membuangnya saat START — background yang menutup/mereuse tab provider.
//
// CATATAN: TIDAK termasuk 'errorLogs' & 'prompt' yang sengaja persisten antar sesi.

export const SESSION_KEYS = [
  'isBatching', 'batchTabId', 'pendingTabId', 'flabPayload',
  'activeMode', 'batchPrompt', 'ai', 'current', 'total',
  'solveRetryCount', 'precheckError', 'precheckCode', 'precheckRetryCount', 'checkRetryCount', 'solveDispatchCount', 'precheckPending', 'sessionStats',
  'sessionId', 'activeRequestId',
];

// Key tab provider — hanya milik background. Dipisah eksplisit (bukan drift) agar
// popup tak ikut membersihkannya saat START: background yang mengatur reuse/tutup tab.
export const PROVIDER_TAB_KEYS = ['providerTabId', 'providerTabAi'];

// Daftar lengkap untuk background (inti + key tab provider). Dibuat baru agar
// background tetap punya array mandiri yang bisa di-`remove()` / filter tanpa
// memutasi SESSION_KEYS yang dipakai popup.
export const STALE_KEYS = [...SESSION_KEYS, ...PROVIDER_TAB_KEYS];
