// Italian food vocabulary + word-pair counts (private/food-it.json), built from the
// recipes of Italian Wikibooks' "Libro di cucina" (CC BY-SA 4.0): titles and ingredient lines.
// Usage: node tools/build-lexicon.mjs   (network; ~20 API requests)
import fs from 'node:fs';
import path from 'node:path';

const API = 'https://it.wikibooks.org/w/api.php';
const UA = { 'User-Agent': 'meal-plan-scanner lexicon builder (personal, non-commercial)' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Polite: one request every 1.5 s, and back off when the API says we're too fast.
async function get(params) {
  for (let wait = 1500; ; wait *= 2) {
    await sleep(wait);
    const res = await fetch(`${API}?${new URLSearchParams({ format: 'json', maxlag: 5, ...params })}`, { headers: UA });
    const text = await res.text();
    try { return JSON.parse(text); } catch { if (wait > 60000) throw new Error(text.slice(0, 200)); }
  }
}

const titles = [];
for (let cont = {}; ;) {
  const r = await get({ action: 'query', list: 'allpages', apprefix: 'Libro di cucina/Ricette/', apnamespace: 0, aplimit: 500, ...cont });
  titles.push(...r.query.allpages.map((p) => p.title));
  if (!r.continue) break;
  cont = { apcontinue: r.continue.apcontinue };
}

const phrases = [];
for (let i = 0; i < titles.length; i += 50) {
  const r = await get({ action: 'query', prop: 'revisions', rvprop: 'content', rvslots: 'main', titles: titles.slice(i, i + 50).join('|') });
  for (const p of Object.values(r.query.pages)) {
    phrases.push(p.title.split('/').pop());
    const text = p.revisions?.[0]?.slots?.main?.['*'] || '';
    // Ingredient lines: "* 200 g di [[farina]]", inside the "Ingredienti" part of the page.
    const ing = text.split(/==+\s*(Ingredienti|Procedimento|Preparazione)[^=]*==+/i);
    const block = ing.length > 2 ? ing[2] : '';
    for (const line of block.split('\n')) if (/^\s*\*/.test(line)) phrases.push(line);
  }
}

const clean = (s) => s.toLowerCase().replace(/\[\[(?:[^|\]]*\|)?([^\]]*)\]\]/g, '$1').replace(/\{\{[^}]*\}\}|<[^>]+>|\([^)]*\)/g, ' ')
  .replace(/[’']/g, ' ').replace(/[^a-zàèéìíòóù\s]/g, ' ').split(/\s+/).filter((w) => w.length >= 2 || ['e', 'o', 'a', 'i'].includes(w));
// Measures and filler that ingredient lists are full of but menus never use.
const SKIP = new Set('g gr kg ml cl dl lt litro litri cucchiai cucchiaio cucchiaino cucchiaini qb q b pizzico bicchiere bicchieri tazza tazze grammi etto etti circa n pz spicchio spicchi foglie foglia rametto mazzetto noce cl'.split(' '));
const words = {}, pairs = {};
for (const ph of phrases) {
  const ws = clean(ph).filter((w) => !SKIP.has(w));
  ws.forEach((w, j) => {
    words[w] = (words[w] || 0) + 1;
    if (j) pairs[`${ws[j - 1]} ${w}`] = (pairs[`${ws[j - 1]} ${w}`] || 0) + 1;
  });
}
const keep = (o, min) => Object.fromEntries(Object.entries(o).filter(([, c]) => c >= min).sort((a, b) => b[1] - a[1]));
const out = { source: 'it.wikibooks.org Libro di cucina (CC BY-SA 4.0)', recipes: titles.length, words: keep(words, 2), pairs: keep(pairs, 2) };
// Measured: it doesn't help (cookbook grammar isn't menu grammar), so it isn't shipped; kept for experiments.
const file = path.join(path.dirname(path.dirname(new URL(import.meta.url).pathname)), 'private', 'food-it.json');
fs.writeFileSync(file, JSON.stringify(out));
console.log(`${titles.length} recipes, ${phrases.length} phrases -> ${Object.keys(out.words).length} words, ${Object.keys(out.pairs).length} pairs, ${(fs.statSync(file).size / 1024).toFixed(0)} KB`);
console.log('top words:', Object.keys(out.words).slice(0, 40).join(' '));
console.log('top pairs:', Object.keys(out.pairs).slice(0, 25).join(' | '));
