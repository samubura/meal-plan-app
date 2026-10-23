// Tests on real OCR output of the user's photos. The data and the expectations live in the
// git-ignored private/ folder (private/fixtures/expected.json), so these skip on a fresh clone.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parsePlan, daysFromReads } from '../app/lib.js';
import { decoderFor } from '../app/ocr.js';
import { score } from '../tools/score.mjs';

const dir = new URL('../private/fixtures/', import.meta.url);
const skip = !fs.existsSync(new URL('expected.json', dir)) && 'no private/ data';
const read = (f) => fs.readFileSync(new URL(f, dir), 'utf8');
const expected = skip ? {} : JSON.parse(read('expected.json'));
const truth = skip ? {} : JSON.parse(fs.readFileSync(new URL('../private/dataset/truth.json', import.meta.url)));

for (const f of ['ocr-full-plain.txt', 'ocr-meals-plain.txt']) {
  test(`parsePlan (whole-page fallback) on real OCR: ${f}`, { skip }, () => {
    const days = parsePlan(read(f));
    for (const [day, slot, text] of expected[f]) assert.match(days[day][slot], new RegExp(text), `${day} ${slot}`);
  });
}

// Real per-row readings saved by tools/ocr-bench.mjs --dump (regression guard on decoding).
test('daysFromReads on real OCR readings', { skip }, () => {
  for (const { f, reads } of JSON.parse(read('reads.json'))) {
    const days = daysFromReads(reads, [], { decode: decoderFor([]) });
    const sc = score(days, truth[f]), [slots, exact] = expected.reads[f];
    assert.ok(sc.slots >= slots && sc.exact >= exact, `${f}: ${sc.slots} slots, ${sc.exact} exact`);
    const w = expected.wholeDay;
    if (f === w.photo) {
      // No labels on that day, a single line: it fills both meals.
      assert.match(days[w.day].lunch, new RegExp(w.text, 'i'));
      assert.equal(days[w.day].dinner, days[w.day].lunch);
    }
  }
});
