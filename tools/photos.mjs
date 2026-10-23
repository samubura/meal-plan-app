// Shared by the Node tools: dataset photos (git-ignored private/dataset) and a tesseract.js wrapper.
import fs from 'node:fs';
import path from 'node:path';
import jpeg from 'jpeg-js';
import { scaleGray } from '../app/lib.js';

// DATASET=dataset-full (env) uses the full-resolution originals of the same pages.
export const dir = path.join(path.dirname(path.dirname(new URL(import.meta.url).pathname)), 'private', process.env.DATASET || 'dataset');
export const truth = () => JSON.parse(fs.readFileSync(path.join(dir, 'truth.json'), 'utf8'));
export const files = (filter) => Object.keys(truth()).filter((f) => !filter || f.includes(filter));

// Same as the app: longest side scaled to 2200 px (the app does this with a canvas).
// DEGRADE=0.5 (env) first shrinks the photo to half size: how much does resolution matter?
export function load(file) {
  const src = jpeg.decode(fs.readFileSync(path.join(dir, file)), { useTArray: true });
  const deg = +(process.env.DEGRADE || 1);
  const ch = [0, 1, 2].map((c) => {
    let g = { gray: new Uint8Array(src.width * src.height), w: src.width, h: src.height };
    for (let i = 0; i < g.gray.length; i++) g.gray[i] = src.data[4 * i + c];
    if (deg !== 1) g = scaleGray(g, deg);
    return scaleGray(g, 2200 / Math.max(g.w, g.h));
  });
  const { w, h } = ch[0], rgba = new Uint8Array(w * h * 4).fill(255);
  for (let i = 0; i < w * h; i++) for (let c = 0; c < 3; c++) rgba[4 * i + c] = ch[c].gray[i];
  return { rgba, w, h };
}

export const wrap = (w) => async (pgm, psm, withWords) => {
  await w.setParameters({ tessedit_pageseg_mode: psm });
  const { data } = await w.recognize(Buffer.from(pgm), {}, { text: true, blocks: withWords });
  return { text: data.text, conf: data.confidence, words: withWords ? data.blocks.flatMap((b) => b.paragraphs.flatMap((p) => p.lines.flatMap((l) => l.words))) : [] };
};


// Same grouping as tools/train/finetune.py: the same page photographed twice stays in one fold.
const SAME = { 'photo_2026-10-23_13-36-08.jpg': 'photo_2026-10-23_13-36-01 (2).jpg' };
export function foldOf(photos, k = 4) {
  const groups = [...new Set(photos.map((p) => SAME[p] ?? p))].sort();
  return Object.fromEntries(photos.map((p) => [p, groups.indexOf(SAME[p] ?? p) % k]));
}
