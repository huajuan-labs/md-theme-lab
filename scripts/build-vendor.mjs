// Bundle / copy third-party libs that the page or shells need at runtime.
// Self-hosted to avoid CDN reliability issues (BootCDN doesn't carry every
// package, jsdelivr/unpkg are cross-region and sometimes slow in China).
//
// Output:
//   demo/public/vendor/sucrase.min.js    — JSX transpiler (~200KB)
//   demo/public/vendor/morphdom.min.js   — DOM diff (~10KB)
//   demo/public/vendor/marked.min.js     — Markdown parser (~35KB)
//   demo/public/vendor/purify.min.js     — HTML sanitizer (~21KB)
//   demo/public/vendor/lucide.min.js     — Icon library for the main site (~45KB)
//
// Run once: `npm run build:vendor` — outputs are committed.

import { build } from 'esbuild';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoDir = path.resolve(__dirname, '..');
const outDir = path.resolve(repoDir, 'public/vendor');
fs.mkdirSync(outDir, { recursive: true });

// 1. Sucrase — bundle as IIFE exposing window.Sucrase.
await build({
  stdin: {
    contents: `
      import * as Sucrase from 'sucrase';
      globalThis.Sucrase = Sucrase;
    `,
    resolveDir: repoDir,
    loader: 'js',
  },
  bundle: true,
  format: 'iife',
  minify: true,
  target: ['es2018'],
  platform: 'browser',
  outfile: path.join(outDir, 'sucrase.min.js'),
  legalComments: 'none',
});
console.log(`built sucrase.min.js — ${(fs.statSync(path.join(outDir, 'sucrase.min.js')).size / 1024).toFixed(1)} KB`);

// 2. morphdom — copy the prebuilt UMD straight from node_modules.
function copyVendor(srcRel, dstName) {
  const src = path.resolve(repoDir, 'node_modules', srcRel);
  const dst = path.join(outDir, dstName);
  fs.copyFileSync(src, dst);
  console.log(`copied ${dstName} — ${(fs.statSync(dst).size / 1024).toFixed(1)} KB`);
}
copyVendor('morphdom/dist/morphdom-umd.min.js', 'morphdom.min.js');
copyVendor('marked/marked.min.js',              'marked.min.js');
copyVendor('dompurify/dist/purify.min.js',      'purify.min.js');

// 3. Lucide — main site only needs a handful of icons; the full UMD is ~400 KB
// (1500+ icons). Tree-shake an ES-module subset into a small IIFE that exposes
// the same `window.lucide.{icons, createIcons}` API the UMD provides.
// Artifacts load the full library from CDN — see artifact-runtime.js.
const SITE_ICONS = [
  'plus', 'menu', 'x',
  'message-circle',
  'file-text', 'globe', 'atom', 'image', 'code', 'file',
  'arrow-up-right', 'download', 'maximize-2', 'minimize-2',
  'send',
  'copy', 'check',
];
const toPascal = (s) => s.split('-').map((p) => p[0].toUpperCase() + p.slice(1)).join('');
const lucideEntry = `
  import { createIcons, ${SITE_ICONS.map(toPascal).join(', ')} } from 'lucide';
  globalThis.lucide = {
    createIcons,
    icons: { ${SITE_ICONS.map((n) => `${toPascal(n)}: ${toPascal(n)}`).join(', ')} },
  };
`;
await build({
  stdin: { contents: lucideEntry, resolveDir: repoDir, loader: 'js' },
  bundle: true, format: 'iife', minify: true,
  target: ['es2018'], platform: 'browser',
  outfile: path.join(outDir, 'lucide.min.js'),
  legalComments: 'none',
});
console.log(`built lucide.min.js (${SITE_ICONS.length} icons) — ${(fs.statSync(path.join(outDir, 'lucide.min.js')).size / 1024).toFixed(1)} KB`);
