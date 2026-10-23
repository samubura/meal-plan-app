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
limited = {'left': 1}  # Google answers one request with 403 rateLimitExceeded: the app must retry
def gapi(route):
    r = route.request
    calls.append((r.method, r.url.split('/calendar/v3')[1], r.post_data))
    if r.method == 'PUT' and limited['left']:
        limited['left'] -= 1
        return route.fulfill(status=403, json={'error': {'errors': [{'reason': 'rateLimitExceeded'}], 'message': 'Rate Limit Exceeded'}})
    if r.url.endswith('/calendarList/primary'):
        return route.fulfill(json={'id': 'me@x', 'summary': 'Me', 'primary': True})
    if 'calendarList' in r.url:
        return route.fulfill(json={'items': [{'id': 'me@x', 'summary': 'Me', 'primary': True}, {'id': 'family@group', 'summary': 'Family'}]})
    if r.method == 'GET' and '/events?' in r.url:  # meal events read back for the history (one page each)
        return route.fulfill(json={'items': [{'id': 'meal20261012l', 'summary': 'Pranzo: farro e ceci'}, {'id': 'meal20261013d', 'summary': 'Cena: pizza / mamma'},
            {'id': 'meal20261026l', 'summary': 'Pranzo: pasta al pesto'}, {'id': 'abc123', 'summary': 'Dentista'}]})
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
    bx = [page.locator(sel).bounding_box() for sel in ('#takePhoto', 'label[for=gallery]', '#manual')]
    assert all(bx[i + 1]['y'] - (bx[i]['y'] + bx[i]['height']) >= 10 for i in range(2)), bx  # spaced, not touching
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
    n_unsure = page.locator('#reviewDays textarea.unsure').count()
    assert n_unsure == 0 or 'giallo' in page.text_content('#reviewNote')
    print(f'unsure highlighted: {n_unsure} of 14')
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
    assert page.is_visible('#todayCard') and page.locator('#todayCard .next').count() == 1, 'today card with the next meal'
    print('today card:', page.text_content('#todayCard .head').strip())
    page.click('#todayCard .today-meal'); page.wait_for_timeout(700)
    di = page.get_attribute('#todayCard', 'data-day')
    top = page.evaluate(f'document.querySelector(".day[data-day=\\"{di}\\"]").getBoundingClientRect().top')
    assert 0 <= top < 200, top  # scrolled to that day
    page.evaluate('window.scrollTo(0, 0)')
    posts = [json.loads(c[2]) for c in calls if c[0] == 'POST' and c[2]]
    assert all(re.fullmatch(r'meal2026\d{4}[ld]', x['id']) and x['summary'].startswith(('Pranzo: ', 'Cena: ')) and x['start']['timeZone'] for x in posts)
    assert all(x['reminders'] == {'useDefault': False, 'overrides': [{'method': 'popup', 'minutes': 30}]} for x in posts), 'reminder 30 min before'
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
    # Undo from the snackbar, then drag again.
    page.wait_for_selector('#snack.show button'); page.screenshot(path=out / '7b-undo.png')
    page.click('#snack button')
    assert (dish(page, 0), dish(page, 3)) == (a, d) and page.text_content('#syncText') == 'Sincronizzato'
    page.mouse.move(h['x'] + h['width'] / 2, h['y'] + h['height'] / 2); page.mouse.down()
    for k in range(1, 11):
        page.mouse.move(h['x'] + h['width'] / 2, h['y'] + h['height'] / 2 + (tgt['y'] + tgt['height'] / 2 - h['y'] - h['height'] / 2) * k / 10)
        page.wait_for_timeout(20)
    page.mouse.up()
    assert (dish(page, 0), dish(page, 3)) == (d, a)
    print('undo: ok')

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
    resync = calls[n:]
    assert all(c[0] == 'PUT' for c in resync), [c[0] for c in resync]  # known events: updated directly
    assert len(resync) == 14, len(resync)  # one request per meal
    assert limited['left'] == 0 and sum(c[0] == 'PUT' and c[1].endswith('/meal20261026l') for c in calls[:n]) == 2, 'the 403 rate limit was retried'
    print('re-sync requests:', len(resync), '(one update per meal); 403 rate limit retried: ok')
    assert sent['meal20261026l'] == f'Pranzo: {d}' and sent['meal20261027d'] == f'Cena: {a}' and sent['meal20261026d'] == 'Cena: pesce e patate', sent
    assert not any('calendarList' in c[1] for c in calls[n:]), 'the chosen calendar and account are remembered'
    print('re-sync: ok')

    # 7. Settings sheet, closed by the back button.
    page.click('#menuBtn'); page.wait_for_selector('#settingsSheet.open')
    assert page.text_content('#calName') == 'Family'
    assert page.text_content('#gAccount') == 'Account: me@x'  # remembered, passed to Google as a hint
    # Gemini key: checked with Google (mocked) before it is saved; the switch shows only with a valid key.
    page.route('https://generativelanguage.googleapis.com/**', lambda r: r.fulfill(json={'models': [{'name': 'models/gemini-3.6-flash', 'supportedGenerationMethods': ['generateContent']}]})
        if r.request.headers.get('x-goog-api-key') == 'good' else r.fulfill(status=400, json={'error': {'message': 'API key not valid'}}))
    page.fill('#geminiKey', 'bad'); page.dispatch_event('#geminiKey', 'change'); wait_snack(page, 'Chiave non valida')
    assert page.evaluate('localStorage.getItem("mealplan.geminiKey")') in (None, 'null')
    page.fill('#geminiKey', 'good'); page.dispatch_event('#geminiKey', 'change'); wait_snack(page, 'Chiave valida')
    assert json.loads(page.evaluate('localStorage.getItem("mealplan.geminiKey")')) == 'good'
    page.fill('#geminiKey', ''); page.dispatch_event('#geminiKey', 'change')
    print('gemini key check: ok')
    page.screenshot(path=out / '9-settings.png')
    page.go_back(); page.wait_for_timeout(300)
    assert not page.is_visible('#settingsSheet') and page.is_visible('#home')
    # Dragging the sheet down closes it (finger simulated with touch events).
    page.click('#menuBtn'); page.wait_for_selector('#settingsSheet.open'); page.wait_for_timeout(300)
    page.evaluate('''() => { const el = document.querySelector('#settingsSheet');
      const t = (y) => new Touch({ identifier: 1, target: el, clientX: 200, clientY: y });
      el.dispatchEvent(new TouchEvent('touchstart', { touches: [t(300)], bubbles: true }));
      for (const y of [340, 420, 520]) el.dispatchEvent(new TouchEvent('touchmove', { touches: [t(y)], bubbles: true, cancelable: true }));
      el.dispatchEvent(new TouchEvent('touchend', { touches: [], bubbles: true })); }''')
    page.wait_for_timeout(400)
    assert not page.is_visible('#settingsSheet') and page.is_visible('#home'), 'drag down closes the sheet'
    assert page.evaluate('getComputedStyle(document.documentElement).overscrollBehaviorY') == 'none', 'no pull-to-refresh'
    print('sheet drag-to-close: ok')

    # 8. Reload: the plan is still there.
    page.reload(); page.wait_for_selector('#home:not([hidden])')
    assert dish(page, 0) == d and dish(page, 1) == 'pesce e patate' and page.text_content('#syncText') == 'Sincronizzato'
    print('reload: ok')

    # 9. Statistics from the history; past weeks recovered from the calendar (this week's own copy is kept).
    page.click('#statsLink'); page.wait_for_selector('#stats:not([hidden])')
    assert page.text_content('.tile b') == '1' and page.locator('.bars li').count() >= 3, page.text_content('#statsBody')
    page.click('#recover'); print('recover:', wait_snack(page, 'Recuperata 1 settimana'))
    assert 'dal calendario' in page.text_content('#weeks') and page.locator('#weeks details').count() == 2
    page.click('input[name=period][value=all] + span')
    assert page.text_content('.tile b') == '2'
    page.screenshot(path=out / '11-stats.png', full_page=True)
    # 10. Categories: from the stats, give a dish the user's own categories, then back to automatic.
    page.click('#statsBody [data-cat=""]'); page.wait_for_selector('#cats:not([hidden])')
    page.select_option('#catFilter', 'all'); first = page.text_content('.dishrow .d').strip()
    page.click('.dishrow'); page.wait_for_selector('#catSheet.open')
    page.screenshot(path=out / '13-cat-sheet.png')
    for cb in page.query_selector_all('#catChecks input'):
        if cb.is_checked(): cb.evaluate('el => el.click()')
    page.click('#catChecks input[value=uova] + span'); page.click('#catSave')
    print('category:', wait_snack(page, 'Uova'))
    assert 'scelte da te' in page.text_content('#catList li')
    page.screenshot(path=out / '14-cats.png', full_page=True)
    page.go_back(); page.wait_for_selector('#stats:not([hidden])')
    assert page.is_visible('.bars [data-cat=uova]')
    page.click('.bars [data-cat=uova]'); page.wait_for_selector('#cats:not([hidden])')
    assert page.input_value('#catFilter') == 'uova'
    page.click('.dishrow'); page.wait_for_selector('#catSheet.open'); page.click('#catAuto')
    wait_snack(page, 'automatiche'); assert 'scelte da te' not in page.text_content('#catList')
    print('categories: ok'); page.go_back(); page.wait_for_selector('#stats:not([hidden])')
    print('horizontal overflow (stats):', page.evaluate('document.documentElement.scrollWidth > window.innerWidth'))
    page.go_back(); page.wait_for_selector('#home:not([hidden])')
    print('horizontal overflow:', page.evaluate('document.documentElement.scrollWidth > window.innerWidth'))
    print('page errors:', errors or 'none')
    ctx.close()

    # Fresh install: nothing on the phone; the weeks and the coming week's plan come back from the calendar.
    ctx = b.new_context(viewport={'width': 390, 'height': 844}, device_scale_factor=2, is_mobile=True, has_touch=True)
    page = ctx.new_page()
    page.route('**/gcal.js', lambda r: r.fulfill(content_type='text/javascript',
        body=re.sub(r"export const CLIENT_ID = '[^']*';", "export const CLIENT_ID = 'test';", (root / 'app' / 'gcal.js').read_text())))
    page.route('https://accounts.google.com/gsi/client', lambda r: r.fulfill(content_type='text/javascript', body=
        "window.google={accounts:{oauth2:{initTokenClient:(o)=>({requestAccessToken:()=>setTimeout(()=>o.callback({access_token:'t',expires_in:3600}),10)})}}};"))
    page.route('https://www.googleapis.com/calendar/v3/**', gapi)
    page.goto(url); page.wait_for_selector('#scan:not([hidden])')
    page.click('#scanRecover'); page.wait_for_selector('#stats:not([hidden])')
    page.click('#recover'); page.wait_for_selector('#calSheet.open'); page.click('#calOk')
    print('fresh recover:', wait_snack(page, 'Recuperate 2 settimane'))
    page.go_back(); page.go_back(); page.wait_for_selector('#home:not([hidden])')
    assert dish(page, 0) == 'pasta al pesto' and page.text_content('#syncText') == 'Sincronizzato', dish(page, 0)
    print('fresh install recovery: ok')
    ctx.close()

    # Optional Gemini reading (mocked): used when it answers, on-phone fallback when it fails.
    for mode in ('ok', 'quota', 'reread'):
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
        assert page.is_visible('#geminiRow') and not page.is_checked('#useGemini'), 'Gemini is a choice, off until chosen'
        if mode != 'reread':
            page.check('#useGemini'); page.reload(); page.wait_for_selector('#scan:not([hidden])')
            assert page.is_checked('#useGemini'), 'the choice is remembered'
        page.set_input_files('#gallery', str(photo))
        page.wait_for_selector('#review:not([hidden])', timeout=300_000)
        if mode == 'reread':  # read on the phone, then "Rileggi con Gemini" on the same photo
            assert page.is_visible('#reread') and page.input_value('#r-mon-lunch') != 'speck e zucchine'
            page.click('#reread'); page.wait_for_function('document.querySelector("#reviewNote").textContent.startsWith("Riletto")')
            assert page.input_value('#r-mon-lunch') == 'speck e zucchine'
            print('gemini reread: ok'); ctx.close(); continue
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
    page.click('#statsLink'); page.wait_for_selector('#stats:not([hidden])')
    page.screenshot(path=out / '12-stats-dark.png', full_page=True)
    ctx.close()
    b.close()
srv.shutdown()
