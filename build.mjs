// Build script FLAB — bundle tiap surface ekstensi ke dist/ via esbuild.
// Jalankan: npm run build   (atau: npm run watch)
import * as esbuild from 'esbuild';
import { cp, mkdir, rm } from 'node:fs/promises';

const watch = process.argv.includes('--watch');
const outdir = 'dist';

// Entry point per surface. Tiap entry di-bundle jadi satu file IIFE mandiri.
const entryPoints = {
  content: 'src/content/index.js',
  background: 'src/background/index.js',
  popup: 'src/popup/index.js',
  'injectors/gemini': 'src/injector/index.js',
};

const buildOptions = {
  entryPoints,
  outdir,
  bundle: true,
  format: 'iife',        // bungkus tiap surface dalam closure → idempotensi & tanpa polusi global
  target: 'chrome110',
  logLevel: 'info',
  legalComments: 'none',
};

async function copyStatic() {
  // Aset yang tidak di-bundle: manifest + HTML popup.
  await cp('manifest.json', `${outdir}/manifest.json`);
  await cp('src/popup/popup.html', `${outdir}/popup.html`);
}

async function run() {
  await rm(outdir, { recursive: true, force: true });
  await mkdir(outdir, { recursive: true });

  if (watch) {
    const ctx = await esbuild.context(buildOptions);
    await ctx.watch();
    await copyStatic();
    console.log('[build] watching…');
  } else {
    await esbuild.build(buildOptions);
    await copyStatic();
    console.log('[build] selesai → dist/');
  }
}

run().catch(e => { console.error(e); process.exit(1); });
