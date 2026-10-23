// Scoring shared by the bench tools. truth: [[lunch, dinner] x 7].
import { norm, lev } from '../app/lib.js';

// Slashes count ("pizza / mamma" is not "pizza mamma"); other punctuation and case don't.
const words = (s) => norm(s).replace(/[^a-z0-9/]+/g, ' ').replace(/\s*\/\s*/g, ' / ').trim();
export const sim = (a, b) => { a = words(a); b = words(b); return a || b ? 1 - lev(a, b) / Math.max(a.length, b.length) : 1; };

// slots: meal is closer to its own true dish than to any other dish on the page (>= 0.35 similar).
export function score(days, truth) {
  const flat = truth.flat();
  let slots = 0, exact = 0, simSum = 0;
  days.forEach((d, i) => ['lunch', 'dinner'].forEach((k, j) => {
    const got = d[k], idx = i * 2 + j, sims = flat.map((x) => sim(got, x));
    if (got && sims[idx] >= 0.35 && sims[idx] === Math.max(...sims)) slots++;
    if (words(got) === words(flat[idx])) exact++;
    simSum += sims[idx];
  }));
  return { slots, exact, sim: simSum / 14 };
}
