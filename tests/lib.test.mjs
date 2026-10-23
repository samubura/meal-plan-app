import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePlan, matchDay, matchMeal, correctDish, snapDish, findLayout, buildICS, fold } from '../app/lib.js';

test('day headings: multilingual, accents, garbled', () => {
  assert.equal(matchDay('Monday'), 0);
  assert.equal(matchDay('Lunedì'), 0);
  assert.equal(matchDay('Mercoledi'), 2);
  assert.equal(matchDay('Weanesday'), 2);
  assert.equal(matchDay('Thursclay'), 3);
  assert.equal(matchDay('segunda-feira'), 0);
  assert.equal(matchDay('Samstag'), 5);
  assert.equal(matchDay('domenica'), 6);
  assert.equal(matchDay('salmone'), -1);
});

test('meal labels: garbled handwriting', () => {
  for (const t of ['PRANZO:', 'PRANID-', 'PRAND-', 'Pramo:', 'Promo.', 'lunch', 'Déjeuner']) assert.equal(matchMeal(t), 'lunch', t);
  for (const t of ['CENA:', 'CEMA', 'Cenk:', 'dinner', 'Abendessen', 'jantar']) assert.equal(matchMeal(t), 'dinner', t);
  assert.equal(matchMeal('pasta'), null);
  assert.equal(matchMeal('carne'), null);
});

test('parsePlan: clean text with headings', () => {
  const days = parsePlan('Meal plan\nMonday\nPRANZO: pasta al pesto\nCENA: carne e insalata\nTuesday\nPRANZO: farro\nCENA: pizza\nNotes');
  assert.deepEqual(days[0], { lunch: 'pasta al pesto', dinner: 'carne e insalata' });
  assert.deepEqual(days[1], { lunch: 'farro', dinner: 'pizza' });
  assert.deepEqual(days[2], { lunch: '', dinner: '' });
});

test('parsePlan: missing headings, a repeated lunch label starts the next day', () => {
  const days = parsePlan('PRANZO: a1\nCENA: a2\nPRANID: b1\nCEMA: b2\nThursday\nPRANZO: d1\nCENA: d2\nPRANZO: e1');
  assert.deepEqual(days.slice(0, 5), [
    { lunch: 'a1', dinner: 'a2' }, { lunch: 'b1', dinner: 'b2' }, { lunch: '', dinner: '' },
    { lunch: 'd1', dinner: 'd2' }, { lunch: 'e1', dinner: '' },
  ]);
});

test('parsePlan: unlabelled block, first line lunch, rest dinner', () => {
  const days = parsePlan('Lunedì\nrisotto\npolpette\nspinaci\nMartedì\nPranzo: pesto');
  assert.deepEqual(days[0], { lunch: 'risotto', dinner: 'polpette spinaci' });
  assert.equal(days[1].lunch, 'pesto');
});

test('correctDish: common handwriting misreads', () => {
  assert.equal(correctDish('pesce 2 patate').text, 'pesce e patate');
  assert.equal(correctDish('carne e 2ucchine').text, 'carne e zucchine');
  assert.equal(correctDish('N20: passato verdure').text, 'passato verdure');
  assert.equal(correctDish('omelette | mozzarella').text, 'omelette / mozzarella');
  assert.equal(correctDish('caprese i i').text, 'caprese');
  assert.equal(correctDish('scamorza e insalata').score > correctDish('Scamona e Salve').score, true);
});

test('snapDish: remembered dishes', () => {
  assert.equal(snapDish('specke zucchme', ['speck e zucchine', 'pasta al sugo']), 'speck e zucchine');
  assert.equal(snapDish('carbonara', ['speck e zucchine']), 'carbonara');
});

test('findLayout: places all 14 rows from label boxes, fills a missed label', () => {
  const word = (text, x0, y) => ({ text, confidence: 90, bbox: { x0, y0: y - 15, x1: x0 + 120, y1: y + 15 } });
  const words = [];
  for (let d = 0; d < 7; d++) {
    const y = 300 + d * 250;
    words.push(word(['Lunedì', 'Martedì', 'Mercoledì', 'Giovedì', 'Venerdì', 'Sabato', 'Domenica'][d], 300, y));
    if (d !== 3) words.push(word('Pranzo:', 300, y + 90));
    words.push(word('Cena:', 300, y + 180));
    words.push(word('zucchine', 700, y + 180)); // dish text must not count as a label
  }
  const rows = findLayout(words, 1238);
  assert.equal(rows.length, 14);
  const thuLunch = rows.find((r) => r.day === 3 && r.slot === 'lunch');
  assert.equal(thuLunch.found, false);
  assert.ok(Math.abs(thuLunch.y - (300 + 3 * 250 + 90)) < 15);
  assert.ok(rows.filter((r) => r.found).every((r) => r.x0 === 300));
});

test('fold: 75-octet lines, never splits UTF-8', () => {
  const line = `SUMMARY:${'è'.repeat(60)}`;
  const parts = fold(line).split('\r\n');
  for (const p of parts) assert.ok(new TextEncoder().encode(p).length <= 75);
  assert.equal(parts.map((p, i) => (i ? p.slice(1) : p)).join(''), line);
});

test('buildICS: floating times, escaping, skipped empties, stable UIDs', () => {
  const days = Array.from({ length: 7 }, () => ({ lunch: '', dinner: '' }));
  days[0] = { lunch: 'pasta, sugo; basilico \\ olio', dinner: '' };
  days[6] = { lunch: 'risotto', dinner: 'pizza' };
  const opts = { lunchTime: '12:30', dinnerTime: '19:00', lunchMin: 45, dinnerMin: 60 };
  const a = buildICS(days, '2026-10-26', opts, new Date(Date.UTC(2026, 9, 23, 10)));
  const b = buildICS(days, '2026-10-26', opts, new Date(Date.UTC(2026, 9, 24, 10)));
  assert.ok(a.endsWith('\r\n') && !/[^\r]\n/.test(a));
  assert.equal((a.match(/BEGIN:VEVENT/g) || []).length, 3);
  assert.match(a, /SUMMARY:Pranzo: pasta\\, sugo\\; basilico \\\\ olio/);
  assert.match(a, /DTSTART:20261026T123000\r\nDTEND:20261026T131500/);
  assert.match(a, /UID:meal-2026-11-01-dinner@mealplan-scanner\r\nDTSTAMP:\d{8}T\d{6}Z\r\nDTSTART:20261101T190000\r\nDTEND:20261101T200000/);
  assert.doesNotMatch(a, /DTSTART:\d{8}T\d{6}Z/);
  const uids = (s) => s.match(/UID:.*/g);
  assert.deepEqual(uids(a), uids(b));
});

test('CTC decoding: model probabilities pick the vocabulary word', async () => {
  const { ctcLogP, greedyWords, decoderFor } = await import('../app/ocr.js');
  // Frames that read "came" on the best path, but leave room for "carne".
  const frames = [{ c: 0.9, '': 0.1 }, { a: 0.9, '': 0.1 }, { m: 0.5, r: 0.4, '': 0.1 }, { '': 0.5, n: 0.4, m: 0.1 }, { e: 0.9, '': 0.1 },
    { ' ': 0.9, '': 0.1 }, { e: 0.9, '': 0.1 }];
  assert.deepEqual(greedyWords(frames).map((w) => w.word), ['came', 'e']);
  assert.ok(ctcLogP(frames, 'carne e') > ctcLogP(frames, 'xyz e'));
  assert.equal(decoderFor([])(frames), 'carne');
  assert.equal(decoderFor(['came e'])(frames, { dishes: ['carne e insalata', 'came e'] }), 'came e');
  // A slash read as "l" between two known words.
  const F = (s) => [...s].map((c) => (c === '_' ? { '': 0.9 } : { [c]: 0.7, '': 0.2 }));
  assert.equal(decoderFor([])(F('p_i_z_z_a_l_m_a_m_m_a')), 'pizza / mamma');
  assert.equal(decoderFor([])(F('p_i_z_z_a_/_m_a_m_m_a')), 'pizza / mamma');
  // An unknown name with a trailing slash read as "l", keeping the writer's capitals.
  assert.equal(decoderFor([])(F('t_o_s_c_a_n_a_l_ _m_a_m_m_a'), { original: 'Toscanal mamma' }), 'Toscana / mamma');
  assert.equal(decoderFor([])(F('c_o_c_k_t_a_i_l')), 'cocktail');
  // "+": kept when read, split off a word, a lone "t" between words, a circled plus read as ④.
  assert.equal(decoderFor([])(F('p_a_s_t_a_ _+_ _b_u_r_g_e_r')), 'pasta + burger');
  assert.equal(decoderFor([])(F('z_u_c_c_h_i_n_e_+_b_u_r_g_e_r')), 'zucchine + burger');
  assert.equal(decoderFor([])(F('v_e_r_d_u_r_e_ _t_ _p_a_t_a_t_e')), 'verdure + patate');
  assert.equal(decoderFor([])(F('s_u_g_o_ _④_ _b_u_r_g_e_r')), 'sugo + burger');
});

test('Google Calendar event ids: stable and base32hex', async () => {
  const { eventId } = await import('../app/gcal.js');
  assert.equal(eventId(new Date(2026, 9, 26), 'lunch'), 'meal20261026l');
  assert.equal(eventId(new Date(2026, 10, 1), 'dinner'), 'meal20261101d');
  assert.match(eventId(new Date(2026, 0, 5), 'dinner'), /^[a-v0-9]{5,}$/);
});

test('rotateRGBA: quarter turns, and four of them are the identity', async () => {
  const { rotateRGBA } = await import('../app/lib.js');
  const w = 3, h = 2, px = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) px[i * 4] = i;
  const red = (r) => [...Array(r.w * r.h)].map((_, i) => r.rgba[i * 4]);
  assert.deepEqual(red(rotateRGBA(px, w, h, 1)), [3, 0, 4, 1, 5, 2]);
  assert.deepEqual(red(rotateRGBA(px, w, h, 2)), [5, 4, 3, 2, 1, 0]);
  let r = { rgba: px, w, h };
  for (let k = 0; k < 4; k++) r = rotateRGBA(r.rgba, r.w, r.h, 1);
  assert.deepEqual(red(r), [0, 1, 2, 3, 4, 5]);
});

test('Gemini reading: picks the newest Flash model, parses the plan, reports errors', async () => {
  const { readPlanWithGemini, pickModel, flashModels } = await import('../app/gemini.js');
  const real = globalThis.fetch;
  const reply = (status, body) => ({ ok: status < 400, status, json: async () => body });
  try {
    globalThis.fetch = async (url, init) => {
      if (url.includes('/models?')) return reply(200, { models: [
        { name: 'models/gemini-3.5-flash-lite', supportedGenerationMethods: ['generateContent'] },
        { name: 'models/gemini-3.6-flash', supportedGenerationMethods: ['generateContent'] },
        { name: 'models/gemini-3.6-flash-image', supportedGenerationMethods: ['generateContent'] },
        { name: 'models/text-embedding-9', supportedGenerationMethods: ['embedContent'] }] });
      assert.match(url, /gemini-3\.6-flash:generateContent$/);
      assert.equal(init.headers['x-goog-api-key'], 'k');
      const days = [{ day: 'monday', lunch: 'pasta  al  pesto', dinner: 'pizza/mamma' }, { day: 'sunday', lunch: 'Roma', dinner: 'Roma' }];
      return reply(200, { candidates: [{ content: { parts: [{ text: JSON.stringify({ days }) }] } }] });
    };
    assert.equal(await pickModel('k'), 'models/gemini-3.6-flash');
    assert.deepEqual(await flashModels('k'), ['models/gemini-3.6-flash', 'models/gemini-3.5-flash-lite']);
    const r = await readPlanWithGemini('k', 'AAAA');
    assert.deepEqual(r.days[0], { lunch: 'pasta al pesto', dinner: 'pizza / mamma' });
    assert.deepEqual(r.days[6], { lunch: 'Roma', dinner: 'Roma' });
    assert.deepEqual(r.days[3], { lunch: '', dinner: '' });
    globalThis.fetch = async () => reply(429, { error: { message: 'Quota exceeded' } });
    await assert.rejects(readPlanWithGemini('k', 'AAAA', { model: 'models/x' }), (e) => e.status === 429);
  } finally { globalThis.fetch = real; }
});

test('history: categories, statistics, calendar recovery', async () => {
  const { categorize, historyStats, mergeCalendarMeals } = await import('../app/lib.js');
  assert.deepEqual([...categorize('speck e zucchine')].sort(), ['salumi', 'verdure']);
  assert.deepEqual([...categorize('pasta al sugo + burger veg')].sort(), ['pasta', 'veg']);
  assert.deepEqual([...categorize('findus e patate')].sort(), ['pesce', 'verdure']);
  assert.deepEqual([...categorize('passato verdure + primo sale')].sort(), ['formaggi', 'verdure']);
  assert.deepEqual([...categorize('Ancona')], ['altro']);
  const week = (l, d) => ({ days: Array.from({ length: 7 }, () => [l, d]), source: 'app' });
  const h = { '2026-10-19': week('pasta al pesto', 'carne e insalata'), '2026-10-26': week('Pasta al pesto', '') };
  const s = historyStats(h);
  assert.equal(s.weeks, 2); assert.equal(s.meals, 21);
  assert.deepEqual(s.top[0], { dish: 'pasta al pesto', count: 14 });
  assert.equal(s.categories.find((c) => c.key === 'pasta').count, 14);
  assert.equal(historyStats(h, { from: '2026-10-26' }).meals, 7);
  // Calendar events: rebuilt into weeks (Monday-based); weeks the app has are kept.
  const n = mergeCalendarMeals(h, [{ id: 'meal20261013d', summary: 'Cena: pizza / mamma' }, { id: 'meal20261012l', summary: 'Pranzo: farro' },
    { id: 'meal20261026l', summary: 'Pranzo: altro' }, { id: 'x1', summary: 'Riunione' }]);
  assert.equal(n, 1);
  assert.deepEqual(h['2026-10-12'].days.slice(0, 2), [['farro', ''], ['', 'pizza / mamma']]);
  assert.equal(h['2026-10-26'].days[0][0], 'Pasta al pesto');
});
