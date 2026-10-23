// Compare decoders on saved stock-model readings (private/train/cv/stock-*.json, all 14 photos):
// grid over the decoder weights (ocr.js DECODE), with and without remembered dishes.
import fs from 'node:fs';
import { FOOD_WORDS, vocabFor } from '../app/lib.js';
import { decodeLine, makeLM, DECODE } from '../app/ocr.js';
import { evaluate, loadDumps } from './eval.mjs';
import { truth as loadTruth } from './photos.mjs';

const truth = loadTruth();
const dumps = loadDumps([0, 1, 2, 3].map((k) => `private/train/cv/stock-${k}.json`));
const empty = { words: {}, pairs: {} };
const counts = fs.existsSync('private/food-it.json') ? JSON.parse(fs.readFileSync('private/food-it.json')) : empty; // tools/build-lexicon.mjs
for (const personal of [false, true]) {
  console.log(`\n--- ${personal ? 'with' : 'without'} remembered dishes (leave-one-out)`);
  const grid = process.argv.includes('--grid');
  const lms = grid ? [0.25, 0.5, 0.75, 1] : [DECODE.lm], oovs = grid ? [-8, -12, -16, -20] : [DECODE.oov];
  const rows = [];
  for (const [name, c] of counts === empty ? [['food list', empty]] : [['food list', empty], ['+ wikibooks', counts]]) for (const lm of lms) for (const oov of oovs) for (const slash of grid ? [0, 2, 4] : [DECODE.slash]) {
    const k = { ...DECODE, lm, oov, slash };
    const r = evaluate(dumps, truth, (f, dishes) => {
      const model = makeLM(c, vocabFor([]), dishes);
      return (frames, o) => decodeLine(frames, { ...o, lm: model, k });
    }, { personal });
    rows.push([r.exact, `${name.padEnd(15)} lm ${lm} oov ${oov} slash ${slash}`.padEnd(38) + r.text]);
  }
  rows.sort((a, b) => b[0] - a[0]).slice(0, grid ? 6 : 9).forEach(([e, t]) => console.log(String(e).padStart(3), t));
}
