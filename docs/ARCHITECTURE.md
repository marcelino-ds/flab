# Architecture & Design Decisions

This document explains *why* flab is built the way it is. The code shows what; this
shows the reasoning behind the non-obvious choices.

## System overview

flab spans four browser-extension surfaces that communicate via `chrome.runtime` messaging:

```
┌──────────┐   START    ┌───────────┐   OPEN_AI    ┌────────────┐
│  popup   │ ─────────▶ │  content  │ ───────────▶ │ background │
│ launcher │            │  (LMS)    │              │  (worker)  │
└──────────┘            └───────────┘              └────────────┘
                              ▲                          │ opens tab
                       FILL_ANSWER / RETRY               ▼
                              │                    ┌────────────┐
                              └──────────────────  │  injector  │
                                 SOLVER_JSON_RESULT │  (Gemini)  │
                                                    └────────────┘
```

1. **popup** starts a session.
2. **content** (on the LMS page) finds the active question, extracts it, and asks background to open the LLM.
3. **background** (service worker) manages the LLM tab and relays messages.
4. **injector** (on the LLM page) injects the prompt, observes the streamed reply, extracts a JSON answer, and sends it back.
5. **content** fills the answer and drives the quiz's check/navigate flow.

## Key decisions

### 1. Text-first extraction, not screenshots

Moodle does **exact string matching** on multiple-choice options. OCR from a
screenshot routinely corrupts `0`/`O`, whitespace, and punctuation, which breaks
matching. Reading option text straight from the DOM is lossless. Screenshots are
used only as a fallback when a question genuinely contains non-text content
(diagrams, images), and even then the DOM text is sent alongside.

### 2. Structure-preserving extraction (HTML → Markdown)

`innerText` flattens tables, code blocks, and math into ambiguous text. For a
CS practicum that is full of I/O tables and code, that loses exactly the
information the model needs. `html-to-markdown.js` converts the question subtree
to Markdown: tables become Markdown tables, `<pre>` becomes fenced code, and
MathJax (v2 `script[type=math/tex]`, v3/MathML `annotation`) is pulled out as
LaTeX source rather than its broken rendered text.

### 3. Index-aligned answer filling

The fragile way to fill a multiple-choice answer is to match the model's answer
*text* against on-screen options — two similar options cause mis-clicks. Instead,
`moodle-options.js` derives the option list from the **same input elements that
will be clicked**, and numbers them. The model is told to return that number as
the authoritative signal. Because enumeration order and click order come from one
source, the index can be trusted; text is kept only as a cross-check. This
removed an entire class of "almost-right" mis-fills.

### 4. Balanced-brace JSON extraction

The model's answer is a JSON block embedded in free-form streamed text. The naive
`text.lastIndexOf('}')` breaks on two common cases: code answers full of `{}`, and
trailing prose after the block. `json-extract.js` walks from the opening brace
counting depth while being aware of strings and escapes, returning the true
matching close. This is the single highest-leverage correctness fix — it's what
makes coding answers parse reliably. It's also pure and unit-tested.

### 5. Verify fills before claiming success

Synthetic `ClipboardEvent`/paste into the Ace editor often silently no-ops. The
old code returned `true` regardless, so the flow would "check" an empty editor and
loop on retries. Fillers now read the editor back and compare before reporting
success, falling through to the next method otherwise.

### 6. Idempotent injection

The content script is auto-injected by the manifest *and* re-injected on demand.
Top-level `const` declarations would throw `already declared` on re-injection, so
the entire script is guarded by a `window.__flabAI` flag set before any
declaration. The esbuild IIFE format reinforces this by wrapping each surface in a
closure.

### 7. Circuit breaker on the retry loop

CodeRunner questions can retry (precheck fail → re-solve). Three independent retry
budgets could compound and open the LLM tab indefinitely. A hard per-session cap on
solve dispatches (`MAX_SOLVE_DISPATCH`) is a backstop that guarantees termination
without rewriting the retry logic.

### 8. esbuild bundle pipeline

The content script grew to ~2000 lines. Splitting it into ES modules is the clean
fix, but Chrome content scripts don't support ES modules directly. esbuild bundles
each surface to an IIFE (`--format=iife`), which simultaneously enables true
modularity, unit-testing of pure modules, and the idempotency guarantee from #6.

## What is *not* modularized, and why

The flow engine (`handleSolve`, precheck/check/navigate, router, status UI) stays
in `content/index.js`. These functions form a cycle
(`navigateNext → handleStart → handleSolve → ilabCheckAndNavigate → navigateNext`)
and share mutable session state. Splitting them would convert in-file cohesion into
circular cross-module imports — worse architecture, not better. The extracted
modules are all **leaves** (one-way dependencies), which is precisely what makes
them safe to verify by build/unit-test alone. The flow engine is verified by
running the extension in a real browser.

## Security posture

- **Least privilege**: no clipboard permissions; only the host permissions needed.
- **MV3 CSP friendly**: no remote code, no remote fonts, no `eval`.
- **Message trust boundary**: handlers validate `sender.id` against the extension's own id.
- **XSS**: all untrusted text (LLM output, page DOM) is escaped before `innerHTML`.
- **Transient sensitive data**: error screenshots in `chrome.storage.local` carry a TTL and a hard count cap.
