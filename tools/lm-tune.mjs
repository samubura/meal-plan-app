// Compare decoders on saved stock-model readings (private/train/cv/stock-*.json, all 14 photos):
// old vocabulary bonus vs the word-pair model, with and without remembered dishes.
import fs from 'node:fs';
import { FOOD_WORDS, vocabFor } from '../app/lib.js';
import { decodeLine, decodeLineLM, makeLM, DECODE_LM } from '../app/ocr.js';
import { evaluate, loadDumps } from './eval.mjs';
import { truth as loadTruth } from './photos.mjs';

const truth = loadTruth();
const dumps = loadDumps([0, 1, 2, 3].map((k) => `private/train/cv/stock-${k}.json`));
const counts = fs.existsSync('private/food-it.json') ? JSON.parse(fs.readFileSync('private/food-it.json')) : { words: {}, pairs: {} }; // tools/build-lexicon.mjs
const empty = { words: {}, pairs: {} };
for (const personal of [false, true]) {
  console.log(`\n--- ${personal ? 'with' : 'without'} remembered dishes (leave-one-out)`);
  const cur = evaluate(dumps, truth, () => decodeLine, { personal });
  console.log(String(cur.exact).padStart(3), 'vocab bonus (current)'.padEnd(30) + cur.text);
  const grid = process.argv.includes('--grid');
  const lms = grid ? [0.5, 0.75, 1, 1.5] : [DECODE_LM.lm], oovs = grid ? [-16, -20, -25, -30, -40] : [DECODE_LM.oov];
  const rows = [];
  for (const [name, c] of [['food list only', empty], ['+ wikibooks', counts]]) for (const lm of lms) for (const oov of oovs) {
    const k = { ...DECODE_LM, lm, oov };
    const r = evaluate(dumps, truth, (f, dishes) => {
      const model = makeLM(c, vocabFor([]), dishes);
      return (frames, o) => decodeLineLM(frames, { ...o, lm: model, k });
    }, { personal });
    rows.push([r.exact, `${name.padEnd(15)} lm ${lm} oov ${oov}`.padEnd(30) + r.text]);
  }
  rows.sort((a, b) => b[0] - a[0]).slice(0, grid ? 6 : 9).forEach(([e, t]) => console.log(String(e).padStart(3), t));
}
