// Build script FLAB — bundle tiap surface ekstensi ke dist/ via esbuild.
// Jalankan: npm run build   (atau: npm run watch)
import * as esbuild from 'esbuild';
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';

const watch = process.argv.includes('--watch');
const outdir = 'dist';

// Satu sumber versi: package.json. Dengan men-stamp versi ke manifest & popup saat
// build, kita tak perlu merawat "2.x.y" di 3 tempat berbeda (sumber bug diam-diam
// saat lupa update salah satu).
const require = createRequire(import.meta.url);
const { version } = require('./package.json');

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

// Stamp versi ke sebuah string berdasar pola. Ganti hanya pada penanda versi yang
// spesifik (bukan angka lain), agar aman untuk teks sembarang di manifest/HTML.
function stampVersion(text) {
  // manifest.json → '"version": "<versi lama>"'
  let out = text.replace(/("version"\s*:\s*")\d+\.\d+\.\d+(")/, `$1${version}$2`);
  // popup.html → '<div class="version">v<x.y.z></div>'
  out = out.replace(/(<div class="version">v)\d+\.\d+\.\d+(<\/div>)/, `$1${version}$2`);
  return out;
}

async function copyStatic() {
  // Aset yang tidak di-bundle: manifest + HTML popup. Versi di-stamp dari package.json.
  const [manifestSrc, popupSrc] = await Promise.all([
    readFile('manifest.json', 'utf8'),
    readFile('src/popup/popup.html', 'utf8'),
  ]);
  await Promise.all([
    writeFile(`${outdir}/manifest.json`, stampVersion(manifestSrc), 'utf8'),
    writeFile(`${outdir}/popup.html`, stampVersion(popupSrc), 'utf8'),
  ]);
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
