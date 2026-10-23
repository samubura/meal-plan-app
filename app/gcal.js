// Google Calendar sync straight from the browser: Google Identity Services token model, no backend.
// Setup (free, once): see README "Google Calendar". The client ID is public by design.
export const CLIENT_ID = '288233095312-uvg6tehfuacqp27i60959193a0f2jorh.apps.googleusercontent.com';

const SCOPES = 'https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/calendar.calendarlist.readonly';
const API = 'https://www.googleapis.com/calendar/v3';

let gis, token = null;
// Google doesn't version this script, so it can't be pinned like the others.
export const loadGis = () => (gis ??= new Promise((resolve, reject) => {
  const s = Object.assign(document.createElement('script'), { src: 'https://accounts.google.com/gsi/client', async: true });
  s.onload = resolve;
  s.onerror = () => { gis = null; reject(new Error('Could not load Google sign-in. Check your connection.')); };
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
      callback: (r) => {
        if (r.error) return reject(new Error(r.error_description || r.error));
        token = { value: r.access_token, expires: Date.now() + r.expires_in * 1000 };
        resolve(token.value);
      },
      error_callback: (e) => reject(new Error(e.type === 'popup_closed' ? 'Google sign-in was closed.' : e.message || e.type)),
    }).requestAccessToken({ prompt: '' });
  });
}

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token.value}`, ...(body && { 'Content-Type': 'application/json' }) },
    body: body && JSON.stringify(body),
  });
  if (!res.ok) throw Object.assign(new Error(`Google Calendar: ${res.status} ${res.statusText}`), { status: res.status });
  return res.status === 204 ? null : res.json();
}

// Calendars the user can add events to: [{id, summary, primary}].
export async function calendars() {
  const r = await api('/users/me/calendarList?minAccessRole=writer');
  return r.items.map(({ id, summary, summaryOverride, primary }) => ({ id, summary: summaryOverride || summary, primary: !!primary }));
}

const pad = (n) => String(n).padStart(2, '0');
const local = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:00`;

// Stable id per meal (base32hex: a-v, 0-9), so syncing a week again updates the same events.
export const eventId = (d, slot) => `meal${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}${slot === 'lunch' ? 'l' : 'd'}`;

// The same events buildICS (lib.js) writes, as Calendar API calls. Empty meals delete their event.
// Returns {saved, removed}.
export async function syncWeek(calendarId, days, weekStart, opts) {
  const [Y, M, D] = weekStart.split('-').map(Number);
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const cal = `/calendars/${encodeURIComponent(calendarId)}/events`;
  let saved = 0, removed = 0;
  await Promise.all(days.flatMap((day, i) => [
    ['lunch', 'Lunch', opts.lunchTime, opts.lunchMin],
    ['dinner', 'Dinner', opts.dinnerTime, opts.dinnerMin],
  ].map(async ([slot, label, time, mins]) => {
    const [h, m] = time.split(':').map(Number);
    const start = new Date(Y, M - 1, D + i, h, m), end = new Date(start.getTime() + mins * 60000);
    const id = eventId(start, slot), dish = (day[slot] || '').trim();
    if (!dish) {
      try { await api(`${cal}/${id}`, { method: 'DELETE' }); removed++; } catch (e) { if (![404, 410].includes(e.status)) throw e; }
      return;
    }
    const body = { id, summary: `${label}: ${dish}`, start: { dateTime: local(start), timeZone }, end: { dateTime: local(end), timeZone }, status: 'confirmed' };
    try { await api(cal, { method: 'POST', body }); } catch (e) {
      if (e.status !== 409) throw e;
      await api(`${cal}/${id}`, { method: 'PUT', body }); // exists (or was deleted): update / revive it
    }
    saved++;
  })));
  return { saved, removed };
}
