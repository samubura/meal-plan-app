// Contact sheet of every dish line image the pipeline reads, one PGM per photo in OUT_DIR.
// Usage: node tools/crops.mjs OUT_DIR [filter]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createWorker } from 'tesseract.js';
import { scanPlan, toPGM } from '../app/lib.js';
import { load, files, wrap } from './photos.mjs';

const [out, filter] = process.argv.slice(2);
fs.mkdirSync(out, { recursive: true });
const worker = await createWorker('ita+eng', 1, { cachePath: path.join(os.tmpdir(), 'mealplan-tessdata') });
for (const f of files(filter)) {
  const { rgba, w, h } = load(f);
  const bands = [];
  await scanPlan(rgba, w, h, wrap(worker), { readLine: async () => ({ text: '', conf: 0 }), lineVariants: ['gray'], onBand: (r, b) => bands.push(b) });
  // Stack bands, each scaled to 64 px high, 6 px gray gap.
  const rows = bands.map((b) => { const s = 64 / b.h, W = Math.round(b.w * s), g = new Uint8Array(W * 64);
    for (let y = 0; y < 64; y++) for (let x = 0; x < W; x++) g[y * W + x] = b.gray[Math.min(b.h - 1, Math.floor(y / s)) * b.w + Math.min(b.w - 1, Math.floor(x / s))];
    return { gray: g, w: W, h: 64 }; });
  const W = Math.max(...rows.map((r) => r.w)), H = rows.length * 70, sheet = new Uint8Array(W * H).fill(128);
  rows.forEach((r, i) => { for (let y = 0; y < 64; y++) sheet.set(r.gray.subarray(y * r.w, (y + 1) * r.w), (i * 70 + y) * W); });
  fs.writeFileSync(path.join(out, f.replace(/\.jpg$/, '.pgm')), toPGM({ gray: sheet, w: W, h: H }));
}
await worker.terminate();
