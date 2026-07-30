# flab

[![CI](https://github.com/marcelino-ds/flab/actions/workflows/ci.yml/badge.svg)](https://github.com/marcelino-ds/flab/actions/workflows/ci.yml)

A Chrome **Manifest V3** extension that automates answering Moodle-based online quizzes by routing question content through an LLM (Gemini, ChatGPT, or Claude — selectable) and filling answers back into the page. Works on any Moodle instance via runtime detection, not a hardcoded host list.

This project is primarily an exercise in **browser-extension architecture, resilient DOM scraping, structured LLM prompting, and a zero-dependency module build pipeline**.

> **Disclaimer.** Built for educational and research purposes around browser automation and LLM integration. Using automated tools to complete graded academic work may violate your institution's academic-integrity policy. Use responsibly and at your own risk.

---

## What it does

1. Detects a Moodle quiz page and locates the active, unanswered question.
2. Extracts the question — preserving structure (tables, code blocks, LaTeX) by converting the relevant DOM subtree to Markdown.
3. Sends the question to the selected LLM in a separate tab with a strict prompt contract, and parses a single JSON answer block back out of the streamed response.
4. Fills the answer into the page per question type (multiple-choice, short answer, essay, CodeRunner code), then runs the quiz's check/precheck flow and navigates onward.

## Architecture

Four extension surfaces, each bundled into a single IIFE by esbuild:

| Surface | Role |
| --- | --- |
| `popup` | Launcher UI + error-log viewer |
| `background` | Service worker: tab lifecycle, message relay, screenshot capture |
| `content` | Runs on the LMS page: extraction, answer filling, quiz flow |
| `injector` | Runs on the LLM page: prompt injection + JSON response extraction |

The content script is split into focused modules:

```
src/
├── shared/
│   ├── util.js              escapeHtml, sleep (shared across surfaces)
│   ├── providers.js         LLM provider registry (Gemini / ChatGPT / Claude)
│   ├── session-keys.js      single source of truth for session-state keys
│   ├── session-guard.js     per-request identity (drops stale/late answers)
│   ├── solve-contract.js    shared prompt contract (tab + API paths)
│   ├── answer-parser.js     balanced-brace JSON extraction + normalization
│   ├── api-client.js        direct LLM API path (fetch, no tab)
│   └── id.js                opaque session/request id generator
└── content/
    ├── platform.js          Moodle & question-type detection (runtime, host-agnostic)
    ├── html-to-markdown.js  structure-preserving extraction (tables, code, MathJax → LaTeX)
    ├── ace-editor.js        CodeRunner / Ace editor integration
    ├── dom-utils.js         pure DOM helpers
    ├── question-images.js   image detection + composite-canvas stitching
    ├── moodle-options.js    single-source-of-truth option reading (index-aligned)
    ├── moodle-fill.js       per-type answer fillers
    ├── grading.js           precheck/CHECK result parsing (pass/fail) + selectors
    ├── session-stats.js     session summary aggregation
    └── index.js             flow engine + router + status UI
```

## Notable engineering details

- **Index-aligned answer filling.** Option text shown to the LLM is derived from the *same* input elements that get clicked, so the model's chosen index can be trusted as the primary signal rather than relying on fragile text matching.
- **Balanced-brace JSON extraction.** The LLM response is parsed with a string/escape-aware brace matcher instead of naive `lastIndexOf('}')`, so code answers full of `{}` parse correctly.
- **Verified fills.** CodeRunner fills read the editor back and compare before claiming success, instead of optimistically assuming a synthetic paste worked. The verify check rejects prefix-only matches and leftover template code, so stale partial fills can't masquerade as success.
- **Idempotent injection.** The content script is guarded so repeated injection never redeclares globals.
- **Circuit breaker.** A hard per-session cap on solve dispatches prevents runaway retry loops.
- **Per-request identity (anti-stale).** Every request carries an `sessionId`+`requestId`; handlers drop answers/retries that arrive late or after the user cancels, so a provider tab can't back-fill a stale answer onto the current question.
- **Single-source-of-truth config.** Session-state keys, CodeRunner result selectors, and the extension version all live in one place — no parallel lists that can silently drift out of sync.
- **Pluggable LLM backend.** All provider-specific config (URL, DOM selectors, host match) lives in one registry; the injector logic is generic and resolves the provider by host, so adding a backend is a config entry rather than a code change.
- **Least privilege + MV3 CSP friendly.** No clipboard permissions, no remote fonts, sender-validated message handlers.

## Build & load

```bash
npm install
npm run build      # bundles src/ → dist/
# or: npm run watch
```

Then in `chrome://extensions`: enable Developer Mode → **Load unpacked** → select the **`dist/`** folder (not the repo root).

## Test

```bash
npm test           # vitest run (happy-dom)
```

**195 unit tests** across pure/leaf modules: JSON extraction, HTML→Markdown,
question-type routing, Moodle detection, option alignment, answer fillers (incl.
XSS escaping + CodeRunner fill verification), DOM helpers, grading/precheck
parsing, session stats, and the provider registry. CI runs tests + build on every
push.

DOM-heavy modules that depend on a live Ace editor, canvas rendering, or real
Moodle markup (`ace-editor`, `question-images`, the flow engine) are intentionally
**not** unit-tested — happy-dom can't reproduce them faithfully, so they're verified
in a real browser instead.

## Documentation

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — design decisions and reasoning
- [CONTRIBUTING.md](CONTRIBUTING.md) — setup, build, test, conventions

## Tech

Vanilla JS (ES modules) · esbuild · vitest · Chrome Extensions Manifest V3 · no runtime dependencies.
