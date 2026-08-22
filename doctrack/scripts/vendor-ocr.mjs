/**
 * Copies the on-device OCR engine out of node_modules and into public/, so the
 * app serves it from its own origin.
 *
 * Left to itself, tesseract.js fetches its worker, its WebAssembly core and its
 * language data from a CDN at runtime. That would put a third party in the path
 * of every document read, break the offline promise, and mean the "nothing
 * leaves your device" claim depended on someone else's uptime. Vendoring the
 * files costs ~15 MB of build output, of which a browser downloads about 7 MB
 * once and then caches.
 *
 * Runs from `npm run prebuild` and `postinstall`, so a fresh clone and a
 * deployment both get it without anyone remembering to.
 */
import { cpSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'public', 'tesseract');

// Only the LSTM variants: the worker is created with OEM 1 (LSTM_ONLY), and it
// feature-detects which of these three the browser can run.
const files = [
  ['tesseract.js/dist/worker.min.js', 'worker.min.js'],
  ['tesseract.js-core/tesseract-core-lstm.wasm.js', 'tesseract-core-lstm.wasm.js'],
  ['tesseract.js-core/tesseract-core-simd-lstm.wasm.js', 'tesseract-core-simd-lstm.wasm.js'],
  [
    'tesseract.js-core/tesseract-core-relaxedsimd-lstm.wasm.js',
    'tesseract-core-relaxedsimd-lstm.wasm.js',
  ],
  // "best_int" is the integer-quantised model: a third of the size of the full
  // one and no worse on the printed text these documents are made of.
  ['@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz', 'eng.traineddata.gz'],
];

// pdf.js needs its worker served from our own origin for the same reason.
const rootFiles = [['pdfjs-dist/build/pdf.worker.min.mjs', 'pdf.worker.min.mjs']];

mkdirSync(out, { recursive: true });

let copied = 0;
let bytes = 0;
for (const [from, to] of files) {
  const source = join(root, 'node_modules', from);
  if (!existsSync(source)) {
    console.warn(`[vendor-ocr] missing ${from} — on-device reading will fall back to the CDN`);
    continue;
  }
  const target = join(out, to);
  cpSync(source, target);
  copied += 1;
  bytes += statSync(target).size;
}

for (const [from, to] of rootFiles) {
  const source = join(root, 'node_modules', from);
  if (!existsSync(source)) {
    console.warn(`[vendor-ocr] missing ${from} — PDF reading will not work`);
    continue;
  }
  const target = join(root, 'public', to);
  cpSync(source, target);
  copied += 1;
  bytes += statSync(target).size;
}

console.log(
  `[vendor-ocr] ${copied}/${files.length + rootFiles.length} files → public (${(bytes / 1e6).toFixed(1)} MB)`,
);
