// End-to-end benchmark: runs scanPlan (the app's pipeline, same tesseract.js engine) on every photo
// in private/dataset/ and scores it against private/dataset/truth.json.
// Usage: node tools/ocr-bench.mjs [filter] [--log] [--dump=file.json] [--engine=tesseract|ppocr] [--lines=gray,bin,lum]
//   [--model=file.onnx] [--fold=k]  (only the photos of fold k of 4, as held out by tools/train/finetune.py)
//   --log   prints what OCR read per row;  --dump  saves all row readings for tools/pick-tune.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createWorker } from 'tesseract.js';
import { scanPlan, daysFromReads } from '../app/lib.js';
import { load, wrap, dir, foldOf } from './photos.mjs';
import { score } from './score.mjs';

const root = path.dirname(path.dirname(new URL(import.meta.url).pathname));
const truth = JSON.parse(fs.readFileSync(path.join(dir, 'truth.json'), 'utf8')); // dir: see photos.mjs DATASET
const filter = process.argv.slice(2).find((a) => !a.startsWith('--'));
const foldArg = process.argv.find((a) => a.startsWith('--fold='))?.slice(7);
const fold = foldArg != null && foldOf(Object.keys(truth));
const files = Object.keys(truth).filter((f) => (!filter || f.includes(filter)) && (!fold || fold[f] === +foldArg));

const cachePath = path.join(os.tmpdir(), 'mealplan-tessdata');
fs.mkdirSync(cachePath, { recursive: true });
const N = Math.min(4, os.cpus().length, files.length);
const workers = await Promise.all(Array.from({ length: N }, () => createWorker('ita+eng', 1, { cachePath })));

// --personal: leave-one-out personal dictionary (dishes from the other photos' truth).
const personal = process.argv.includes('--personal');
const same = { 'photo_2026-10-23_13-36-08.jpg': 'photo_2026-10-23_13-36-01 (2).jpg' };
const others = (f) => Object.keys(truth).filter((g) => g !== f && same[g] !== f && same[f] !== g).flatMap((g) => truth[g].flat()).filter(Boolean);
// --engine=ppocr: dishes read by PP-OCRv5 Latin (app/ocr.js); --lines=gray,bin,lum picks its input images.
const engine = process.argv.find((a) => a.startsWith('--engine='))?.slice(9) ?? 'ppocr';
const lineVariants = process.argv.find((a) => a.startsWith('--lines='))?.slice(8).split(',');
let readLine, decode, decoderFor;
if (engine === 'ppocr') {
  if (!process.argv.includes('--no-decode')) ({ decodeLine: decode, decoderFor } = await import('../app/ocr.js'));
  const ort = (await import('onnxruntime-node')).default;
  const { createRecognizer } = await import('../app/ocr.js');
  const m = path.join(root, 'app', 'models');
  const model = process.argv.find((a) => a.startsWith('--model='))?.slice(8) ?? path.join(m, 'latin_PP-OCRv5_mobile_rec.onnx');
  const rec = await createRecognizer(ort, model,
    JSON.parse(fs.readFileSync(path.join(m, 'latin_PP-OCRv5_mobile_rec.dict.json'))), { logSeverityLevel: 3 });
  readLine = (img) => rec.recognize(img);
}
// --tight='{"gapK":1.5}' crops each line to its ink (lib.js tighten) before reading.
const tightArg = process.argv.find((a) => a.startsWith('--tight'));
const tight = tightArg ? JSON.parse(tightArg.split('=')[1] || '{}') : undefined;
const queue = [...files], results = [];
await Promise.all(workers.map(async (w) => {
  for (let f; (f = queue.shift());) {
    const { rgba, w: W, h: H } = load(f);
    const t0 = Date.now();
    const r = await scanPlan(rgba, W, H, wrap(w), { readLine, decode, ...(lineVariants && { lineVariants }), tight });
    if (personal) r.days = daysFromReads(r.reads, others(f), { decode: decode && decoderFor(others(f)) });
    results.push({ f, ...r, ms: Date.now() - t0, ...score(r.days, truth[f]) });
  }
}));
await Promise.all(workers.map((w) => w.terminate()));

results.sort((a, b) => a.f.localeCompare(b.f));
console.log(`${'photo'.padEnd(36)} layout slots exact  sim   sec`);
for (const r of results) console.log(`${r.f.padEnd(36)} ${String(r.layout).padEnd(6)} ${String(r.slots).padStart(5)} ${String(r.exact).padStart(5)} ${r.sim.toFixed(2)} ${(r.ms / 1000).toFixed(1).padStart(5)}`);
const sum = (k) => results.reduce((a, r) => a + r[k], 0);
console.log(`TOTAL ${results.length} photos: slots ${sum('slots')}/${14 * results.length}, exact ${sum('exact')}/${14 * results.length}, sim ${(sum('sim') / results.length).toFixed(3)}, perfect-slot pages ${results.filter((r) => r.slots === 14).length}`);
if (process.argv.includes('--log')) for (const r of results) {
  console.log(`\n=== ${r.f}`);
  r.days.forEach((d, i) => console.log(`  ${i} L: ${d.lunch.padEnd(34)} [${truth[r.f][i][0]}]\n    D: ${d.dinner.padEnd(34)} [${truth[r.f][i][1]}]`));
  for (const x of r.reads) console.log(`    ${x.day} ${x.slot}${x.found ? '' : ' (no label)'} ink ${x.ink}: ${(x.tries || []).map((t) => `${t.text} (${Math.round(t.conf)})`).join(' | ')}`);
}
const dump = process.argv.find((a) => a.startsWith('--dump='))?.slice(7);
if (dump) fs.writeFileSync(dump, JSON.stringify(results.map((r) => ({ f: r.f, reads: r.reads }))));
