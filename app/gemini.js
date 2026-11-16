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
// Oldest first: the newest are often overloaded for free keys (503, or no answer for minutes, seen Oct 2026 on 3.6-3.8)
// and an older Flash reads these pages fine. Full Flash before previews, Flash-Lite last; image/audio variants skipped.
export async function flashModels(key) {
  const { models = [] } = await call(key, '/models?pageSize=200');
  const ok = models.filter((m) => m.supportedGenerationMethods?.includes('generateContent') && /gemini-([\d.]+-)?flash/.test(m.name)
    && !/image|audio|tts|live|thinking|embedding/.test(m.name));
  const ver = (m) => +(m.name.match(/gemini-([\d.]+)/)?.[1] || 0);
  // "-latest" aliases (gemini-flash-latest) point at the newest model: after the numbered full Flash ones.
  const rank = (m) => (/lite/.test(m.name) ? 200 : 0) + (/preview|exp/.test(m.name) ? 100 : 0) + (/latest/.test(m.name) ? 50 : 0) + ver(m);
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
// Free keys get frequent 503s ("high demand") that usually clear within seconds, so instead of a fixed number of
// tries, the models are tried in turn (`prefer` = the one that answered last time, first) and the round is repeated
// after a growing pause, until `budget` ms are spent. Busy (503/500) or no answer (504): kept for the next round.
// Retired (404) or over its free daily limit (429, counted per model): dropped. Each attempt gets at most `timeout` ms.
// onRetry(model, error) is called after each failed attempt (the app shows "riprovo").
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
export async function readPlanWithGemini(key, jpeg, { dishes = [], model, prefer, budget = 50000, timeout = 20000, onRetry, sleep = pause } = {}) {
  const end = Date.now() + budget, left = () => end - Date.now();
  let list = model ? [model] : await flashModels(key);
  if (prefer && list.includes(prefer)) list = [prefer, ...list.filter((m) => m !== prefer)];
  let err;
  for (let round = 0; list.length; round++) {
    for (const m of [...list]) {
      if (err && left() < 3000) throw err;
      try { return await readWith(key, m, jpeg, dishes, Math.max(1000, Math.min(timeout, left()))); } catch (e) {
        err = e;
        if (![404, 429, 500, 503, 504].includes(e.status)) throw e;
        if (e.status === 404 || e.status === 429) list = list.filter((x) => x !== m);
        onRetry?.(m, e);
      }
    }
    const wait = Math.min(2000 * 2 ** round, 8000) * (0.75 + Math.random() / 2);
    if (!list.length || left() < wait + 3000) break;
    await sleep(wait);
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
