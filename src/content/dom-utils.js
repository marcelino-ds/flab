// Helper DOM murni (tanpa state internal / chrome.*). Dipakai lintas fill & flow.

export function findUnansweredQuestion(questions) {
  for (const q of questions) {
    if (q.classList.contains('notyetanswered') ||
      q.classList.contains('invalidanswer') ||
      !q.classList.contains('complete')) {
      return q;
    }
    const radios = q.querySelectorAll('input[type="radio"]');
    if (radios.length > 0 && ![...radios].some(r => r.checked)) {
      return q;
    }
    const textInput = q.querySelector('input[type="text"]');
    if (textInput && !textInput.value.trim()) {
      return q;
    }
    // Also check for empty textarea (CodeRunner / Essay)
    const textArea = q.querySelector('textarea:not([hidden])');
    if (textArea && !textArea.value.trim()) {
      return q;
    }
  }
  return null;
}

// Find button by keywords inside a question element or globally
export function findButton(queEl, keywords, excludeKeywords = []) {
  // First: cari di dalam question element
  // Note: .im-controls is already inside queEl, so a single querySelectorAll covers it.
  const allBtns = [...queEl.querySelectorAll('button, input[type="button"], input[type="submit"]')];

  for (const btn of allBtns) {
    const txt = (btn.innerText || btn.value || btn.name || '').toLowerCase();
    const matchesKeyword = keywords.some(k => txt.includes(k));
    const excluded = excludeKeywords.some(ex => txt.includes(ex));

    // Khusus untuk Check vs Precheck: jika mencari 'check' tapi ini 'precheck', harus di-skip.
    if (matchesKeyword && !excluded && btn.offsetParent !== null) {
      // Pastikan kalau cuma nyari 'check', nggak salah klik 'precheck'
      if (keywords.includes('check') && !keywords.includes('precheck') && txt.includes('precheck')) {
        continue;
      }
      return btn;
    }
  }

  // Fallback: cari di .submitbtns global
  const submitBtns = document.querySelectorAll('.submitbtns button, .submitbtns input[type="submit"]');
  for (const btn of submitBtns) {
    const txt = (btn.innerText || btn.value || btn.name || '').toLowerCase();
    const matchesKeyword = keywords.some(k => txt.includes(k));
    const excluded = excludeKeywords.some(ex => txt.includes(ex));

    if (matchesKeyword && !excluded) {
      if (keywords.includes('check') && !keywords.includes('precheck') && txt.includes('precheck')) {
        continue;
      }
      return btn;
    }
  }

  return null;
}

export function moodleClickRadio(el) {
  if (!el) return;

  // Jika checkbox/radio sudah tercentang, biarkan saja
  if (el.type === 'checkbox' && el.checked) return;
  if (el.type === 'radio' && el.checked) return;

  // Gunakan klik native browser agar state toggle pada checkbox sinkron sempurna
  el.click();

  // Fallback trigger event manual kalau Moodle gak nangkep (tapi biasanya click() udah cukup)
  el.dispatchEvent(new Event('change', { bubbles: true }));
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

export function setNativeValue(el, value, isTextarea = false) {
  el.focus();
  const proto = isTextarea ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  if (setter) {
    setter.call(el, value);
  } else {
    el.value = value;
  }
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

export function highlightElement(el) {
  if (!el) return;
  el.style.outline = '2px solid rgba(10, 132, 255, 0.5)';
  el.style.backgroundColor = 'rgba(10, 132, 255, 0.06)';
  el.style.borderRadius = '6px';
  el.style.transition = 'all 0.3s ease';
  setTimeout(() => {
    if (el) {
      el.style.outline = '';
      el.style.backgroundColor = '';
    }
  }, 3000);
}

export function fireClick(el) {
  try {
    el.click();
    el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  } catch { /**/ }
}

export function findNextButton() {
  const NEXT_KEYWORDS = ['next', 'selanjutnya', 'berikutnya', 'lanjut'];
  return [...document.querySelectorAll('button,a,input[type="button"],input[type="submit"]')]
    .find(b => {
      if (b.offsetWidth === 0 && b.offsetHeight === 0) return false;
      const txt = (b.innerText || b.value || '').toLowerCase();
      return NEXT_KEYWORDS.some(k => txt.includes(k));
    }) ?? null;
}

export function extractText() {
  const skip = new Set(['script', 'style', 'noscript', 'nav', 'header', 'footer']);
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
    acceptNode(n) {
      const tag = n.parentElement?.tagName?.toLowerCase();
      if (skip.has(tag) || n.parentElement?.closest('nav,header,footer,#flabai-snip'))
        return NodeFilter.FILTER_REJECT;
      if (!n.textContent.trim()) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    }
  });
  const chunks = [];
  while (walker.nextNode()) {
    const t = walker.currentNode.textContent.trim();
    if (t.length > 3 && chunks.at(-1) !== t) chunks.push(t);
  }
  return chunks.join('\n').slice(0, 12000);
}

// ── Shared helper: smooth-scroll an element into view + push container scroll ──
export function scrollToResultElement(el, fallbackEl, forceInstant = false) {
  if (!el) return;
  try {
    el.scrollIntoView({ behavior: forceInstant ? 'auto' : 'smooth', block: 'center' });
  } catch (e) {
    try {
      const fallback = fallbackEl?.querySelector('.answer, .formulation') || fallbackEl;
      if (fallback) fallback.scrollIntoView({ behavior: 'smooth', block: 'center' });
    } catch (_) { /**/ }
  }
}

export function waitForBody(intervalMs, fn) {
  if (document.body) return fn();
  const id = setInterval(() => { if (document.body) { clearInterval(id); fn(); } }, intervalMs);
}

// Polling waitFor — sadar window.__flabAborted (di-set oleh content script saat batal).
export function waitFor(fn, timeout = 10000, interval = 300) {
  return new Promise(res => {
    const id = setInterval(() => {
      if (window.__flabAborted) { clearInterval(id); res(null); return; }
      const v = fn();
      if (v) { clearInterval(id); res(v); }
    }, interval);
    setTimeout(() => { clearInterval(id); res(null); }, timeout);
  });
}
