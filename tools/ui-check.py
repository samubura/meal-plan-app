"""Headless UI check at phone size: serves app/, scans a dataset photo, exports the .ics and syncs
to a mocked Google Calendar.
Usage: python3 tools/ui-check.py OUT_DIR [photo]   (needs `pip install playwright && playwright install chromium`)"""
import http.server, pathlib, re, sys, threading, time, functools
from playwright.sync_api import sync_playwright

root = pathlib.Path(__file__).resolve().parent.parent
out = pathlib.Path(sys.argv[1]); out.mkdir(parents=True, exist_ok=True)
photo = root / 'private' / 'dataset' / (sys.argv[2] if len(sys.argv) > 2 else 'photo_2026-10-23_13-36-03.jpg')

handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(root / 'app'))
handler.log_message = lambda *a: None
srv = http.server.ThreadingHTTPServer(('127.0.0.1', 0), handler)
threading.Thread(target=srv.serve_forever, daemon=True).start()
url = f'http://127.0.0.1:{srv.server_port}/'

with sync_playwright() as p:
    b = p.chromium.launch()
    for scheme in ('light', 'dark'):
        ctx = b.new_context(viewport={'width': 390, 'height': 844}, device_scale_factor=2, color_scheme=scheme,
                            is_mobile=True, has_touch=True, accept_downloads=True)
        page = ctx.new_page()
        errors = []
        page.on('pageerror', lambda e: errors.append(str(e)))
        page.on('console', lambda m: m.type == 'error' and errors.append(m.text))
        # Pretend a client ID is configured and Google sign-in grants a token at once.
        page.route('**/gcal.js', lambda r: r.fulfill(content_type='text/javascript',
            body=re.sub(r"export const CLIENT_ID = '[^']*';", "export const CLIENT_ID = 'test';", (root / 'app' / 'gcal.js').read_text())))
        page.route('https://accounts.google.com/gsi/client', lambda r: r.fulfill(content_type='text/javascript', body=
            "window.google={accounts:{oauth2:{initTokenClient:(o)=>({requestAccessToken:()=>setTimeout(()=>o.callback({access_token:'t',expires_in:3600}),10)})}}};"))
        page.goto(url)
        page.screenshot(path=out / f'1-capture-{scheme}.png')
        if scheme == 'dark':  # layout only; the scan itself ran in light mode
            page.click('#manual'); page.screenshot(path=out / '3-review-dark.png', full_page=True)
            ctx.close(); continue
        t0 = time.time()
        page.set_input_files('#gallery', str(photo))
        page.wait_for_selector('#working:not([hidden])')
        page.wait_for_timeout(1500)
        page.screenshot(path=out / '2-working.png')
        page.wait_for_selector('#review:not([hidden])', timeout=300_000)
        print(f'scan took {time.time() - t0:.1f}s in headless Chromium')
        page.screenshot(path=out / '3-review.png', full_page=True)
        vals = page.eval_on_selector_all('.dish', 'els => els.map(e => e.value)')
        for i in range(7): print(f'  {i} L: {vals[2*i]!r:40} D: {vals[2*i+1]!r}')
        page.fill('#wed-dinner', 'carne e zucchine')  # an edit: only edited dishes are remembered
        # Google Calendar sync against mocked Google endpoints.
        calls = []
        def gapi(route):
            r = route.request
            calls.append((r.method, r.url.split('/calendar/v3')[1], r.post_data))
            if 'calendarList' in r.url:
                return route.fulfill(json={'items': [{'id': 'me@x', 'summary': 'Me', 'primary': True}, {'id': 'family@group', 'summary': 'Family'}]})
            if r.method == 'POST' and r.url.endswith('/events') and '"id":"meal20261026l"' in (r.post_data or ''):
                return route.fulfill(status=409, json={})
            if r.method == 'DELETE':
                return route.fulfill(status=404, json={})
            return route.fulfill(json={})
        page.route('https://www.googleapis.com/calendar/v3/**', gapi)
        with page.expect_download() as dl:
            page.click('#save')
        dl.value.save_as(out / dl.value.suggested_filename)
        page.wait_for_selector('#saved:not([hidden])')
        page.click('#gsync')
        page.wait_for_selector('#calPick:not([hidden])')
        assert page.input_value('#calendar') == 'family@group'
        page.screenshot(path=out / '4-pick-calendar.png', full_page=True)
        page.click('#gsync')
        page.wait_for_selector('#saved:has-text("Done:")')
        print('sync:', page.text_content('#saved'))
        page.screenshot(path=out / '5-synced.png', full_page=True)
        ev = [c for c in calls if '/events' in c[1]]
        import json as _j, re as _re
        posts = [_j.loads(c[2]) for c in ev if c[0] == 'POST']
        assert all(_re.fullmatch(r'meal2026\d{4}[ld]', p['id']) for p in posts), posts
        assert all(p['start']['timeZone'] and p['summary'].startswith(('Lunch: ', 'Dinner: ')) for p in posts)
        assert any(c[0] == 'PUT' and c[1].endswith('/meal20261026l') for c in ev), 'conflict must update'
        print('requests:', {m: sum(c[0] == m for c in ev) for m in ('POST', 'PUT', 'DELETE')}, '| example', posts[0])
        n = len(calls)
        page.click('#gsync'); page.wait_for_function(f'document.querySelector("#saved").textContent.startsWith("Done:")')
        assert not any('calendarList' in c[1] for c in calls[n:]), 'second sync reuses the saved calendar'
        print('saved', dl.value.suggested_filename, 'remembered dishes:', page.evaluate("JSON.parse(localStorage.getItem('mealplan.dishes')).length"))
        overflow = page.evaluate('document.documentElement.scrollWidth > window.innerWidth')
        print('horizontal overflow:', overflow)
        print('errors:', errors or 'none')
        ctx.close()
    b.close()
srv.shutdown()
