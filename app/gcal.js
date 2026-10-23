// Google Calendar sync straight from the browser: Google Identity Services token model, no backend.
// Setup (free, once): see README "Google Calendar". The client ID is public by design.
export const CLIENT_ID = '288233095312-uvg6tehfuacqp27i60959193a0f2jorh.apps.googleusercontent.com';

const SCOPES = 'https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/calendar.calendarlist.readonly';
const API = 'https://www.googleapis.com/calendar/v3';

let gis;
// The access token lasts an hour; kept across app restarts so Google isn't asked again each time.
let token = (() => { try { const t = JSON.parse(localStorage.getItem('mealplan.gtoken')); return t?.expires > Date.now() ? t : null; } catch { return null; } })();
const keepToken = (t) => { token = t; try { localStorage.setItem('mealplan.gtoken', JSON.stringify(t)); } catch {} };
// The Google account used before (the id of its primary calendar is its address): passed as a hint,
// so Google doesn't show the account chooser every time on a phone with several accounts.
const account = { get: () => { try { return localStorage.getItem('mealplan.gaccount') || ''; } catch { return ''; } },
  set: (v) => { try { if (v) localStorage.setItem('mealplan.gaccount', v); else localStorage.removeItem('mealplan.gaccount'); } catch {} } };
export const googleAccount = () => account.get();
// "Use another account": forget the account and the token.
export function forgetGoogle() { account.set(''); keepToken(null); }
// Google doesn't version this script, so it can't be pinned like the others.
export const loadGis = () => (gis ??= new Promise((resolve, reject) => {
  const s = Object.assign(document.createElement('script'), { src: 'https://accounts.google.com/gsi/client', async: true });
  s.onload = resolve;
  s.onerror = () => { gis = null; reject(new Error('Impossibile caricare l’accesso a Google. Controlla la connessione.')); };
  document.head.append(s);
}));

// Must run from a tap (it may open Google's sign-in popup). No prompt once the user has agreed.
export async function signIn() {
  if (token && token.expires > Date.now() + 60_000) return token.value;
  await loadGis();
  return new Promise((resolve, reject) => {
    globalThis.google.accounts.oauth2.initTokenClient({
      client_id: CLIENT_ID,
      scope: SCOPES,
      ...(account.get() && { hint: account.get() }),
      callback: (r) => {
        if (r.error) return reject(new Error(`Accesso a Google non riuscito: ${r.error_description || r.error}`));
        keepToken({ value: r.access_token, expires: Date.now() + r.expires_in * 1000 });
        resolve(token.value);
      },
      error_callback: (e) => reject(new Error(e.type === 'popup_closed' ? 'Hai chiuso l’accesso a Google.' : e.type === 'popup_failed_to_open' ? 'Il popup di accesso a Google è stato bloccato.' : `Accesso a Google non riuscito: ${e.message || e.type}`)),
    }).requestAccessToken({ prompt: '' });
  });
}

// Google's reason for a refusal, in Italian where it matters.
const RATE = ['rateLimitExceeded', 'userRateLimitExceeded', 'quotaExceeded'];
function apiError(status, j) {
  const reason = j?.error?.errors?.[0]?.reason || j?.error?.status || '', msg = j?.error?.message || '';
  const text = RATE.includes(reason) || status === 429 ? 'Google Calendar sta limitando le richieste: riprova tra qualche minuto.'
    : ['forbidden', 'insufficientPermissions', 'requiredAccessLevel'].includes(reason) ? 'Non hai il permesso di scrivere in quel calendario.'
      : reason === 'accessNotConfigured' ? 'Google Calendar API non attiva nel progetto Google Cloud.'
        : `Google Calendar: errore ${status}${msg ? ` (${msg.slice(0, 100)})` : ''}`;
  return Object.assign(new Error(text), { status, reason });
}
const retryable = (e) => [429, 500, 502, 503].includes(e.status) || (e.status === 403 && RATE.includes(e.reason));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// One API call; "too many requests" and server hiccups are retried after 1, 2, 4, 8 s.
async function api(path, { method = 'GET', body } = {}) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${API}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token.value}`, ...(body && { 'Content-Type': 'application/json' }) },
      body: body && JSON.stringify(body),
    });
    if (res.ok) return res.status === 204 ? null : res.json();
    if (res.status === 401) { keepToken(null); throw Object.assign(new Error('L’accesso a Google è scaduto: tocca di nuovo Sincronizza.'), { status: 401 }); }
    const e = apiError(res.status, await res.json().catch(() => null));
    if (!retryable(e) || attempt >= 4) throw e;
    await sleep(1000 * 2 ** attempt + Math.random() * 300);
  }
}

// Calendars the user can add events to: [{id, summary, primary}], a family calendar first (the one
// Google creates for a family group, shared by its members), then other shared ones, then the personal one.
export async function calendars() {
  const r = await api('/users/me/calendarList?minAccessRole=writer');
  account.set(r.items.find((c) => c.primary)?.id || account.get());
  const rank = (c) => (/famil/i.test(c.summary) ? 0 : c.primary ? 2 : 1);
  return r.items.map(({ id, summary, summaryOverride, primary }) => ({ id, summary: summaryOverride || summary, primary: !!primary }))
    .sort((a, b) => rank(a) - rank(b));
}

const pad = (n) => String(n).padStart(2, '0');
const local = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:00`;

// Stable id per meal (base32hex: a-v, 0-9), so syncing a week again updates the same events.
export const eventId = (d, slot) => `meal${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}${slot === 'lunch' ? 'l' : 'd'}`;

// The same events buildICS (lib.js) writes, as Calendar API calls, one at a time (Google limits bursts).
// previous: the week as last synced ({weekStart, days}), so events known to exist are updated directly
// and only those are deleted when a meal is emptied; if the week start changed, the old week's events go.
// Returns {saved, removed}.
export async function syncWeek(calendarId, days, weekStart, opts, previous = null) {
  if (!account.get()) account.set((await api('/users/me/calendarList/primary').catch(() => null))?.id || '');
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const cal = `/calendars/${encodeURIComponent(calendarId)}/events`;
  const slots = (ws, ds) => ds.flatMap((day, i) => [['lunch', 'Pranzo', opts.lunchTime, opts.lunchMin], ['dinner', 'Cena', opts.dinnerTime, opts.dinnerMin]]
    .map(([slot, label, time, mins]) => {
      const [Y, M, D] = ws.split('-').map(Number), [h, m] = time.split(':').map(Number);
      const start = new Date(Y, M - 1, D + i, h, m);
      return { id: eventId(start, slot), slot, label, start, end: new Date(start.getTime() + mins * 60000), dish: (day[slot] || '').trim() };
    }));
  const known = new Set(previous?.weekStart === weekStart ? slots(weekStart, previous.days).filter((x) => x.dish).map((x) => x.id) : []);
  const del = async (id) => { try { await api(`${cal}/${id}`, { method: 'DELETE' }); return 1; } catch (e) { if ([404, 410].includes(e.status)) return 0; throw e; } };
  let saved = 0, removed = 0;
  if (previous && previous.weekStart !== weekStart) for (const x of slots(previous.weekStart, previous.days)) if (x.dish) removed += await del(x.id);
  for (const x of slots(weekStart, days)) {
    if (!x.dish) { if (known.has(x.id)) removed += await del(x.id); continue; }
    const body = { id: x.id, summary: `${x.label}: ${x.dish}`, start: { dateTime: local(x.start), timeZone }, end: { dateTime: local(x.end), timeZone }, status: 'confirmed',
      // A popup from the Google Calendar app before the meal (opts.reminder minutes; 0 = none).
      reminders: { useDefault: false, overrides: opts.reminder > 0 ? [{ method: 'popup', minutes: opts.reminder }] : [] } };
    if (known.has(x.id)) {
      try { await api(`${cal}/${x.id}`, { method: 'PUT', body }); } catch (e) { if (e.status !== 404) throw e; await api(cal, { method: 'POST', body }); }
    } else {
      try { await api(cal, { method: 'POST', body }); } catch (e) {
        if (e.status !== 409) throw e;
        await api(`${cal}/${x.id}`, { method: 'PUT', body }); // already there (or deleted before): update / revive it
      }
    }
    saved++;
  }
  return { saved, removed };
}
