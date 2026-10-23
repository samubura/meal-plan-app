// Re-score saved readings (bench dumps with frames) with a decoder, no OCR:
// totals for dishes that also appear on other photos ("seen") and ones that don't ("new").
import fs from 'node:fs';
import { daysFromReads, norm } from '../app/lib.js';
import { sim } from './score.mjs';

const key = (s) => norm(s).replace(/[^a-z0-9/]+/g, ' ').replace(/\s*\/\s*/g, ' / ').trim();
const SAME = { 'photo_2026-10-23_13-36-08.jpg': 'photo_2026-10-23_13-36-01 (2).jpg' };
const sameSet = (f, g) => f === g || SAME[f] === g || SAME[g] === f;

// dumps: [{f, reads}]; decodeFor(f) -> decode function for photo f; personal: leave-one-out dishes.
export function evaluate(dumps, truth, decodeFor, { personal = false, seenFrom } = {}) {
  const tot = { seen: { n: 0, exact: 0, sim: 0 }, new: { n: 0, exact: 0, sim: 0 }, slots: 0 };
  for (const { f, reads } of dumps) {
    const others = Object.keys(truth).filter((g) => !sameSet(f, g));
    const dishes = personal ? others.flatMap((g) => truth[g].flat()).filter(Boolean) : [];
    const seen = new Set((seenFrom ? seenFrom(f) : others).flatMap((g) => truth[g].flat()).map(key));
    const days = daysFromReads(reads, dishes, { decode: decodeFor(f, dishes) });
    truth[f].forEach((d, i) => d.forEach((want, j) => {
      if (!want) return;
      const got = days[i][j ? 'dinner' : 'lunch'], t = tot[seen.has(key(want)) ? 'seen' : 'new'];
      t.n++; t.exact += key(got) === key(want); t.sim += sim(got, want);
      // slot: own dish closer than any other dish of the page
      const sims = truth[f].flat().map((x) => sim(got, x));
      if (got && sims[i * 2 + j] >= 0.35 && sims[i * 2 + j] === Math.max(...sims)) tot.slots++;
    }));
  }
  const fmt = (t) => `exact ${String(t.exact).padStart(3)}/${t.n} (${Math.round((100 * t.exact) / t.n)}%) sim ${(t.sim / t.n).toFixed(3)}`;
  return { ...tot, exact: tot.seen.exact + tot.new.exact, text: `slots ${tot.slots}  seen ${fmt(tot.seen)}  new ${fmt(tot.new)}` };
}

export const loadDumps = (files) => files.flatMap((p) => (fs.existsSync(p) ? JSON.parse(fs.readFileSync(p)) : []));
