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
// "/" is often read as l, |, 1, I, [ ...: a slash in a candidate may use any of those readings.
const SLASHY = ['/', '|', 'l', '1', 'i', '[', ']', '!', '(', ')'];
const lp = (f, ch) => (ch === '/' ? Math.log(Math.max(FLOOR, SLASHY.reduce((a, c) => a + (f[c] || 0), 0))) : Math.log(f[ch] ?? FLOOR));
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
    if (ch === '/' || ch === '|') { // a slash is a word of its own ("pizza/mamma" = pizza / mamma)
      if (cur) { cur.t1 = t; words.push(cur); cur = null; }
      if (prev !== ch) words.push({ word: '/', t0: t, t1: t + 1 });
      else words.at(-1).t1 = t + 1;
      lastSpace = t; prev = ch;
      return;
    }
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

const core = (w) => w.replace(/(^|[a-z])2(?=[a-z])/g, '$1z').replace(/[0-9]/g, (d) => ({ 0: 'o', 1: 'i', 4: 'a', 5: 's', 8: 'b' })[d] ?? d).replace(/[^a-z]/g, '');
const near = (c, V, maxD) => V.filter(([, f]) => Math.abs(f.length - c.length) <= maxD && lev(c, f) <= maxD);
const SHORT = new Set(['e', 'o', 'a', 'al', 'ai', 'da', 'di', 'in', 'la', 'le', 'lo', 'il', 'con', 'col', 'per', 'del']);

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
export const DECODE = { edit: 0.34, lm: 0.75, oov: -16, keep: 6, dish: 8, slash: 2, endL: 6 };

const ctcText = (s) => fold(s).replace(/\s*\/\s*/g, '/').replace(/\s+/g, ' ').trim();

// Context-aware decoding: per word of the best path, the few likeliest candidates (raw reading,
// nearby known words, run-together splits, a slash read as a letter) by the model's probability;
// then the best whole line by model score + lm weight x word-pair log probability (Viterbi).
// Candidates are lists of parts: {t: folded word, text, oov} or '/' (which restarts the context).
export function decodeLine(frames, { lm, dishes = [], k = DECODE, original = '' } = {}) {
  const V = lm.words.map((w) => [w, w]);
  let words = greedyWords(frames);
  if (words.length > 1 && /[:.;-]$/.test(words[0].word) && (matchMeal(words[0].word) || core(words[0].word).length <= 4)) words = words.slice(1);
  const caseOf = new Map(original.split(/[\s/|]+/).map((w) => [fold(w).replace(/[^a-z0-9]/g, ''), w.replace(/^[^\p{L}\p{N}(]+|[^\p{L}\p{N})?]+$/gu, '')]));
  const maxD = (n) => Math.max(1, Math.ceil(n * k.edit));
  // Unknown words keep the writer's capitals ("Toscana"), also when they are a piece of a split word.
  const caseFor = (c) => caseOf.get(c) ?? [...caseOf].find(([f]) => f.startsWith(c))?.[1].slice(0, c.length) ?? c;
  const word = (c) => ({ t: c, text: lm.known(c) ? c : caseFor(c), oov: !lm.known(c) });
  // Options for a piece of a split word: known words near it, or itself when long enough.
  const opts = (c, rawOk) => {
    if (!c) return [];
    if (lm.known(c)) return [word(c)];
    const n = c.length >= 3 ? near(c, V, maxD(c.length)).slice(0, 3).map(([f]) => word(f)) : [];
    return rawOk && c.length >= 2 ? [...n, word(c)] : n;
  };
  const cols = [];
  for (const [wi, w] of words.entries()) {
    const raw = w.word, c = core(raw);
    if (raw === '/' || /^[|l1[\]!]$/.test(raw)) { cols.push([{ parts: ['/'], s: 0 }]); continue; }
    if (raw === '+' || /^x\d$/.test(raw)) { cols.push([{ parts: [{ t: null, text: raw }], s: 0 }]); continue; }
    if (!c) continue;
    const pre = raw.match(/^[^a-z0-9]*/)[0], post = raw.match(/[^a-z0-9]*$/)[0];
    const score = (parts) => ctcLogP(frames, pre + parts.map((p) => (p === '/' ? '/' : p.t)).join(' ').replace(/ ?\/ ?/g, '/') + post, w.t0, w.t1);
    const cands = [[word(c)]];
    for (const [f] of near(c, V, maxD(c.length))) if (f !== c) cands.push([word(f)]);
    if (c.length >= 5) for (let i = 1; i < c.length; i++) {
      const ls = opts(c.slice(0, i)), rs = ls.length ? opts(c.slice(i)) : [];
      for (const l of ls) for (const r of rs) if (!l.oov && !r.oov) cands.push([l, r]);
    }
    // A slash read as a letter: "pizzalmamma", "comunital", "lpanino".
    const lower = fold(raw);
    // Long Italian words practically never end in "l": an unknown "toscanal" is "toscana /".
    // Only before another word: a final "cocktail" stays a cocktail.
    const endsLikeSlash = wi < words.length - 1 && c.length >= 5 && /[l1|]$/.test(lower) && !lm.known(c);
    for (let p = 0; p < lower.length; p++) {
      if (!SLASHY.includes(lower[p]) || lower[p] === '/') continue;
      const L = core(lower.slice(0, p)), R = core(lower.slice(p + 1));
      if (!L && !cols.length) continue; // nothing before a leading slash
      const ls = L ? opts(L, L.length >= 4) : [null], rs = R ? opts(R, true) : [null];
      for (const l of ls) for (const r of rs) {
        // At least one side must be a known word, except a trailing slash after an unknown name
        // ("Toscanal" = "Toscana /").
        if ((l?.oov ?? true) && (r?.oov ?? true) && !(r == null && endsLikeSlash)) continue;
        cands.push([l, '/', r].filter(Boolean));
      }
    }
    const scored = cands.map((parts) => ({ parts, s: score(parts) - (parts.includes('/') ? k.slash : 0) - (endsLikeSlash && !parts.includes('/') && parts.length === 1 && parts[0].oov ? k.endL : 0) }));
    scored.sort((a, b) => b.s - a.s);
    cols.push(scored.slice(0, k.keep));
  }
  // Viterbi over candidates with the word-pair model; a slash starts a new phrase.
  const lmScore = (parts, prev) => {
    let s = 0;
    for (const p of parts) {
      if (p === '/') { prev = null; continue; }
      if (p.t == null) continue;
      s += p.oov ? k.oov : k.lm * lm.logp(p.t, prev);
      prev = p.t;
    }
    return { s, prev };
  };
  let beam = [{ s: 0, last: null, out: [] }];
  for (const col of cols) {
    const next = [];
    for (const b of beam) for (const c of col) {
      const l = lmScore(c.parts, b.last);
      next.push({ s: b.s + c.s + l.s, last: l.prev, out: [...b.out, ...c.parts.map((p) => (p === '/' ? '/' : p.text))] });
    }
    next.sort((a, b) => b.s - a.s);
    beam = next.slice(0, 12);
  }
  const out = (beam[0]?.out || []).map((t) => t.replace(/^[^\p{L}\p{N}(/]+|[^\p{L}\p{N})?/]+$/gu, '')).filter(Boolean);
  while (out.length && (SHORT.has(out.at(-1)) || out.at(-1) === '/' || out.at(-1) === '+')) out.pop();
  while (out.length && (out[0] === '/' || out[0] === '+')) out.shift();
  let text = out.join(' ').replace(/(\/ )+/g, '/ ').replace(/\s*\/\s*/g, ' / ');
  if (dishes.length && text) {
    const ft = ctcText(text), base = ctcLogP(frames, ft);
    let bestD = null;
    for (const d of dishes) {
      const fd = ctcText(d);
      if (1 - lev(fd, ft) / Math.max(fd.length, ft.length) < 0.4) continue;
      const s = ctcLogP(frames, fd) + k.dish;
      if (s > base && (!bestD || s > bestD.s)) bestD = { d, s };
    }
    if (bestD) text = bestD.d;
  }
  return text;
}

// The decoder the app uses: the word-pair model over FOOD_WORDS and the user's remembered dishes.
export function decoderFor(dishes = []) {
  const lm = makeLM({}, FOOD_WORDS, dishes);
  return (frames, o) => decodeLine(frames, { ...o, lm });
}
