# Contributing to flab

Thanks for your interest. This document covers how to set up, build, test, and structure changes.

## Prerequisites

- Node.js 20+
- A Chromium-based browser (Chrome/Edge) for loading the extension

## Setup

```bash
npm install
```

## Build

The extension source lives in `src/` as ES modules. Chrome cannot load ES modules
directly as content scripts, so [esbuild](https://esbuild.github.io/) bundles each
surface into a single IIFE under `dist/`.

```bash
npm run build      # one-shot build → dist/
npm run watch      # rebuild on change
```

Load the **`dist/`** folder (not the repo root) via `chrome://extensions` →
Developer Mode → **Load unpacked**.

> `dist/` and `node_modules/` are git-ignored. Always run `npm run build` after
> editing `src/`, or Chrome will keep running the previous bundle.

## Test

```bash
npm test           # vitest run
```

Tests live in `tests/` and run under happy-dom. Pure, leaf-level modules
(`html-to-markdown`, `json-extract`) are unit-tested directly. The tightly-coupled
flow engine in `src/content/index.js` is verified by loading the extension in a
real browser — synthetic DOM cannot reproduce Moodle/Ace/Gemini behavior faithfully.

## Project layout

```
src/
├── shared/util.js            cross-surface helpers (escapeHtml, sleep)
├── background/index.js       service worker: tabs, message relay, capture
├── popup/                    launcher UI + error-log viewer
├── injector/                 runs on the LLM page
│   ├── index.js              prompt injection + response observation
│   └── json-extract.js       balanced-brace JSON extraction (unit-tested)
└── content/                  runs on the LMS page
    ├── platform.js           platform & question-type detection
    ├── html-to-markdown.js   structure-preserving extraction (unit-tested)
    ├── ace-editor.js         CodeRunner / Ace integration
    ├── dom-utils.js          pure DOM helpers
    ├── question-images.js    image detection + canvas stitching
    ├── moodle-options.js     index-aligned option reading
    ├── moodle-fill.js        per-type answer fillers
    └── index.js              flow engine + router + status UI
```

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the reasoning behind key design decisions.

## Conventions

- **Vanilla JS, ES modules, no runtime dependencies.** Keep it that way unless there's a strong reason.
- **Leaf modules stay pure** — they depend only on DOM globals or other leaves, never back into `index.js`. This one-way dependency is what keeps them unit-testable.
- **Verify before claiming success.** DOM injection (especially synthetic paste) can silently fail; read state back and confirm.
- **Escape all untrusted text** (LLM responses, page DOM) before inserting into `innerHTML`.

## Pull requests

1. `npm test` and `npm run build` must pass (CI enforces both).
2. Keep changes scoped; prefer small modules over growing `index.js`.
3. For changes touching the flow engine or fillers, describe how you verified them in a real quiz.
