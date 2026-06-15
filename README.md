# flab

[![CI](https://github.com/marcelino-ds/flab/actions/workflows/ci.yml/badge.svg)](https://github.com/marcelino-ds/flab/actions/workflows/ci.yml)

A Chrome **Manifest V3** extension that automates answering Moodle-based online quizzes by routing question content through an LLM (Google Gemini) and filling answers back into the page.

This project is primarily an exercise in **browser-extension architecture, resilient DOM scraping, structured LLM prompting, and a zero-dependency module build pipeline**.

> **Disclaimer.** Built for educational and research purposes around browser automation and LLM integration. Using automated tools to complete graded academic work may violate your institution's academic-integrity policy. Use responsibly and at your own risk.

---

## What it does

1. Detects a Moodle quiz page and locates the active, unanswered question.
2. Extracts the question — preserving structure (tables, code blocks, LaTeX) by converting the relevant DOM subtree to Markdown.
3. Sends the question to Gemini in a separate tab with a strict prompt contract, and parses a single JSON answer block back out of the streamed response.
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
├── shared/util.js          escapeHtml, sleep (shared across surfaces)
└── content/
    ├── platform.js          platform & question-type detection
    ├── html-to-markdown.js  structure-preserving extraction (tables, code, MathJax → LaTeX)
    ├── ace-editor.js         CodeRunner / Ace editor integration
    ├── dom-utils.js          pure DOM helpers
    ├── question-images.js    image detection + composite-canvas stitching
    ├── moodle-options.js     single-source-of-truth option reading (index-aligned)
    ├── moodle-fill.js        per-type answer fillers
    └── index.js              flow engine + router + status UI
```

## Notable engineering details

- **Index-aligned answer filling.** Option text shown to the LLM is derived from the *same* input elements that get clicked, so the model's chosen index can be trusted as the primary signal rather than relying on fragile text matching.
- **Balanced-brace JSON extraction.** The LLM response is parsed with a string/escape-aware brace matcher instead of naive `lastIndexOf('}')`, so code answers full of `{}` parse correctly.
- **Verified fills.** CodeRunner fills read the editor back and compare before claiming success, instead of optimistically assuming a synthetic paste worked.
- **Idempotent injection.** The content script is guarded so repeated injection never redeclares globals.
- **Circuit breaker.** A hard per-session cap on solve dispatches prevents runaway retry loops.
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

**82 unit tests** across 9 pure/leaf modules: JSON extraction, HTML→Markdown,
question-type routing, option alignment, answer fillers (incl. XSS escaping),
DOM helpers, and the provider registry. CI runs tests + build on every push.

DOM-heavy modules that depend on a live Ace editor, canvas rendering, or real
Moodle markup (`ace-editor`, `question-images`, the flow engine) are intentionally
**not** unit-tested — happy-dom can't reproduce them faithfully, so they're verified
in a real browser instead.

## Documentation

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — design decisions and reasoning
- [CONTRIBUTING.md](CONTRIBUTING.md) — setup, build, test, conventions

## Tech

Vanilla JS (ES modules) · esbuild · vitest · Chrome Extensions Manifest V3 · no runtime dependencies.
