// Optional reading with Google Gemini (the user's own AI Studio key, free tier). The photo is sent
// to Google. Any failure (no key, quota, no network, plan changed) throws, and the app falls back to
// the on-phone reader. Works in the browser and in Node (fetch).

const API = 'https://generativelanguage.googleapis.com/v1beta';
const DAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];

async function call(key, path, init = {}, timeout = 15000) {
  let res;
  try {
    res = await fetch(`${API}${path}`, { ...init, signal: AbortSignal.timeout(timeout), headers: { 'x-goog-api-key': key, 'Content-Type': 'application/json', ...init.headers } });
  } catch (e) {
    // No answer in time (an overloaded model can hang): treated like "busy", the next model is tried.
    throw Object.assign(new Error(e.name === 'TimeoutError' ? 'Gemini non ha risposto in tempo' : 'Gemini non raggiungibile'), { status: e.name === 'TimeoutError' ? 504 : 0 });
  }
  if (!res.ok) {
    let msg = '';
    try { msg = (await res.json()).error?.message || ''; } catch {}
    throw Object.assign(new Error(`Gemini: errore ${res.status}${msg ? ` (${msg.slice(0, 120)})` : ''}`), { status: res.status });
  }
  return res.json();
}

// The "flash" models the key can use, in the order they're tried (models change name over time; the list is the truth).
// Measured Nov 2026 with a free key: the newest full Flash (3.7, 3.8, gemini-flash-latest) answer 503 or hang; older
// full Flash answer but in 20-40 s; Flash-Lite answers in 1-35 s (usually ~10) and reads these pages just as well
// (14/14 on a real page, like 3-flash-preview). Retired ones (2.5) give 404. So: gemini-flash-lite-latest first (it
// always follows Google's newest Lite, no names to chase), then full Flash oldest first, then the other Lite ones
// newest first, previews and gemini-flash-latest last. Image/audio/tts variants skipped.
export async function flashModels(key) {
  const { models = [] } = await call(key, '/models?pageSize=200');
  const ok = models.filter((m) => m.supportedGenerationMethods?.includes('generateContent') && /gemini-([\d.]+-)?flash/.test(m.name)
    && !/image|audio|tts|live|thinking|embedding/.test(m.name));
  const ver = (m) => +(m.name.match(/gemini-([\d.]+)/)?.[1] || 0);
  const rank = (m) => {
    const lite = /lite/.test(m.name), latest = /latest/.test(m.name), preview = /preview|exp/.test(m.name);
    if (lite && latest) return 0;
    if (latest) return 90;
    if (lite) return (preview ? 80 : 60) - ver(m);
    return (preview ? 30 : 10) + ver(m);
  };
  ok.sort((a, b) => rank(a) - rank(b));
  if (!ok.length) throw new Error('Gemini: nessun modello Flash disponibile con questa chiave');
  return ok.map((m) => m.name); // "models/…"
}
export const pickModel = async (key) => (await flashModels(key))[0];

const SCHEMA = {
  type: 'object',
  properties: {
    days: {
      type: 'array',
      items: { type: 'object', properties: { day: { type: 'string', enum: DAYS }, lunch: { type: 'string' }, dinner: { type: 'string' } }, required: ['day', 'lunch', 'dinner'] },
    },
  },
  required: ['days'],
};

const PROMPT = (dishes) => `This photo shows a handwritten weekly meal plan from an Italian notebook. Each day (Monday to
Sunday, printed in English or Italian: Lunedì, Martedì, ...) has a line "PRANZO:" (lunch) and a line "CENA:" (dinner).
Ignore the "Shopping list"/"Lista della spesa" and "Notes" columns.
Transcribe exactly what is written for each meal, in Italian, as the writer wrote it:
- keep "/" between alternatives ("pizza / mamma"), "+", "?" and parentheses;
- include a continuation written on the next line or squeezed above the line;
- leave out words that are crossed out;
- if a day has no labels and a single line (e.g. a city), use it for both lunch and dinner;
- if a meal is empty, return "".
Return all 7 days.${dishes.length ? `\nDishes this family often writes (use the exact spelling when one matches what is written):\n${dishes.slice(0, 150).join('; ')}` : ''}`;

// jpeg: base64 JPEG of the page; returns {model, days: [{lunch, dinner}] x 7 (Monday first)}.
// Free keys allow ~5 requests a minute per model, so at most `tries` requests in all (404s, answered at once, don't
// count). Models are tried in turn (`prefer` = the one that answered last time, first), with a short pause before
// going round again. Busy (503/500) or no answer within `timeout` (504): next model. Retired (404) or over its free
// limit (429): dropped. Answers can take 20-40 s, so `timeout` is generous. onRetry(model, error) after each failure.
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
export async function readPlanWithGemini(key, jpeg, { dishes = [], model, prefer, tries = 4, budget = 100000, timeout = 45000, onRetry, sleep = pause } = {}) {
  const end = Date.now() + budget, left = () => end - Date.now();
  let list = model ? [model] : await flashModels(key);
  if (prefer && list.includes(prefer)) list = [prefer, ...list.filter((m) => m !== prefer)];
  let err;
  for (let round = 0; list.length && tries > 0; round++) {
    if (round) await sleep(Math.min(3000 * round, 8000));
    for (const m of [...list]) {
      if (tries <= 0 || (err && left() < 5000)) throw err;
      try { return await readWith(key, m, jpeg, dishes, Math.max(1000, Math.min(timeout, left()))); } catch (e) {
        err = e;
        if (![404, 429, 500, 503, 504].includes(e.status)) throw e;
        if (e.status !== 404) tries--;
        if (e.status === 404 || e.status === 429) list = list.filter((x) => x !== m);
        onRetry?.(m, e);
      }
    }
  }
  throw err;
}

// Short Italian reason for the snackbar / review note.
export const geminiWhy = (e) => (e.status === 429 ? 'limite gratuito raggiunto'
  : [500, 503].includes(e.status) ? 'i server di Google sono sovraccarichi, riprova tra qualche minuto'
  : e.status === 504 ? 'non ha risposto in tempo' : e.message);

async function readWith(key, model, jpeg, dishes, timeout) {
  const body = {
    contents: [{ parts: [{ inline_data: { mime_type: 'image/jpeg', data: jpeg } }, { text: PROMPT(dishes) }] }],
    generationConfig: { temperature: 0, responseMimeType: 'application/json', responseSchema: SCHEMA },
  };
  const r = await call(key, `/${model}:generateContent`, { method: 'POST', body: JSON.stringify(body) }, timeout);
  const text = r.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('') || '';
  let data;
  try { data = JSON.parse(text); } catch { throw new Error('Gemini: risposta non valida'); }
  const byDay = Object.fromEntries((data.days || []).map((d) => [String(d.day).toLowerCase(), d]));
  const clean = (s) => String(s || '').replace(/\s+/g, ' ').replace(/\s*\/\s*/g, ' / ').trim();
  return { model, days: DAYS.map((d) => ({ lunch: clean(byDay[d]?.lunch), dinner: clean(byDay[d]?.dinner) })) };
}
