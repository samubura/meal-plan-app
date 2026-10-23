// Line recognizer: PaddleOCR PP-OCRv5 Latin (CTC) run with onnxruntime. Pure apart from the injected
// `ort` module (onnxruntime-web in the browser, onnxruntime-node in tools), so both share this file.
import { lev, matchMeal, FOOD_WORDS } from './lib.js';

const H = 48;

// gray line image {gray, w, h} -> NCHW float tensor data, height 48, normalised to [-1, 1].
export function toTensor({ gray, w, h }, maxW = 1600) {
  const W = Math.max(16, Math.min(maxW, Math.round((w * H) / h)));
  const data = new Float32Array(3 * H * W);
  for (let y = 0; y < H; y++) {
    const sy = Math.min(h - 1, ((y + 0.5) * h) / H - 0.5), y0 = Math.max(0, Math.floor(sy)), y1 = Math.min(h - 1, y0 + 1), fy = Math.max(0, sy - y0);
    for (let x = 0; x < W; x++) {
      const sx = Math.min(w - 1, ((x + 0.5) * w) / W - 0.5), x0 = Math.max(0, Math.floor(sx)), x1 = Math.min(w - 1, x0 + 1), fx = Math.max(0, sx - x0);
      const v = (gray[y0 * w + x0] * (1 - fx) + gray[y0 * w + x1] * fx) * (1 - fy) + (gray[y1 * w + x0] * (1 - fx) + gray[y1 * w + x1] * fx) * fy;
      const n = v / 127.5 - 1;
      data[y * W + x] = data[H * W + y * W + x] = data[2 * H * W + y * W + x] = n;
    }
  }
  return { data, W };
}

// Class 0 = CTC blank, class k+1 = dict[k], last class = space.
export const charsFor = (dict) => ['', ...dict, ' '];

// Greedy CTC decode of probs (T x C, row-major).
export function greedy(probs, T, C, chars) {
  let out = '', prev = -1, conf = 0, n = 0;
  for (let t = 0; t < T; t++) {
    let best = 0, bp = -1;
    for (let c = 0; c < C; c++) if (probs[t * C + c] > bp) { bp = probs[t * C + c]; best = c; }
    if (best !== prev && best !== 0) { out += chars[best]; conf += bp; n++; }
    prev = best;
  }
  return { text: out.replace(/\s+/g, ' ').trim(), conf: n ? (100 * conf) / n : 0 };
}

// ort: onnxruntime module; model: ArrayBuffer/Uint8Array (or path in Node); dict: array of chars.
export async function createRecognizer(ort, model, dict, sessionOptions = {}) {
  const session = await ort.InferenceSession.create(model, sessionOptions);
  const chars = charsFor(dict);
  return {
    chars,
    async recognize(img) {
      const { data, W } = toTensor(img);
      const out = await session.run({ [session.inputNames[0]]: new ort.Tensor('float32', data, [1, 3, H, W]) });
      const t = out[session.outputNames[0]];
      const [, T, C] = t.dims;
      return { ...greedy(t.data, T, C, chars), frames: toFrames(t.data, T, C, chars) };
    },
    release: () => session.release?.(),
  };
}

// ---- Vocabulary-aware decoding ----
// A line's output is kept as frames: per time step the top-k characters, lowercased and without
// accents (their probabilities summed), so candidates are scored case/accent-insensitively.
// '' is the CTC blank, ' ' the space. Small enough to store in bench dumps.

const fold = (c) => c.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

export function toFrames(probs, T, C, chars, k = 10) {
  const frames = [];
  for (let t = 0; t < T; t++) {
    const row = probs.subarray ? probs.subarray(t * C, (t + 1) * C) : probs.slice(t * C, (t + 1) * C);
    const idx = [...row.keys()].sort((a, b) => row[b] - row[a]).slice(0, k);
    const f = {};
    for (const i of idx) { const ch = fold(chars[i]); f[ch] = (f[ch] || 0) + row[i]; }
    frames.push(f);
  }
  return frames;
}

const FLOOR = 1e-5; // probability of a character outside a frame's top-k
const lp = (f, ch) => Math.log(f[ch] ?? FLOOR);
const logAdd = (a, b) => (a === -Infinity ? b : b === -Infinity ? a : Math.max(a, b) + Math.log1p(Math.exp(-Math.abs(a - b))));

// log P(text | frames[t0..t1)) under CTC (forward algorithm). text: folded string.
export function ctcLogP(frames, text, t0 = 0, t1 = frames.length) {
  const L = [...text], S = 2 * L.length + 1;
  if (t1 - t0 < 1) return -Infinity;
  const lab = (s) => (s % 2 ? L[(s - 1) / 2] : '');
  let a = new Array(S).fill(-Infinity);
  a[0] = lp(frames[t0], '');
  if (S > 1) a[1] = lp(frames[t0], lab(1));
  for (let t = t0 + 1; t < t1; t++) {
    const b = new Array(S).fill(-Infinity);
    for (let s = 0; s < S; s++) {
      let v = a[s];
      if (s > 0) v = logAdd(v, a[s - 1]);
      if (s > 1 && s % 2 && lab(s) !== lab(s - 2)) v = logAdd(v, a[s - 2]);
      if (v > -Infinity) b[s] = v + lp(frames[t], lab(s));
    }
    a = b;
  }
  return S > 1 ? logAdd(a[S - 1], a[S - 2]) : a[0];
}

// Best path, with the frame span of each word: [{word, t0, t1}] (spans include surrounding blanks).
export function greedyWords(frames) {
  const best = frames.map((f) => Object.entries(f).reduce((a, b) => (b[1] > a[1] ? b : a))[0]);
  const words = [];
  let cur = null, prev = null, lastSpace = -1;
  best.forEach((ch, t) => {
    if (ch === ' ') {
      if (cur) { cur.t1 = t; words.push(cur); cur = null; }
      lastSpace = t;
    } else if (ch !== '') {
      if (!cur) cur = { word: '', t0: lastSpace + 1, t1: frames.length };
      if (ch !== prev) cur.word += ch;
    }
    if (ch !== prev || ch === '') prev = ch === '' ? null : ch;
  });
  if (cur) words.push(cur);
  return words;
}

// Decoding weights (log-probability units). ponytail: tuned on private/dataset (tools/decode-tune.mjs).
export const DECODE = { edit: 0.34, bonus: 12, split: 0, dish: 8 };

const core = (w) => w.replace(/(^|[a-z])2(?=[a-z])/g, '$1z').replace(/[0-9]/g, (d) => ({ 0: 'o', 1: 'i', 4: 'a', 5: 's', 8: 'b' })[d] ?? d).replace(/[^a-z]/g, '');
const near = (c, V, maxD) => V.filter(([, f]) => Math.abs(f.length - c.length) <= maxD && lev(c, f) <= maxD);
const SHORT = new Set(['e', 'o', 'a', 'al', 'ai', 'da', 'di', 'in', 'la', 'le', 'lo', 'il', 'con', 'col', 'per', 'del']);

// frames -> dish text. vocab: words (FOOD_WORDS + remembered); dishes: remembered whole dishes.
// Each word of the best path is replaced by the vocabulary word (or two words, if they ran together)
// that the model itself finds likely enough; then a remembered dish wins if it explains the whole line.
export function decodeLine(frames, { vocab = [], dishes = [], k = DECODE, original = '' } = {}) {
  const V = vocab.map((v) => [v, fold(v)]), known = new Set(V.map(([, f]) => f));
  let words = greedyWords(frames);
  // Label fragment ("cena:", "n20:") at the start belongs to the label column.
  if (words.length > 1 && /[:.;-]$/.test(words[0].word) && (matchMeal(words[0].word) || core(words[0].word).length <= 4)) words = words.slice(1);
  const caseOf = new Map(original.split(/\s+/).map((w) => [fold(w), w]));
  const out = [];
  for (const w of words) {
    const raw = w.word, c = core(raw);
    if (/^[|l1/]$/.test(raw)) { out.push('/'); continue; }
    if (!c || /^x\d$/.test(raw)) { out.push(raw); continue; }
    const pre = raw.match(/^[^a-z0-9]*/)[0], post = raw.match(/[^a-z0-9]*$/)[0];
    const score = (t) => ctcLogP(frames, pre + t + post, w.t0, w.t1);
    let best = { text: caseOf.get(raw) ?? raw, s: score(c) + (known.has(c) ? k.bonus : 0) };
    const maxD = Math.max(1, Math.ceil(c.length * k.edit));
    for (const [v, f] of near(c, V, maxD)) {
      const s = score(f) + k.bonus;
      if (s > best.s) best = { text: v, s };
    }
    if (c.length >= 5) for (let i = 1; i < c.length; i++) {
      const L = c.slice(0, i), R = c.slice(i);
      const ls = SHORT.has(L) ? [[L, L]] : L.length >= 3 ? near(L, V, Math.max(1, Math.ceil(L.length * k.edit))).slice(0, 3) : [];
      const rs = ls.length && (SHORT.has(R) ? [[R, R]] : R.length >= 3 ? near(R, V, Math.max(1, Math.ceil(R.length * k.edit))).slice(0, 3) : []);
      for (const [lv, lf] of ls) for (const [rv, rf] of rs || []) {
        const s = score(`${lf} ${rf}`) + k.bonus - k.split;
        if (s > best.s) best = { text: `${lv} ${rv}`, s };
      }
    }
    out.push(best.text.replace(/^[^\p{L}\p{N}(]+|[^\p{L}\p{N})?]+$/gu, ''));
  }
  while (out.length && (SHORT.has(out.at(-1)) || out.at(-1) === '/' || out.at(-1) === '+' || !out.at(-1))) out.pop();
  while (out.length && (out[0] === '/' || out[0] === '+')) out.shift();
  let text = out.filter(Boolean).join(' ');
  // Whole remembered dish.
  if (dishes.length && text) {
    const ft = fold(text), base = ctcLogP(frames, ft);
    let bestD = null;
    for (const d of dishes) {
      const fd = fold(d);
      if (1 - lev(fd, ft) / Math.max(fd.length, ft.length) < 0.4) continue;
      const s = ctcLogP(frames, fd) + k.dish;
      if (s > base && (!bestD || s > bestD.s)) bestD = { d, s };
    }
    if (bestD) text = bestD.d;
  }
  return text;
}

// ---- Word-pair language model ----
// counts: {words: {w: n}, pairs: {"a b": n}} (food-it.json); extra: words that count as known
// (FOOD_WORDS); dishes: the user's own dishes, whose words and word pairs weigh more.
export function makeLM(counts, extra = [], dishes = [], { extraN = 3, dishN = 10, beta = 2 } = {}) {
  const uni = new Map(), bi = new Map();
  const add = (m, k, n) => m.set(k, (m.get(k) || 0) + n);
  for (const [w, n] of Object.entries(counts.words || {})) add(uni, fold(w), n);
  for (const [p, n] of Object.entries(counts.pairs || {})) add(bi, fold(p), n);
  for (const w of extra) add(uni, fold(w), extraN);
  for (const d of dishes) {
    const ws = fold(d).match(/[a-z]+/g) || [];
    ws.forEach((w, i) => { add(uni, w, dishN); if (i) add(bi, `${ws[i - 1]} ${w}`, dishN); });
  }
  let N = 0;
  for (const n of uni.values()) N += n;
  const V = uni.size;
  const pUni = (w) => ((uni.get(w) || 0) + 0.1) / (N + 0.1 * V);
  return {
    words: [...uni.keys()],
    known: (w) => uni.has(w),
    // log P(w | prev), interpolated with the unigram (prev = null at the start of a line).
    logp: (w, prev) => {
      const pu = pUni(w);
      if (!prev) return Math.log(pu);
      const cp = uni.get(prev) || 0;
      return Math.log(((bi.get(`${prev} ${w}`) || 0) + beta * pu) / (cp + beta));
    },
  };
}

// ponytail: tuned on private/dataset with leave-one-out dishes (tools/lm-tune.mjs --grid).
export const DECODE_LM = { edit: 0.34, lm: 0.75, oov: -16, keep: 6, dish: 8 };

// Context-aware decoding: per word of the best path, the few likeliest candidates (raw reading,
// nearby known words, run-together splits) by the model's probability; then the best whole line
// by model score + lm weight x word-pair log probability (Viterbi). OOV words cost `oov`.
export function decodeLineLM(frames, { lm, dishes = [], k = DECODE_LM, original = '' } = {}) {
  const V = lm.words.map((w) => [w, w]);
  let words = greedyWords(frames);
  if (words.length > 1 && /[:.;-]$/.test(words[0].word) && (matchMeal(words[0].word) || core(words[0].word).length <= 4)) words = words.slice(1);
  const caseOf = new Map(original.split(/\s+/).map((w) => [fold(w).replace(/[^a-z0-9]/g, ''), w.replace(/^[^\p{L}\p{N}(]+|[^\p{L}\p{N})?]+$/gu, '')]));
  // Each position: [{toks: [folded words], text, s}]
  const cols = [];
  for (const w of words) {
    const raw = w.word, c = core(raw);
    if (/^[|l1/]$/.test(raw)) { cols.push([{ toks: [], text: '/', s: 0 }]); continue; }
    if (raw === '+' || /^x\d$/.test(raw)) { cols.push([{ toks: [], text: raw, s: 0 }]); continue; }
    if (!c) continue;
    const pre = raw.match(/^[^a-z0-9]*/)[0], post = raw.match(/[^a-z0-9]*$/)[0];
    const score = (t) => ctcLogP(frames, pre + t + post, w.t0, w.t1);
    const cands = [{ toks: [c], text: lm.known(c) ? c : caseOf.get(c) ?? c, s: score(c), oov: !lm.known(c) }];
    const maxD = (n) => Math.max(1, Math.ceil(n * k.edit));
    for (const [f] of near(c, V, maxD(c.length))) if (f !== c) cands.push({ toks: [f], text: f, s: score(f) });
    if (c.length >= 5) for (let i = 1; i < c.length; i++) {
      const L = c.slice(0, i), R = c.slice(i);
      const ls = lm.known(L) ? [[L]] : L.length >= 3 ? near(L, V, maxD(L.length)).slice(0, 3) : [];
      const rs = ls.length ? (lm.known(R) ? [[R]] : R.length >= 3 ? near(R, V, maxD(R.length)).slice(0, 3) : []) : [];
      for (const [lf] of ls) for (const [rf] of rs) cands.push({ toks: [lf, rf], text: `${lf} ${rf}`, s: score(`${lf} ${rf}`) });
    }
    cands.sort((a, b) => b.s - a.s);
    cols.push(cands.slice(0, k.keep));
  }
  // Viterbi over candidates with the word-pair model.
  const lmScore = (toks, prev, oov) => {
    let s = 0;
    toks.forEach((t, i) => { s += oov ? k.oov : k.lm * lm.logp(t, i ? toks[i - 1] : prev); });
    return s;
  };
  let beam = [{ s: 0, last: null, out: [] }];
  for (const col of cols) {
    const next = [];
    for (const b of beam) for (const c of col) {
      next.push({ s: b.s + c.s + lmScore(c.toks, b.last, c.oov), last: c.toks.length ? c.toks.at(-1) : b.last, out: [...b.out, c.text] });
    }
    next.sort((a, b) => b.s - a.s);
    beam = next.slice(0, 12);
  }
  const out = beam[0]?.out || [];
  while (out.length && (SHORT.has(out.at(-1)) || out.at(-1) === '/' || out.at(-1) === '+' || !out.at(-1))) out.pop();
  while (out.length && (out[0] === '/' || out[0] === '+')) out.shift();
  let text = out.filter(Boolean).join(' ');
  if (dishes.length && text) {
    const ft = fold(text), base = ctcLogP(frames, ft);
    let bestD = null;
    for (const d of dishes) {
      const fd = fold(d);
      if (1 - lev(fd, ft) / Math.max(fd.length, ft.length) < 0.4) continue;
      const s = ctcLogP(frames, fd) + k.dish;
      if (s > base && (!bestD || s > bestD.s)) bestD = { d, s };
    }
    if (bestD) text = bestD.d;
  }
  return text;
}

// The decoder the app uses: with remembered dishes, the word-pair model built from them (measured
// best); on a first scan, the vocabulary bonus (the word-pair model needs the user's phrasing).
export function decoderFor(dishes = []) {
  if (!dishes.length) return decodeLine;
  const lm = makeLM({}, FOOD_WORDS, dishes);
  return (frames, o) => decodeLineLM(frames, { ...o, lm });
}
