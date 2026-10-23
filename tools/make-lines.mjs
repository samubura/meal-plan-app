// Training lines for tools/train/finetune.py: the exact line images the app reads, labelled from
// private/dataset/truth.json. Writes private/lines/*.pgm and private/lines/labels.tsv
// (file, label, photo, what the stock model reads).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ort from 'onnxruntime-node';
import { createWorker } from 'tesseract.js';
import { scanPlan, toPGM } from '../app/lib.js';
import { createRecognizer } from '../app/ocr.js';
import { load, files, truth, wrap } from './photos.mjs';

const root = path.dirname(path.dirname(new URL(import.meta.url).pathname));
const out = path.join(root, 'private', 'lines');
fs.mkdirSync(out, { recursive: true });
const m = path.join(root, 'app', 'models', 'latin_PP-OCRv5_mobile_rec');
const rec = await createRecognizer(ort, `${m}.onnx`, JSON.parse(fs.readFileSync(`${m}.dict.json`)), { logSeverityLevel: 3 });
const worker = await createWorker('ita+eng', 1, { cachePath: path.join(os.tmpdir(), 'mealplan-tessdata') });
const T = truth(), rows = [];
let current; // the row being read: onBand runs just before readLine
for (const f of files()) {
  const { rgba, w, h } = load(f);
  await scanPlan(rgba, w, h, wrap(worker), {
    readLine: async (img) => {
      const r = current;
      const name = `${f.replace(/\.jpg$/, '').replace(/[^\w-]+/g, '_')}__${r.day}-${r.slot}.pgm`;
      fs.writeFileSync(path.join(out, name), toPGM(img));
      const res = await rec.recognize(img);
      const label = T[f][r.day][r.slot === 'lunch' ? 0 : 1];
      if (label) rows.push([name, label, f, res.text].join('\t'));
      return res;
    },
    onBand: (r) => { current = r; },
  });
}
fs.writeFileSync(path.join(out, 'labels.tsv'), rows.join('\n') + '\n');
console.log(`${rows.length} lines in ${out}`);
await worker.terminate();
