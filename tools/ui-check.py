"""Headless UI check at phone size: serves app/, scans a dataset photo, reviews, syncs to a mocked
Google Calendar, drags a meal onto another slot, edits one, re-syncs, reloads.
Usage: python3 tools/ui-check.py OUT_DIR [photo]   (needs `pip install playwright && playwright install chromium`)"""
import functools, http.server, json, pathlib, re, sys, threading, time
from playwright.sync_api import sync_playwright

root = pathlib.Path(__file__).resolve().parent.parent
out = pathlib.Path(sys.argv[1]); out.mkdir(parents=True, exist_ok=True)
photo = root / 'private' / 'dataset' / (sys.argv[2] if len(sys.argv) > 2 else 'photo_2026-10-23_13-36-03.jpg')

handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(root / 'app'))
handler.log_message = lambda *a: None
srv = http.server.ThreadingHTTPServer(('127.0.0.1', 0), handler)
threading.Thread(target=srv.serve_forever, daemon=True).start()
url = f'http://127.0.0.1:{srv.server_port}/'

calls = []
def gapi(route):
    r = route.request
    calls.append((r.method, r.url.split('/calendar/v3')[1], r.post_data))
    if 'calendarList' in r.url:
        return route.fulfill(json={'items': [{'id': 'me@x', 'summary': 'Me', 'primary': True}, {'id': 'family@group', 'summary': 'Family'}]})
    if r.method == 'POST' and r.url.endswith('/events') and '"id":"meal20261026l"' in (r.post_data or ''):
        return route.fulfill(status=409, json={})  # already there: the app must update it
    if r.method == 'DELETE':
        return route.fulfill(status=404, json={})
    return route.fulfill(json={})

def sent_since(n):
    return {json.loads(c[2])['id']: json.loads(c[2])['summary'] for c in calls[n:] if c[0] in ('POST', 'PUT') and c[2]}

def wait_snack(page, text):
    page.wait_for_function(f'document.querySelector("#snack").classList.contains("show") && document.querySelector("#snack").textContent.includes({json.dumps(text)})')
    return page.text_content('#snack')

def dish(page, i):
    return page.text_content(f'.meal[data-i="{i}"] .dishname')

with sync_playwright() as p:
    b = p.chromium.launch(args=['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'])
    ctx = b.new_context(viewport={'width': 390, 'height': 844}, device_scale_factor=2, is_mobile=True, has_touch=True, accept_downloads=True)
    page = ctx.new_page()
    errors = []
    page.on('pageerror', lambda e: errors.append(str(e)))
    # A client ID is configured and Google sign-in grants a token at once; the Calendar API is mocked.
    page.route('**/gcal.js', lambda r: r.fulfill(content_type='text/javascript',
        body=re.sub(r"export const CLIENT_ID = '[^']*';", "export const CLIENT_ID = 'test';", (root / 'app' / 'gcal.js').read_text())))
    page.route('https://accounts.google.com/gsi/client', lambda r: r.fulfill(content_type='text/javascript', body=
        "window.google={accounts:{oauth2:{initTokenClient:(o)=>({requestAccessToken:()=>setTimeout(()=>o.callback({access_token:'t',expires_in:3600}),10)})}}};"))
    page.route('https://www.googleapis.com/calendar/v3/**', gapi)

    # 1. First launch: the scan screen; the in-app camera opens and closes.
    page.goto(url)
    page.wait_for_selector('#scan:not([hidden])')
    page.screenshot(path=out / '1-scan.png')
    page.click('#takePhoto'); page.wait_for_selector('#cam:not([hidden])'); page.wait_for_timeout(600)
    page.screenshot(path=out / '2-camera.png')
    page.click('#camClose'); assert page.is_hidden('#cam')

    # 2. Scan a real photo -> review.
    t0 = time.time()
    page.set_input_files('#gallery', str(photo))
    page.wait_for_selector('#working:not([hidden])'); page.wait_for_timeout(1200)
    page.screenshot(path=out / '3-working.png')
    page.wait_for_selector('#review:not([hidden])', timeout=300_000)
    print(f'scan took {time.time() - t0:.1f}s in headless Chromium')
    page.screenshot(path=out / '4-review.png', full_page=True)
    page.fill('#r-wed-dinner', 'carne e zucchine')
    # Long dishes wrap and the field grows: nothing to scroll inside a field.
    page.fill('#r-thu-lunch', 'pasta fredda con pesto, pomodorini, mozzarella e olive nere')
    box = page.evaluate('(() => { const e = document.querySelector("#r-thu-lunch"); return [e.scrollHeight, e.clientHeight, e.scrollWidth, e.clientWidth, e.offsetHeight]; })()')
    assert box[0] <= box[1] + 2 and box[2] <= box[3] and box[4] > 50, box
    page.screenshot(path=out / '4b-review-long.png')

    # 3. Save and sync: pick the calendar (Family first), back on the plan.
    page.click('#saveSync')
    page.wait_for_selector('#calSheet.open')
    assert page.locator('#calList label').first.text_content().startswith('Family')
    page.screenshot(path=out / '5-calendar.png')
    page.click('#calOk')
    print('sync:', wait_snack(page, 'Fatto'))
    assert page.is_visible('#home') and page.text_content('#syncText') == 'Sincronizzato'
    page.wait_for_timeout(400)
    page.screenshot(path=out / '6-plan.png', full_page=True)
    posts = [json.loads(c[2]) for c in calls if c[0] == 'POST' and c[2]]
    assert all(re.fullmatch(r'meal2026\d{4}[ld]', x['id']) and x['summary'].startswith(('Pranzo: ', 'Cena: ')) and x['start']['timeZone'] for x in posts)
    assert any(c[0] == 'PUT' and c[1].endswith('/meal20261026l') for c in calls), 'conflict must update'
    print('first sync:', {m: sum(c[0] == m for c in calls) for m in ('POST', 'PUT', 'DELETE')}, '| e.g.', posts[0]['summary'], posts[0]['start']['dateTime'])

    # 4. Drag Monday lunch (slot 0) onto Tuesday dinner (slot 3).
    a, d = dish(page, 0), dish(page, 3)
    h = page.locator('[data-drag="0"]').bounding_box()
    tgt = page.locator('.meal[data-i="3"]').bounding_box()
    page.mouse.move(h['x'] + h['width'] / 2, h['y'] + h['height'] / 2); page.mouse.down()
    for k in range(1, 11):
        page.mouse.move(h['x'] + h['width'] / 2, h['y'] + h['height'] / 2 + (tgt['y'] + tgt['height'] / 2 - h['y'] - h['height'] / 2) * k / 10)
        page.wait_for_timeout(30)
    page.screenshot(path=out / '7-dragging.png')
    page.mouse.up()
    assert (dish(page, 0), dish(page, 3)) == (d, a), (dish(page, 0), dish(page, 3))
    assert page.text_content('#syncText') == 'Sincronizza'
    print('drag:', repr(a), '<->', repr(d))

    # 5. Edit Monday dinner in the sheet.
    page.click('.meal[data-i="1"] .open'); page.wait_for_selector('#editSheet.open')
    page.fill('#editText', 'carne e z')  # remembered from the review: offered as a chip
    page.wait_for_selector('#suggest:not([hidden]) button')
    assert page.text_content('#suggest button') == 'carne e zucchine'
    page.screenshot(path=out / '8a-suggest.png')
    page.fill('#editText', 'pesce e patate')
    page.screenshot(path=out / '8-edit.png')
    page.click('#editSave'); page.wait_for_timeout(300)
    assert dish(page, 1) == 'pesce e patate'

    # 6. Re-sync: the same event ids carry the new dishes.
    n = len(calls)
    page.click('#syncBtn'); wait_snack(page, 'Fatto')
    sent = sent_since(n)
    assert sent['meal20261026l'] == f'Pranzo: {d}' and sent['meal20261027d'] == f'Cena: {a}' and sent['meal20261026d'] == 'Cena: pesce e patate', sent
    assert not any('calendarList' in c[1] for c in calls[n:]), 'the chosen calendar is remembered'
    print('re-sync: ok')

    # 7. Settings sheet, closed by the back button.
    page.click('#menuBtn'); page.wait_for_selector('#settingsSheet.open')
    assert page.text_content('#calName') == 'Family'
    page.screenshot(path=out / '9-settings.png')
    page.go_back(); page.wait_for_timeout(300)
    assert not page.is_visible('#settingsSheet') and page.is_visible('#home')

    # 8. Reload: the plan is still there.
    page.reload(); page.wait_for_selector('#home:not([hidden])')
    assert dish(page, 0) == d and dish(page, 1) == 'pesce e patate' and page.text_content('#syncText') == 'Sincronizzato'
    print('reload: ok')
    print('horizontal overflow:', page.evaluate('document.documentElement.scrollWidth > window.innerWidth'))
    print('page errors:', errors or 'none')
    ctx.close()

    # Optional Gemini reading (mocked): used when it answers, on-phone fallback when it fails.
    for mode in ('ok', 'quota'):
        ctx = b.new_context(viewport={'width': 390, 'height': 844}, device_scale_factor=2, is_mobile=True, has_touch=True)
        page = ctx.new_page()
        def gem(route, *_, mode=mode):  # Playwright may pass the request as 2nd argument
            if '/models?' in route.request.url:
                return route.fulfill(json={'models': [{'name': 'models/gemini-3.6-flash', 'supportedGenerationMethods': ['generateContent']}]})
            if mode == 'quota':
                return route.fulfill(status=429, json={'error': {'message': 'Quota exceeded'}})
            days = [{'day': d, 'lunch': 'speck e zucchine', 'dinner': 'Toscana / mamma'} for d in ('monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday')]
            return route.fulfill(json={'candidates': [{'content': {'parts': [{'text': json.dumps({'days': days})}]}}]})
        page.route('https://generativelanguage.googleapis.com/**', gem)
        page.goto(url); page.evaluate('localStorage.setItem("mealplan.geminiKey", JSON.stringify("test-key"))'); page.reload()
        page.wait_for_selector('#scan:not([hidden])')
        page.set_input_files('#gallery', str(photo))
        page.wait_for_selector('#review:not([hidden])', timeout=300_000)
        note, mon = page.text_content('#reviewNote'), page.input_value('#r-mon-lunch')
        if mode == 'ok':
            assert note.startswith('Letto con Gemini') and mon == 'speck e zucchine' and page.input_value('#r-mon-dinner') == 'Toscana / mamma', (note, mon)
        else:
            assert note.startswith('Gemini non disponibile (limite gratuito raggiunto)') and mon and mon != 'speck e zucchine', (note, mon)
        print(f'gemini {mode}: ok ({note[:60]}…)')
        ctx.close()

    # Dark mode, same plan.
    ctx = b.new_context(viewport={'width': 390, 'height': 844}, device_scale_factor=2, color_scheme='dark', is_mobile=True, has_touch=True)
    page = ctx.new_page()
    page.goto(url)
    page.evaluate('(w) => localStorage.setItem("mealplan.week", w)', json.dumps({'weekStart': '2026-10-26', 'raw': '', 'synced': None,
        'days': [{'lunch': {'text': 'pasta al pesto', 'edited': False}, 'dinner': {'text': 'Toscana / mamma', 'edited': False}}] * 7}))
    page.reload(); page.wait_for_selector('#home:not([hidden])')
    page.screenshot(path=out / '10-plan-dark.png')
    ctx.close()
    b.close()
srv.shutdown()
