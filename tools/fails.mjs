// Print rows whose pick is wrong, from a bench dump: node tools/fails.mjs dump.json
import fs from 'node:fs';
import { daysFromReads } from '../app/lib.js';
import { decodeLine } from '../app/ocr.js';
import { sim } from './score.mjs';
const truth = JSON.parse(fs.readFileSync(new URL('../private/dataset/truth.json', import.meta.url)));
for (const { f, reads } of JSON.parse(fs.readFileSync(process.argv[2]))) for (const r of reads) {
  const t = truth[f][r.day][r.slot === 'lunch' ? 0 : 1], got = daysFromReads(reads, [], { decode: decodeLine })[r.day][r.slot];
  if (sim(got, t) < 0.6) console.log(`${f.slice(17, 30).padEnd(13)} ${r.day} ${r.slot.padEnd(6)} ${r.found ? '     ' : 'NOLBL'} ink ${String(r.ink).padEnd(6)} got "${got}"  want "${t}"  tries: ${r.tries.map((x) => x.text).join(' | ')}`);
}
