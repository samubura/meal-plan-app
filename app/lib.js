// Pure logic shared by index.html and the Node tests/bench: no DOM here.

export const DAY_KEYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

// Full names (fuzzy matched) per day, Monday first. Short forms are matched exactly.
const DAY_NAMES = [
  ['monday', 'lunedi', 'lundi', 'lunes', 'montag', 'segunda'],
  ['tuesday', 'martedi', 'mardi', 'martes', 'dienstag', 'terca'],
  ['wednesday', 'mercoledi', 'mercredi', 'miercoles', 'mittwoch', 'quarta'],
  ['thursday', 'giovedi', 'jeudi', 'jueves', 'donnerstag', 'quinta'],
  ['friday', 'venerdi', 'vendredi', 'viernes', 'freitag', 'sexta'],
  ['saturday', 'sabato', 'samedi', 'sabado', 'samstag'],
  ['sunday', 'domenica', 'dimanche', 'domingo', 'sonntag'],
];
const DAY_SHORT = [
  ['mon', 'lun', 'mo', 'seg'],
  ['tue', 'tues', 'mar', 'di', 'ter'],
  ['wed', 'mer', 'mie', 'mi', 'qua'],
  ['thu', 'thur', 'thurs', 'gio', 'jeu', 'jue', 'do', 'qui'],
  ['fri', 'ven', 'vie', 'fr', 'sex'],
  ['sat', 'sab', 'sam', 'sa'],
  ['sun', 'dom', 'dim', 'so'],
];

const LUNCH = ['pranzo', 'lunch', 'dejeuner', 'almuerzo', 'mittagessen', 'mittag', 'almoco'];
const DINNER = ['cena', 'dinner', 'diner', 'abendessen', 'abend', 'jantar', 'supper'];

const NOISE = /\b(meal\s*plan|shopping\s*list|shopping|notes?)\b/gi;

export const norm = (s) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

export function lev(a, b) {
  const d = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = d[0];
    d[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const t = d[j];
      d[j] = Math.min(d[j] + 1, d[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = t;
    }
  }
  return d[b.length];
}

// Edits allowed for a fuzzy match of a word of length n.
const slack = (n) => (n <= 4 ? 0 : n <= 6 ? 1 : 2);

const letters = (tok) => norm(tok).replace(/-feira$/, '').replace(/[^a-z]/g, '');

export function matchDay(tok, short = true) {
  const w = letters(tok);
  if (w.length < 2) return -1;
  let best = -1, bestD = Infinity;
  DAY_NAMES.forEach((names, i) => {
    if (short && DAY_SHORT[i].includes(w)) { best = i; bestD = -1; }
    for (const n of names) {
      const dist = lev(w, n);
      if (dist <= slack(n.length) && dist < bestD) { best = i; bestD = dist; }
    }
  });
  return best;
}

// 'lunch' | 'dinner' | null. Handwriting garbles labels (PRANID, PRANDD, CEMA...), so the
// first letters count too: "pr*" => lunch (Pranzo, Pramo, Promo), short "ce*" => dinner.
export function matchMeal(tok) {
  const w = letters(tok);
  if (w.length < 3) return null;
  const fuzzy = (list) => list.some((n) => lev(w, n) <= Math.max(1, slack(n.length)));
  if (/^pr/.test(w) || fuzzy(LUNCH)) return 'lunch';
  if ((/^ce/.test(w) && w.length <= 6) || fuzzy(DINNER)) return 'dinner';
  return null;
}

const clean = (s) => s.replace(/^[\s:;.,'"`|_\-–—~*]+|[\s:;.,|_\-–—~*]+$/g, '').replace(/\s+/g, ' ');

// OCR text -> [{lunch, dinner}] x 7 (Monday first).
export function parsePlan(text) {
  const days = DAY_KEYS.map(() => ({ lunch: '', dinner: '' }));
  let day = 0, slot = null, seen = { lunch: false, dinner: false }, loose = [], started = false;

  const flushLoose = () => {
    // Unlabelled block: first line = lunch, rest = dinner.
    if (!loose.length) return;
    const d = days[day];
    if (!d.lunch && !d.dinner) { d.lunch = loose[0]; d.dinner = loose.slice(1).join(' '); }
    else if (!d.dinner) d.dinner = loose.join(' ');
    loose = [];
  };
  // Loose lines before the first heading/label are the page title etc.: drop them.
  const start = () => { if (!started) loose = []; started = true; };
  const goTo = (i) => {
    start();
    flushLoose();
    day = i; slot = null; seen = { lunch: false, dinner: false };
  };
  const put = (s, txt) => {
    if (!txt) return;
    days[day][s] = days[day][s] ? `${days[day][s]} ${txt}` : txt;
  };

  for (const raw of text.split(/\r?\n/)) {
    let toks = raw.replace(NOISE, ' ').split(/\s+/).filter((t) => /[\p{L}\p{N}]/u.test(t));
    if (!toks.length) continue;

    // Day heading: first token, or any token with 6+ letters (lines like "e insalata Wednesday").
    const di = toks.findIndex((t, k) => (k === 0 || letters(t).length >= 6) && matchDay(t, k === 0 && toks.length <= 2) >= 0);
    if (di >= 0) {
      const i = matchDay(toks[di], di === 0 && toks.length <= 2);
      const before = toks.slice(0, di).join(' ');
      if (before && slot) put(slot, clean(before));
      if (i >= day) goTo(i);
      toks = toks.slice(di + 1);
      if (!toks.length) continue;
    }

    // A short first word ending in ':' '.' '-' is a garbled label (RAND:, Ctni:, Mano.); when it
    // doesn't look like either, labels alternate lunch, dinner, lunch...
    let m = matchMeal(toks[0]);
    const w0 = letters(toks[0]);
    if (!m && w0.length >= 3 && w0.length <= 7 && (/[:.;\-]$/.test(toks[0]) || /^[:.;\-–—]/.test(toks[1] || ''))) {
      m = seen.lunch && !seen.dinner ? 'dinner' : 'lunch';
    }
    if (m) {
      start();
      // A repeated label means we crossed into the next day without seeing its heading.
      if (seen[m] || (m === 'lunch' && seen.dinner)) { if (day < 6) goTo(day + 1); }
      flushLoose();
      seen[m] = true; slot = m;
      put(m, clean(toks.slice(1).join(' ')));
    } else if (slot) {
      put(slot, clean(toks.join(' ')));
    } else {
      const t = clean(toks.join(' '));
      if (t) loose.push(t);
    }
  }
  flushLoose();
  return days;
}

// Grayscale (Uint8Array, w*h) from RGBA ImageData.data. 'max' (brightest channel) makes the
// pink ruled lines nearly as light as the paper while dark ink stays dark.
export function toGray(rgba, channel = 'lum') {
  const g = new Uint8Array(rgba.length / 4);
  for (let i = 0; i < g.length; i++) {
    const r = rgba[4 * i], gr = rgba[4 * i + 1], b = rgba[4 * i + 2];
    g[i] = channel === 'max' ? Math.max(r, gr, b) : (r * 77 + gr * 150 + b * 29) >> 8;
  }
  return g;
}

// Bradley local-mean threshold: a pixel is ink if darker than (1 - t) x mean of its window.
// radius as a fraction of the image width. Returns 0/255 Uint8Array.
export function adaptiveThreshold(gray, w, h, { radius = 1 / 32, t = 0.15 } = {}) {
  const r = Math.max(4, Math.round(w * radius));
  const integ = new Float64Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) {
    let row = 0;
    for (let x = 0; x < w; x++) {
      row += gray[y * w + x];
      integ[(y + 1) * (w + 1) + x + 1] = integ[y * (w + 1) + x + 1] + row;
    }
  }
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - r), y1 = Math.min(h, y + r + 1);
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - r), x1 = Math.min(w, x + r + 1);
      const sum = integ[y1 * (w + 1) + x1] - integ[y0 * (w + 1) + x1] - integ[y1 * (w + 1) + x0] + integ[y0 * (w + 1) + x0];
      out[y * w + x] = gray[y * w + x] * (x1 - x0) * (y1 - y0) < sum * (1 - t) ? 0 : 255;
    }
  }
  return out;
}

export const filledCount = (days) => days.reduce((n, d) => n + !!d.lunch + !!d.dinner, 0);

// ---- iCalendar ----

const esc = (s) => s.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');

// Fold at 75 octets, never splitting a UTF-8 sequence.
export function fold(line) {
  const enc = new TextEncoder();
  const out = [];
  let cur = '', n = 0, limit = 75;
  for (const ch of line) {
    const b = enc.encode(ch).length;
    if (n + b > limit) { out.push(cur); cur = ''; n = 0; limit = 74; }
    cur += ch; n += b;
  }
  out.push(cur);
  return out.join('\r\n ');
}

const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
const isoDate = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

// days: [{lunch, dinner}] x 7; weekStart: 'YYYY-MM-DD' (Monday);
// opts: {lunchTime:'12:30', dinnerTime:'19:00', lunchMin:45, dinnerMin:60}; now: Date for DTSTAMP.
export function buildICS(days, weekStart, opts, now = new Date()) {
  const [Y, M, D] = weekStart.split('-').map(Number);
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Meal Plan Scanner//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH'];
  days.forEach((d, i) => {
    for (const [slot, label, time, mins] of [
      ['lunch', 'Pranzo', opts.lunchTime, opts.lunchMin],
      ['dinner', 'Cena', opts.dinnerTime, opts.dinnerMin],
    ]) {
      const dish = (d[slot] || '').trim();
      if (!dish) continue;
      const [h, m] = time.split(':').map(Number);
      const start = new Date(Y, M - 1, D + i, h, m);
      const end = new Date(start.getTime() + mins * 60000);
      const t = (x) => `${ymd(x)}T${pad(x.getHours())}${pad(x.getMinutes())}00`;
      lines.push(
        'BEGIN:VEVENT',
        `UID:meal-${isoDate(start)}-${slot}@mealplan-scanner`,
        `DTSTAMP:${stamp}`,
        `DTSTART:${t(start)}`,
        `DTEND:${t(end)}`,
        `SUMMARY:${esc(`${label}: ${dish}`)}`,
        'END:VEVENT',
      );
    }
  });
  lines.push('END:VCALENDAR');
  return lines.map(fold).join('\r\n') + '\r\n';
}

// ---- Layout: find the label column (day headings, PRANZO/CENA) from OCR word boxes ----

const isLabelish = (t) => { const w = letters(t); return w.length >= 3 && w.length <= 7 && /[:.;\-]$/.test(t); };

// Least squares polynomial (degree 1 or 2) through points [x, y]; returns f(x).
function polyfit(pts, deg) {
  deg = Math.min(deg, pts.length - 1);
  if (deg <= 0) { const m = pts.reduce((a, p) => a + p[1], 0) / pts.length; return () => m; }
  const n = deg + 1, A = Array.from({ length: n }, () => new Float64Array(n + 1));
  for (const [x, y] of pts) for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) A[i][j] += x ** (i + j);
    A[i][n] += y * x ** i;
  }
  for (let i = 0; i < n; i++) for (let r = i + 1; r < n; r++) {
    const f = A[r][i] / A[i][i];
    for (let c = i; c <= n; c++) A[r][c] -= f * A[i][c];
  }
  const co = new Array(n);
  for (let i = n - 1; i >= 0; i--) { let s = A[i][n]; for (let j = i + 1; j < n; j++) s -= A[i][j] * co[j]; co[i] = s / A[i][i]; }
  return (x) => co.reduce((a, c, i) => a + c * x ** i, 0);
}

// words: [{text, confidence, bbox:{x0,y0,x1,y1}}] (several OCR passes may be concatenated).
// Returns 14 rows {day, slot, y (centre), x0 (label left), x1 (label right)} or null.
export function findLayout(words, imgW) {
  let cand = [];
  for (const wd of words) {
    const b = wd.bbox, y = (b.y0 + b.y1) / 2;
    const day = letters(wd.text).length >= 5 ? matchDay(wd.text, false) : -1;
    const slot = day < 0 && (matchMeal(wd.text) || (isLabelish(wd.text) ? '?' : null));
    if (day >= 0 || slot) cand.push({ day, slot, y, x0: b.x0, x1: b.x1, conf: wd.confidence });
  }
  // Keep the left column: robust line x0 = f(y), dropping far-off words (dish text matching "lune"...).
  for (let it = 0; it < 3 && cand.length >= 3; it++) {
    const fx = polyfit(cand.map((c) => [c.y, c.x0]), 1);
    const res = cand.map((c) => Math.abs(c.x0 - fx(c.y))).sort((a, b) => a - b);
    const tol = Math.max(0.04 * imgW, 2.5 * res[Math.floor(res.length / 2)]);
    cand = cand.filter((c) => Math.abs(c.x0 - fx(c.y)) <= tol);
  }
  // Merge duplicates from different passes (same line), keeping the most specific/confident.
  cand.sort((a, b) => a.y - b.y);
  const merged = [];
  for (const c of cand) {
    const p = merged[merged.length - 1];
    if (p && Math.abs(p.y - c.y) < 18 * (imgW / 1238)) {
      const rank = (q) => (q.day >= 0 ? 2 : q.slot !== '?' ? 1 : 0) * 100 + q.conf;
      if (rank(c) > rank(p)) merged[merged.length - 1] = c;
    } else merged.push(c);
  }
  // Headings must increase down the page; drop ones that don't.
  const heads = [];
  for (const c of merged) if (c.day >= 0 && (!heads.length || (c.day > heads.at(-1).day && c.y > heads.at(-1).y))) heads.push(c);
  if (heads.length < 2) return null;
  const hy = polyfit(heads.map((h) => [h.day, h.y]), heads.length >= 4 ? 2 : 1);
  const labelW = median(merged.filter((c) => c.day < 0).map((c) => c.x1 - c.x0)) || 0.12 * imgW;
  const fx = polyfit(merged.map((c) => [c.y, c.x0]), 1);

  // Place each label in its day block; its position inside the block tells lunch from dinner.
  const found = {};
  for (const c of merged) {
    if (c.day >= 0) continue;
    const d = Math.max(0, Math.min(6, Math.floor(solve(hy, c.y))));
    const frac = (c.y - hy(d)) / (hy(d + 1) - hy(d));
    const slot = c.slot !== '?' ? c.slot : frac < 0.55 ? 'lunch' : 'dinner';
    const key = `${d}-${slot}`;
    if (frac > 0.1 && frac < 1 && !found[key]) found[key] = { ...c, frac };
  }
  const fr = (s, def) => median(Object.values(found).filter((c) => c.slot === s || (c.slot === '?' && (s === 'lunch') === c.frac < 0.55)).map((c) => c.frac)) ?? def;
  const fL = fr('lunch', 0.36), fD = fr('dinner', 0.74);
  const rows = [];
  for (let d = 0; d < 7; d++) for (const slot of ['lunch', 'dinner']) {
    const f = found[`${d}-${slot}`];
    const y = f ? f.y : hy(d) + (slot === 'lunch' ? fL : fD) * (hy(d + 1) - hy(d));
    const x0 = f ? f.x0 : fx(y);
    rows.push({ day: d, slot, y, x0, x1: f ? f.x1 : x0 + labelW, found: !!f, gap: hy(d + 1) - hy(d) });
  }
  return rows;
}

function median(a) { if (!a.length) return undefined; a = [...a].sort((x, y) => x - y); return a[a.length >> 1]; }
// Invert a monotonic f on [-1, 8] by bisection.
function solve(f, y) { let lo = -1, hi = 8; for (let i = 0; i < 40; i++) { const m = (lo + hi) / 2; if (f(m) < y) lo = m; else hi = m; } return lo; }

// Copy a rectangle out of a grayscale image (clamped).
export function crop(gray, w, h, x0, y0, x1, y1) {
  x0 = Math.max(0, Math.round(x0)); y0 = Math.max(0, Math.round(y0));
  x1 = Math.min(w, Math.round(x1)); y1 = Math.min(h, Math.round(y1));
  const cw = x1 - x0, ch = y1 - y0, out = new Uint8Array(cw * ch);
  for (let y = 0; y < ch; y++) out.set(gray.subarray((y0 + y) * w + x0, (y0 + y) * w + x1), y * cw);
  return { gray: out, w: cw, h: ch };
}

// x where the page ends on the right of a row: first run of 4 columns right of xMin that are
// mostly ink between y0 and y1 (the dark page edge / binding). Falls back to the image width.
export function pageRight(bin, w, h, xMin, y0, y1) {
  y0 = Math.max(0, Math.round(y0)); y1 = Math.min(h, Math.round(y1));
  for (let x = Math.round(xMin), run = 0; x < w; x++) {
    let ink = 0;
    for (let y = y0; y < y1; y++) ink += bin[y * w + x] === 0;
    run = ink > 0.6 * (y1 - y0) ? run + 1 : 0;
    if (run === 4) return x - 3;
  }
  return w;
}

// Follow one handwritten line from (x0, y) to x1 and straighten it: the ink centre is tracked in
// sliding windows (handwriting drifts up/down), then each column of src (default: bin) is
// resampled around the track.
export function traceRow(bin, w, h, x0, x1, y, half, src = bin) {
  x0 = Math.max(0, Math.round(x0)); x1 = Math.min(w, Math.round(x1));
  const step = 8, win = 48, centres = [];
  let c = y;
  for (let x = x0; x < x1; x += step) {
    let sum = 0, n = 0;
    const ya = Math.max(0, Math.round(c - 0.8 * half)), yb = Math.min(h, Math.round(c + 0.8 * half));
    for (let yy = ya; yy < yb; yy++) for (let xx = x; xx < Math.min(x1, x + win); xx++)
      if (bin[yy * w + xx] === 0) { sum += yy; n++; }
    if (n > win / 2) c = 0.75 * c + 0.25 * (sum / n);
    centres.push(c);
  }
  const ow = x1 - x0, oh = Math.round(2 * half), out = new Uint8Array(ow * oh).fill(255);
  for (let x = 0; x < ow; x++) {
    // Window centre lags behind by win/2; use the centre of the window that covers x.
    const cy = Math.round(centres[Math.max(0, Math.min(centres.length - 1, Math.round((x - win / 2) / step)))] - half);
    for (let yy = 0; yy < oh; yy++) { const sy = cy + yy; if (sy >= 0 && sy < h) out[yy * ow + x] = src[sy * w + x0 + x]; }
  }
  return { gray: out, w: ow, h: oh };
}

// Crop a line image to its ink: horizontally up to the first gap wider than gapK x height (what
// follows is page edge or the next column), vertically to the rows holding most of the ink.
// Then stretch contrast (ink -> 0, paper -> 255). bin and img are the same band (binary / gray).
export function tighten(bin, img, { gapK = 1.5, keep = 0.96, pad = 0.25 } = {}) {
  const { w, h } = bin, col = new Uint32Array(w);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) col[x] += bin.gray[y * w + x] === 0;
  const minInk = Math.max(1, Math.round(0.03 * h));
  let x0 = col.findIndex((c) => c >= minInk);
  if (x0 < 0) return null;
  let x1 = x0, gap = 0;
  for (let x = x0; x < w; x++) {
    if (col[x] >= minInk) { x1 = x; gap = 0; } else if (++gap > gapK * h) break;
  }
  const row = new Uint32Array(h);
  for (let y = 0; y < h; y++) for (let x = x0; x <= x1; x++) row[y] += bin.gray[y * w + x] === 0;
  const total = row.reduce((a, b) => a + b, 0);
  let y0 = 0, y1 = h - 1, cut = 0;
  while (y0 < y1 && cut + row[y0] <= ((1 - keep) / 2) * total) cut += row[y0++];
  cut = 0;
  while (y1 > y0 && cut + row[y1] <= ((1 - keep) / 2) * total) cut += row[y1--];
  const p = Math.round(pad * (y1 - y0 + 1));
  const c = crop(img.gray, w, h, x0 - p, y0 - p, x1 + 1 + p, y1 + 1 + p);
  const hist = new Uint32Array(256);
  for (const v of c.gray) hist[v]++;
  const pct = (q) => { let n = 0; for (let v = 0; v < 256; v++) if ((n += hist[v]) >= q * c.gray.length) return v; return 255; };
  const lo = pct(0.02), hi = Math.max(lo + 1, pct(0.6));
  for (let i = 0; i < c.gray.length; i++) c.gray[i] = Math.max(0, Math.min(255, ((c.gray[i] - lo) * 255) / (hi - lo)));
  return c;
}

// ---- Dish text correction against an Italian food vocabulary (+ the user's own dishes) ----

// ponytail: hand-written list of common Italian home-cooking words; extend from real scans.
export const FOOD_WORDS = `
pasta spaghetti penne fusilli rigatoni farfalle tagliatelle fettuccine pappardelle lasagne lasagna
gnocchi ravioli tortellini tortelloni cappelletti orecchiette trofie linguine bucatini paccheri
mezze maniche conchiglie ditalini tubetti pastina risotto riso risi orzo farro quinoa cous couscous
polenta pane bruschetta crostini focaccia piadina pizza pizzette calzone panino panini toast tramezzino
sugo ragu bolognese pesto carbonara amatriciana gricia cacio pepe arrabbiata puttanesca norma aglio
olio peperoncino burro salvia panna pomodoro pomodori pomodorini passata passato besciamella
carne manzo vitello maiale pollo tacchino agnello coniglio salsiccia salsicce salame prosciutto cotto
crudo speck pancetta guanciale mortadella bresaola wurstel hamburger burger polpette polpettone
cotoletta cotolette arrosto bistecca filetto fettine scaloppine spezzatino brasato stufato lesso
bollito involtini spiedini straccetti tagliata tartare
pesce salmone tonno merluzzo baccala orata branzino spigola sogliola platessa trota sgombro alici
acciughe sardine gamberi gamberetti calamari seppie polpo cozze vongole frutti mare surgelato
surgelati bastoncini frittura fritto fritti
uova uovo frittata omelette strapazzate sode
formaggio formaggi mozzarella burrata stracciatella scamorza provola ricotta parmigiano grana
pecorino gorgonzola fontina taleggio stracchino crescenza squacquerone primo sale feta brie
verdure verdura insalata insalatona zucchine zucchina melanzane melanzana peperoni peperonata
spinaci bietole cicoria broccoli cavolfiore cavolo cavolini verza finocchi finocchio carciofi
asparagi fagiolini piselli fave ceci lenticchie fagioli legumi patate patata patatine pure
carote carota sedano cipolla cipolle porri funghi porcini radicchio rucola lattuga cetrioli
avocado mais zucca olive capperi minestrone minestra zuppa vellutata crema brodo
caprese parmigiana gratin gratinate grigliata grigliate griglia forno padella piastra vapore
bollite ripieni ripiene ripieno impanato impanate panati fredda freddo freddi calda caldo
mista misto miste misti cena pranzo avanzi asporto fuori ristorante sushi kebab poke piadine
hamburger hot dog tacos burrito curry carrozza rustica rustico milanese fresco fresca patatine robiola
fregola tofu salata salato salate rossa rosse grigliati grigliato vegetali vegetale veg vegano vegetariano
pomodorini bagel findus insalate omelettes cosce coscia arrosticini cappuccino colazione tigelle crescentine
yogurt frutta macedonia gelato dolce torta biscotti
con col coi senza alla alle allo al ai agli del della delle dei degli di da in e ed o su sul per la le lo il i gli
mamma nonna nonni casa amici
`.trim().split(/\s+/);

const SHORT_OK = new Set(['e', 'o', 'a', 'al', 'ai', 'da', 'di', 'in', 'su', 'la', 'le', 'lo', 'il', 'i', 'ed', 'con', 'per', 'del', 'dei']);
const maxEdits = (n) => (n <= 3 ? 0 : n <= 5 ? 1 : n <= 8 ? 2 : 3);

// Closest vocabulary word: {word, cost} or null.
function matchOne(core, vocab) {
  let best = null;
  for (const v of vocab) {
    const nv = norm(v);
    if (Math.abs(nv.length - core.length) > maxEdits(core.length)) continue;
    const d = lev(core, nv);
    if (d <= maxEdits(Math.max(core.length, nv.length)) && (!best || d < best.cost)) best = { word: v, cost: d };
  }
  return best;
}

// Best vocabulary match for one token, or one split of a run-together token ("esalmone" = "e salmone",
// "mozzarellain" = "mozzarella in", "avocadotoast"). A split costs 1 and must beat the single match.
function bestWord(core, vocab) {
  let best = matchOne(core, vocab);
  if (best?.cost === 0) return best;
  const tryPair = (l, r) => {
    const a = SHORT_OK.has(l) ? { word: l, cost: 0 } : l.length >= 3 && matchOne(l, vocab);
    const b = a && (SHORT_OK.has(r) ? { word: r, cost: 0 } : r.length >= 3 && matchOne(r, vocab));
    if (b && a.cost + b.cost + 1 <= 2 && (!best || a.cost + b.cost + 1 < best.cost)) best = { word: `${a.word} ${b.word}`, cost: a.cost + b.cost + 1 };
  };
  for (const sw of SHORT_OK) if (core.length >= sw.length + 4) {
    if (core.startsWith(sw)) tryPair(sw, core.slice(sw.length));
    if (core.endsWith(sw)) tryPair(core.slice(0, -sw.length), sw);
  }
  if (core.length >= 8) for (let i = 4; i <= core.length - 4; i++) tryPair(core.slice(0, i), core.slice(i));
  return best;
}

// Snap OCR'd dish text to known words. Returns {text, score}: score rewards text that is made of
// real words, so it can pick the best of several OCR variants of the same row.
export function correctDish(raw, vocab = FOOD_WORDS) {
  const out = [];
  let score = 0;
  const toks = raw.split(/\s+/).filter(Boolean);
  // A label fragment at the start ("N20:", "Pranzo:", "Promo.") belongs to the label column, not the
  // dish. Needs the trailing punctuation: "primo sale", "avocado. toast" are dishes.
  if (toks.length > 1 && /[:.;\-]$/.test(toks[0]) && (matchMeal(toks[0]) || letters(toks[0]).length <= 4)) toks.shift();
  for (let tok of toks) {
    // Handwritten "e" often comes back as 2, ©, @, €; a z as 2 inside words (2ucchine).
    if (/^[2©@€èé&]$/.test(tok)) tok = 'e';
    tok = tok.replace(/(^|[a-z])2(?=[a-z])/gi, '$1z');
    if (/^x\d$/i.test(tok)) { out.push(tok.toLowerCase()); continue; } // "farro x2"
    // Letters read as digits inside a word: 1TAL14 = ITALIA, 0 = o.
    if (/\p{L}/u.test(tok)) tok = tok.replace(/[0-9]/g, (d) => ({ 0: 'o', 1: 'i', 4: 'a', 5: 's', 8: 'b' })[d] ?? d);
    const core = norm(tok).replace(/[^a-z]/g, '');
    if (tok === '+') { out.push(tok); continue; }
    if (/^[|/\\lI1]$/.test(tok) || /^[|/]+$/.test(tok)) { out.push('/'); continue; }
    if (core.length <= 2) {
      if (SHORT_OK.has(core)) { out.push(core); score += 0.5; } else score -= 0.5;
      continue;
    }
    const m = bestWord(core, vocab);
    if (m) { out.push(m.word); score += core.length - 2 * m.cost; }
    else { out.push(tok.replace(/^[^\p{L}\p{N}(]+|[^\p{L}\p{N})?]+$/gu, '')); score -= core.length / 2; }
  }
  while (out.length && (SHORT_OK.has(out.at(-1)) || out.at(-1) === '/' || out.at(-1) === '+')) out.pop();
  while (out.length && (out[0] === '/' || out[0] === '+')) out.shift();
  return { text: out.filter(Boolean).join(' '), score };
}

// Words of FOOD_WORDS plus the user's remembered dishes.
export const vocabFor = (dishes = []) => [...new Set([...FOOD_WORDS, ...dishes.flatMap((d) => norm(d).match(/[a-z]{3,}/g) || [])])];

// Replace text by a remembered dish when they are close (OCR of a dish the user writes often).
export function snapDish(text, dishes = []) {
  const a = norm(text).replace(/[^a-z]/g, '');
  if (a.length < 3) return text;
  let best = null;
  for (const d of dishes) {
    const b = norm(d).replace(/[^a-z]/g, ''), s = 1 - lev(a, b) / Math.max(a.length, b.length);
    if (s >= 0.7 && (!best || s > best.s)) best = { d, s };
  }
  return best ? best.d : text;
}

// Choose the dish text among OCR variants of one row: tries [{text, conf}].
// ponytail: weights tuned on dataset/ (tools/pick-tune.mjs); retune when the dataset grows.
export const PICK = { vocab: 1, conf: 0.05, agree: 8 };
export function pickDish(tries, vocab = FOOD_WORDS, k = PICK) {
  const c = tries.map((t) => ({ ...correctDish(t.text, vocab), conf: t.conf }));
  const simW = (a, b) => { const x = norm(a), y = norm(b); return x || y ? 1 - lev(x, y) / Math.max(x.length, y.length) : 0; };
  let best = null;
  for (const [i, x] of c.entries()) {
    if (!x.text) continue;
    const agree = c.reduce((a, y, j) => a + (j !== i && y.text ? simW(x.text, y.text) : 0), 0);
    const sc = k.vocab * x.score + k.conf * (x.conf - 50) + k.agree * agree;
    if (!best || sc > best.sc) best = { text: x.text, sc };
  }
  return best ? best.text : '';
}

// ---- Scan pipeline ----

// Grayscale image -> binary PGM file bytes (Tesseract reads PNM in browser and Node alike).
export function toPGM({ gray, w, h }) {
  const head = new TextEncoder().encode(`P5\n${w} ${h}\n255\n`);
  const out = new Uint8Array(head.length + gray.length);
  out.set(head);
  out.set(gray, head.length);
  return out;
}

// Resize a grayscale image by factor s: bilinear when enlarging, area average when shrinking
// (bilinear would skip pixels and alias fine strokes).
export function scaleGray({ gray, w, h }, s) {
  const W = Math.max(1, Math.round(w * s)), H = Math.max(1, Math.round(h * s)), out = new Uint8Array(W * H);
  if (s < 1) {
    for (let y = 0; y < H; y++) {
      const y0 = Math.floor((y * h) / H), y1 = Math.max(y0 + 1, Math.floor(((y + 1) * h) / H));
      for (let x = 0; x < W; x++) {
        const x0 = Math.floor((x * w) / W), x1 = Math.max(x0 + 1, Math.floor(((x + 1) * w) / W));
        let sum = 0;
        for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) sum += gray[yy * w + xx];
        out[y * W + x] = sum / ((y1 - y0) * (x1 - x0));
      }
    }
    return { gray: out, w: W, h: H };
  }
  for (let y = 0; y < H; y++) {
    const sy = Math.min(h - 1, (y + 0.5) / s - 0.5), y0 = Math.max(0, Math.floor(sy)), y1 = Math.min(h - 1, y0 + 1), fy = Math.max(0, sy - y0);
    for (let x = 0; x < W; x++) {
      const sx = Math.min(w - 1, (x + 0.5) / s - 0.5), x0 = Math.max(0, Math.floor(sx)), x1 = Math.min(w - 1, x0 + 1), fx = Math.max(0, sx - x0);
      out[y * W + x] = (gray[y0 * w + x0] * (1 - fx) + gray[y0 * w + x1] * fx) * (1 - fy) + (gray[y1 * w + x0] * (1 - fx) + gray[y1 * w + x1] * fx) * fy;
    }
  }
  return { gray: out, w: W, h: H };
}

const IT_DAYS = ['lunedì', 'martedì', 'mercoledì', 'giovedì', 'venerdì', 'sabato', 'domenica'];

// Rotate RGBA pixels by q quarter turns clockwise (q = 1, 2, 3).
export function rotateRGBA(rgba, w, h, q) {
  const W = q % 2 ? h : w, H = q % 2 ? w : h, out = new Uint8ClampedArray(rgba.length), px = new Uint32Array(rgba.buffer, rgba.byteOffset, w * h), o = new Uint32Array(out.buffer);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const [X, Y] = q === 1 ? [h - 1 - y, x] : q === 2 ? [w - 1 - x, h - 1 - y] : [y, w - 1 - x];
    o[Y * W + X] = px[y * w + x];
  }
  return { rgba: out, w: W, h: H };
}

// Row variants tried per dish (image, scale); pickDish chooses among their readings.
const ROW_VARIANTS = [['gray', 0.6], ['gray', 0.8], ['bin', 0.6], ['bin', 0.8]];

// rgba: RGBA pixels of the photo, longest side 2200 px.
// recognize(pgmBytes, psm, withWords) -> Promise<{text, conf, words}> (thin wrapper over tesseract.js).
// Returns {days, reads, layout, rotated}: reads has every OCR variant per row, for debugging and
// tuning; rotated = quarter turns applied to make the page upright.
// dishes: dishes the user corrected before (personal dictionary).
// readLine(img {gray, w, h}) -> Promise<{text, conf}>: a line recognizer for the dishes (ocr.js);
// without it, Tesseract reads the dishes too. lineVariants: which images readLine gets per row
// (bench: max-channel gray beats binary and luminance); tight: options for tighten().
// onBand(row, img): debug hook, gets every line image that is read.
// decode: ocr.js decoderFor(dishes) (context-aware decoding of readLine's frames).
export async function scanPlan(rgba, w, h, recognize, { dishes = [], onProgress = () => {}, readLine, decode, lineVariants = ['gray'], onBand, tight = {} } = {}) {
  const variants = readLine ? lineVariants : ROW_VARIANTS;
  let total = 2 + 14 * variants.length, done = 0;
  const tick = (msg, n = 1) => onProgress(Math.min(1, (done += n) / total), msg);
  const prep = (img) => {
    const gray = toGray(img.rgba, 'max'), bin = adaptiveThreshold(gray, img.w, img.h, { radius: 1 / 32, t: 0.15 });
    return { ...img, gray, bin, page: toPGM({ gray: bin, w: img.w, h: img.h }) };
  };
  const labelsFound = (rows) => (rows ? rows.filter((r) => r.found).length : -1);

  // Sideways or upside-down photo: the orientation where the most day/meal labels are found wins.
  // Upright photos stop after the first try.
  let best = null;
  for (const q of [0, 1, 3, 2]) {
    if (q) { total++; tick('Raddrizzo la foto'); }
    const img = prep(q ? rotateRGBA(rgba, w, h, q) : { rgba, w, h });
    const a = await recognize(img.page, '11', true);
    const n = labelsFound(findLayout(a.words, img.w));
    if (!best || n > best.n) best = { ...img, a, n, q };
    if (n >= 6) break;
  }
  tick('Cerco i giorni');
  ({ rgba, w, h } = best);
  const { gray, bin, page, a } = best;
  const lum = readLine && lineVariants.includes('lum') ? toGray(rgba, 'lum') : null;

  // Two page layouts find different subsets of the labels; together they find most of them.
  const b = await recognize(page, '3', true); tick('Cerco i pasti');
  const rows = findLayout([...a.words, ...b.words], w);
  if (!rows) return { days: parsePlan(b.text), reads: [{ text: b.text }], layout: false, rotated: best.q };

  const days = DAY_KEYS.map(() => ({ lunch: '', dinner: '' }));
  const reads = [];
  for (const r of rows) {
    const half = 0.2 * r.gap;
    // No label seen: the text may start where the label would be (e.g. "ROMA" for the whole day).
    const x0 = r.found ? r.x1 + 4 : r.x0;
    const right = pageRight(bin, w, h, r.x1 + 0.3 * w, r.y - half, r.y + half);
    const probe = traceRow(bin, w, h, x0, right - 4, r.y, half);
    const ink = probe.gray.reduce((n, v) => n + (v === 0), 0) / probe.gray.length;
    const tries = [];
    const label = `Leggo ${IT_DAYS[r.day]}, ${r.slot === 'lunch' ? 'pranzo' : 'cena'}`;
    if (ink <= 0.004) tick(label, variants.length);
    else if (readLine) for (const v of variants) {
      let band = v === 'bin' ? probe : traceRow(bin, w, h, x0, right - 4, r.y, half, v === 'lum' ? lum : gray);
      if (tight) band = tighten(probe, band, tight) || band;
      onBand?.(r, band);
      const { text, conf, frames } = await readLine(band);
      tries.push({ text, conf, frames });
      tick(label);
    } else for (const [src, s] of variants) {
      const band = src === 'bin' ? probe : traceRow(bin, w, h, x0, right - 4, r.y, half, gray);
      const { text, conf } = await recognize(toPGM(scaleGray(band, s)), '7', false);
      tries.push({ text: text.trim(), conf });
      tick(label);
    }
    reads.push({ day: r.day, slot: r.slot, found: r.found, ink: +ink.toFixed(4), tries });
  }
  return { days: daysFromReads(reads, dishes, { decode }), reads, layout: true, rotated: best.q };
}

const decodeText = (decode, t, vocab, dishes, k) => decode(t.frames, { vocab, dishes, original: t.text, ...(k && { k }) });

// reads (from scanPlan) -> days. Kept separate so tools can re-run it on saved readings.
// decode: ocr.js decoderFor(dishes), for readings that carry the recognizer's frames.
export function daysFromReads(reads, dishes = [], { k = PICK, decode, dk } = {}) {
  const vocab = vocabFor(dishes);
  const days = DAY_KEYS.map(() => ({ lunch: '', dinner: '' }));
  for (const r of reads) {
    const t = r.tries[0];
    days[r.day][r.slot] = decode && t?.frames
      ? decodeText(decode, t, vocab, dishes, dk)
      : snapDish(pickDish(r.tries, vocab, k), dishes);
  }
  // A day with no labels and a single line ("ROMA") means the whole day.
  for (let d = 0; d < 7; d++) {
    const rs = reads.filter((r) => r.day === d), x = days[d];
    if (rs.every((r) => !r.found) && !x.lunch !== !x.dinner) x.lunch = x.dinner = x.lunch || x.dinner;
  }
  return days;
}
