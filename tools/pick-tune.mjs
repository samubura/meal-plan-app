// Offline tuning of pickDish weights on saved row readings (no OCR): node tools/pick-tune.mjs dump.json
import fs from 'node:fs';
import { daysFromReads } from '../app/lib.js';
import { score } from './score.mjs';

const truth = JSON.parse(fs.readFileSync(new URL('../private/dataset/truth.json', import.meta.url)));
const dump = JSON.parse(fs.readFileSync(process.argv[2]));
// --personal: leave-one-out personal dictionary (dishes from the truth of all *other* photos;
// the duplicate shot of the same page is excluded too).
const personal = process.argv.includes('--personal');
const same = { 'photo_2026-10-23_13-36-08.jpg': 'photo_2026-10-23_13-36-01 (2).jpg' };
const others = (f) => Object.keys(truth).filter((g) => g !== f && same[g] !== f && same[f] !== g).flatMap((g) => truth[g].flat()).filter(Boolean);
const evalK = (k) => {
  let slots = 0, exact = 0, sim = 0;
  for (const { f, reads } of dump) {
    const days = daysFromReads(reads, personal ? others(f) : [], { k });
    const s = score(days, truth[f]);
    slots += s.slots; exact += s.exact; sim += s.sim / dump.length;
  }
  return { slots, exact, sim: +sim.toFixed(3) };
};
const out = [];
for (const vocab of [0, 0.5, 1, 2]) for (const conf of [0, 0.05, 0.1, 0.2, 0.4]) for (const agree of [0, 2, 4, 8, 16])
  out.push({ vocab, conf, agree, ...evalK({ vocab, conf, agree }) });
out.sort((a, b) => b.slots + b.exact - a.slots - a.exact || b.sim - a.sim);
for (const o of out.slice(0, 12)) console.log(JSON.stringify(o));
console.log(personal ? 'personal dictionary (leave-one-out)' : 'no personal dictionary', 'current', JSON.stringify(evalK(undefined)));
