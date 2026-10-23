// Accuracy of the optional Gemini reading on private/dataset (sends the photos to Google!).
// Key in private/gemini.key. Usage: node tools/gemini-bench.mjs [--personal] [--model=models/...] [filter]
//   --personal: give Gemini the dishes of the *other* pages as spelling hints (what the app does).
import fs from 'node:fs';
import path from 'node:path';
import { readPlanWithGemini, pickModel } from '../app/gemini.js';
import { score, sim } from './score.mjs';
import { dir, truth as loadTruth } from './photos.mjs';

const root = path.dirname(path.dirname(new URL(import.meta.url).pathname));
const key = fs.readFileSync(path.join(root, 'private', 'gemini.key'), 'utf8').trim();
const truth = loadTruth();
const personal = process.argv.includes('--personal');
const filter = process.argv.slice(2).find((a) => !a.startsWith('--'));
const SAME = { 'photo_2026-10-23_13-36-08.jpg': 'photo_2026-10-23_13-36-01 (2).jpg' };
const others = (f) => Object.keys(truth).filter((g) => g !== f && SAME[g] !== f && SAME[f] !== g).flatMap((g) => truth[g].flat()).filter(Boolean);
const model = process.argv.find((a) => a.startsWith('--model='))?.slice(8) ?? await pickModel(key);
console.log('model:', model);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let slots = 0, exact = 0, simSum = 0, n = 0, out = [];
for (const f of Object.keys(truth).filter((x) => !filter || x.includes(filter))) {
  const jpeg = fs.readFileSync(path.join(dir, f)).toString('base64');
  let res;
  for (let attempt = 0; ; attempt++) {
    try { res = await readPlanWithGemini(key, jpeg, { model, dishes: personal ? [...new Set(others(f))] : [] }); break; } catch (e) {
      if (e.status === 429 && attempt < 4) { console.log('  rate limited, waiting 60 s'); await sleep(60_000); continue; }
      throw e;
    }
  }
  const s = score(res.days, truth[f]);
  slots += s.slots; exact += s.exact; simSum += s.sim; n++;
  console.log(`${f.padEnd(36)} slots ${String(s.slots).padStart(2)} exact ${String(s.exact).padStart(2)} sim ${s.sim.toFixed(2)}`);
  res.days.forEach((d, i) => ['lunch', 'dinner'].forEach((k, j) => {
    const want = truth[f][i][j];
    if (sim(d[k], want) < 1) out.push(`   ${f.slice(17, 30).padEnd(13)} ${i} ${k.padEnd(6)} got ${JSON.stringify(d[k]).padEnd(36)} want ${JSON.stringify(want)}`);
  }));
  await sleep(13_000); // free tier: a few requests per minute
}
console.log(`TOTAL ${n} photos: slots ${slots}/${14 * n}, exact ${exact}/${14 * n}, sim ${(simSum / n).toFixed(3)}`);
if (process.argv.includes('--log')) console.log(out.join('\n'));
