"""Validate buildICS output with the icalendar library: python3 tests/validate_ics.py (needs `pip install icalendar`)."""
import pathlib, subprocess
from icalendar import Calendar

root = pathlib.Path(__file__).resolve().parent.parent
js = """
import { buildICS } from './app/lib.js';
const days = [['pasta al pesto, basilico', 'carne e insalata'], ['', 'pizza; birra'], ['', ''], ['farro', ''],
  ['tortellini con la panna', 'pesce e patate'], ['avocado toast', 'pizzeria (pizza)'], ['Roma / nonna', 'caprese ' + 'è'.repeat(40)]]
  .map(([lunch, dinner]) => ({ lunch, dinner }));
process.stdout.write(buildICS(days, '2026-10-26', { lunchTime: '12:30', dinnerTime: '19:00', lunchMin: 45, dinnerMin: 60 }));
"""
ics = subprocess.run(['node', '--input-type=module', '-e', js], cwd=root, capture_output=True, check=True).stdout
assert all(len(l) <= 75 for l in ics.split(b'\r\n')), 'line longer than 75 octets'
cal = Calendar.from_ical(ics)
events = cal.walk('VEVENT')
assert len(events) == 10, len(events)  # 14 slots minus 4 empty
uids = [str(e['UID']) for e in events]
assert len(set(uids)) == len(uids)
assert uids[0] == 'meal-2026-10-26-lunch@mealplan-scanner', uids[0]
for e in events:
    start, end = e['DTSTART'].dt, e['DTEND'].dt
    assert start.tzinfo is None and end.tzinfo is None, 'times must be floating'
    assert str(e['SUMMARY']).startswith(('Pranzo: ', 'Cena: '))
    assert (end - start).total_seconds() / 60 == (45 if start.hour == 12 else 60)
assert str(events[0]['SUMMARY']) == 'Pranzo: pasta al pesto, basilico'
assert str(events[2]['SUMMARY']) == 'Cena: pizza; birra'
assert str(events[-1]['SUMMARY']).endswith('è' * 40)
print(f'OK: {len(events)} events, UIDs {uids[0]} ... {uids[-1]}')
