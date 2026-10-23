// Held-out comparison: stock vs fine-tuned recognizer, each fold scored only on photos its model
// never trained on. "seen" = dish also written on that fold's training photos, "new" = not.
//   node tools/cv-report.mjs DIR   (DIR/stock-K.json, DIR/tuned-K.json from ocr-bench --fold=K --dump=...)
import fs from 'node:fs';
import path from 'node:path';
import { decoderFor } from '../app/ocr.js';
import { evaluate } from './eval.mjs';
import { truth as loadTruth, foldOf } from './photos.mjs';

const dir = process.argv[2], truth = loadTruth(), fold = foldOf(Object.keys(truth));
for (const personal of [false, true]) {
  console.log(`--- ${personal ? 'with' : 'without'} remembered dishes (leave-one-out)`);
  for (const model of ['stock', 'tuned']) {
    const dumps = [0, 1, 2, 3].flatMap((k) => {
      const f = path.join(dir, `${model}-${k}.json`);
      return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f)) : [];
    });
    if (!dumps.length) continue;
    const seenFrom = (f) => Object.keys(truth).filter((g) => fold[g] !== fold[f]);
    const r = evaluate(dumps, truth, (f, dishes) => decoderFor(dishes), { personal, seenFrom });
    console.log(`${model.padEnd(6)} ${dumps.length} photos  ${r.exact} exact  ${r.text}`);
  }
}
