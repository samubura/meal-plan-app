// Optional reading with Google Gemini (the user's own AI Studio key, free tier). The photo is sent
// to Google. Any failure (no key, quota, no network, plan changed) throws, and the app falls back to
// the on-phone reader. Works in the browser and in Node (fetch).

const API = 'https://generativelanguage.googleapis.com/v1beta';
const DAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];

async function call(key, path, init = {}) {
  const res = await fetch(`${API}${path}`, { ...init, headers: { 'x-goog-api-key': key, 'Content-Type': 'application/json', ...init.headers } });
  if (!res.ok) {
    let msg = '';
    try { msg = (await res.json()).error?.message || ''; } catch {}
    throw Object.assign(new Error(`Gemini: errore ${res.status}${msg ? ` (${msg.slice(0, 120)})` : ''}`), { status: res.status });
  }
  return res.json();
}

// The newest "flash" model the key can use (models change name over time; the list is the truth).
// Prefers full Flash over Flash-Lite, skips image/audio/preview-only variants when a stable one exists.
export async function pickModel(key) {
  const { models = [] } = await call(key, '/models?pageSize=200');
  const ok = models.filter((m) => m.supportedGenerationMethods?.includes('generateContent') && /gemini-[\d.]+-flash/.test(m.name)
    && !/image|audio|tts|live|thinking|embedding/.test(m.name));
  const ver = (m) => +(m.name.match(/gemini-([\d.]+)/)?.[1] || 0);
  const rank = (m) => ver(m) * 10 - (/lite/.test(m.name) ? 3 : 0) - (/preview|exp/.test(m.name) ? 1 : 0);
  ok.sort((a, b) => rank(b) - rank(a));
  if (!ok.length) throw new Error('Gemini: nessun modello Flash disponibile con questa chiave');
  return ok[0].name; // "models/…"
}

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

// jpeg: base64 JPEG of the page; returns [{lunch, dinner}] x 7 (Monday first).
export async function readPlanWithGemini(key, jpeg, { dishes = [], model } = {}) {
  model ??= await pickModel(key);
  const body = {
    contents: [{ parts: [{ inline_data: { mime_type: 'image/jpeg', data: jpeg } }, { text: PROMPT(dishes) }] }],
    generationConfig: { temperature: 0, responseMimeType: 'application/json', responseSchema: SCHEMA },
  };
  const r = await call(key, `/${model}:generateContent`, { method: 'POST', body: JSON.stringify(body) });
  const text = r.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('') || '';
  let data;
  try { data = JSON.parse(text); } catch { throw new Error('Gemini: risposta non valida'); }
  const byDay = Object.fromEntries((data.days || []).map((d) => [String(d.day).toLowerCase(), d]));
  const clean = (s) => String(s || '').replace(/\s+/g, ' ').replace(/\s*\/\s*/g, ' / ').trim();
  return { model, days: DAYS.map((d) => ({ lunch: clean(byDay[d]?.lunch), dinner: clean(byDay[d]?.dinner) })) };
}
