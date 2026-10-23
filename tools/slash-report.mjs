// How dishes written with "/" (or --sym=+) come out (saved stock readings, private/train/cv/stock-*.json).
import { daysFromReads, norm } from '../app/lib.js';
import { decoderFor } from '../app/ocr.js';
import { loadDumps } from './eval.mjs';
import { truth as loadTruth } from './photos.mjs';

const truth = loadTruth(), key = (s) => norm(s).replace(/[^a-z0-9/+]+/g, ' ').replace(/\s*([/+])\s*/g, ' $1 ').trim();
const SYM = process.argv.find((a) => a.startsWith('--sym='))?.slice(6) ?? '/';
const SAME = { 'photo_2026-10-23_13-36-08.jpg': 'photo_2026-10-23_13-36-01 (2).jpg' };
let n = 0, exact = 0, slash = 0;
for (const { f, reads } of loadDumps([0, 1, 2, 3].map((k) => `private/train/cv/stock-${k}.json`))) {
  const others = Object.keys(truth).filter((g) => g !== f && SAME[g] !== f && SAME[f] !== g).flatMap((g) => truth[g].flat()).filter(Boolean);
  const days = daysFromReads(reads, process.argv.includes('--personal') ? others : [], { decode: decoderFor(process.argv.includes('--personal') ? others : []) });
  truth[f].forEach((d, i) => d.forEach((want, j) => {
    if (!want.includes(SYM)) return;
    const got = days[i][j ? 'dinner' : 'lunch'], raw = reads.find((r) => r.day === i && r.slot === (j ? 'dinner' : 'lunch'))?.tries[0]?.text;
    n++; exact += key(got) === key(want); slash += got.includes(SYM);
    if (process.argv.includes('--list')) console.log(`${key(got) === key(want) ? 'OK ' : '   '} ${want.padEnd(34)} got ${JSON.stringify(got).padEnd(34)} raw ${JSON.stringify(raw)}`);
  }));
}
console.log(`dishes with "${SYM}": ${n}, exact ${exact}, output has a "${SYM}" in ${slash}`);
