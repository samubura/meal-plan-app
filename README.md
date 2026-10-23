# Meal Plan Scanner

A phone web app (PWA) that reads a photo of a handwritten weekly meal plan (PRANZO / CENA,
Monday to Sunday) and puts the meals straight into a shared Google calendar.
It is fully static and free: no server, no paid services, and the photo never leaves the phone.
Handwriting is read in the browser by a small PaddleOCR model.

## Use it (the app is in Italian)
1. **Nuova settimana › Scatta una foto** opens the in-app camera: a page-shaped guide, a torch for dim
   kitchens, a full-resolution still photo. **Scegli dalla galleria** picks an existing one. Sideways or
   upside-down photos are straightened automatically.
2. **Controlla i pasti**: a few seconds later the week appears; fix anything that's wrong, then
   **Salva e sincronizza**. The first time, sign in and pick the calendar (a family-group "Family"
   calendar is offered first). Events are "Pranzo: …" 12:45–13:45 and "Cena: …" 20:00–21:00.
3. **Piano** (the home screen) keeps the week. Drag a meal by its ≡ handle onto another slot to swap them,
   tap a meal to edit it (or move it with "Sposta in"). The button at the top shows **Sincronizza** when
   there are changes and **Sincronizzato** when Google Calendar is up to date; syncing again updates the
   same events and removes the ones you emptied. ⋮ has the times, the calendar, the .ics download and
   what the scan read.

Dishes you type or fix are remembered: they're suggested while typing and help the next scans read your
writing. Android's back button closes sheets and screens like in a native app.

The first scan downloads the reader once (the 8 MB model, its runtime and Tesseract's data: roughly
20–30 MB). After that the scan works offline; only the calendar sync needs internet.

## One-time setup: Google Calendar (free, ~10 minutes)
1. Go to [console.cloud.google.com](https://console.cloud.google.com/) and create a project (no billing needed).
2. *APIs & Services › Library*: enable **Google Calendar API**.
3. *APIs & Services › OAuth consent screen*: choose **External**, fill in the app name and your email.
   Add the scopes `calendar.events` and `calendar.calendarlist.readonly`. Under **Test users**, add your
   Google account and your partner's.
4. *APIs & Services › Credentials › Create credentials › OAuth client ID*: type **Web application**,
   authorized JavaScript origin `https://<your-user>.github.io`.
5. Put the client ID in `app/gcal.js` (`export const CLIENT_ID = '…'`; already done for this repo) and push. The client ID is
   public by design; nothing secret is stored.

Google shows an "unverified app" warning the first time (it's your own app: *Advanced › Continue*).
In testing mode Google may ask you to approve again after a while.

## Deploy on GitHub Pages
1. Push the repo to GitHub (public is fine: see Privacy).
2. *Settings › Pages › Source*: **GitHub Actions**. The workflow `.github/workflows/pages.yml` runs the
   tests and publishes **only the `app/` folder**.
3. Open `https://<your-user>.github.io/<repo>/` on the phone and install it:
   Android Chrome › ⋮ › *Install app*; iPhone Safari › Share › *Add to Home Screen*.

## Privacy
- Photos are processed on the phone and never uploaded.
- Your photos, their transcriptions, real OCR output and training data live in `private/`. It is
  git-ignored, so it is never committed or published.
- The repo's tests use made-up data. `tests/private.test.mjs` runs only when `private/` exists.
- Remembered dishes and settings stay in the browser's localStorage.

## How the scan works
1. **Layout** (`app/lib.js`, `findLayout`): Tesseract finds the printed day names and the PRANZO/CENA
   labels on the whole page. A grid of 7 days × 2 meals is fitted through them, and missed labels are
   predicted. This finds the right row for ~96% of meals. If the labels aren't found, the photo is
   tried turned by 90°, 270° and 180°, so sideways photos work too.
2. **Line images** (`traceRow`, `tighten`): each meal row follows the handwriting (which often slopes),
   is cropped to its ink and contrast-stretched.
3. **Reading** (`app/ocr.js`): PaddleOCR PP-OCRv5 Latin recognizer (Apache-2.0) in onnxruntime-web, one line at a time.
4. **Context-aware decoding**: per word, the reader's character probabilities (CTC) score the
   raw reading against nearby words from an Italian food vocabulary and your remembered dishes. A
   word-pair model built from your own dishes ("speck e zucchine") picks the likeliest whole line.
   "/" (two options, or two things in one slot) is handled explicitly: the reader often sees it as
   l, |, 1 or [, so "pizzalmamma" can come out as "pizza / mamma". A remembered dish replaces the
   line when it explains the handwriting well.

## Measured accuracy
14 real pages (3 handwriting styles, English and Italian notebooks), 196 meals. "Exact" means the whole
dish text matches what's written (case and accents aside). Remembered dishes are leave-one-out: each page
only gets the dishes from the *other* pages.

| Version | Right slot | Exact | Exact, with remembered dishes |
|---|---|---|---|
| Tesseract for the dishes (first version) | 173 (88%) | 64 (33%) | 74 (38%) |
| PaddleOCR recognizer | 183 | 93 | 101 |
| + lines cropped to the ink | 189 | 108 | 110 |
| + decoding with the model's probabilities | 187 | 122 (62%) | 134 |
| + word-pair model from your dishes | 190 (97%) | 122 (62%) | 139 (71%) |
| + slash handling, scored slash-aware (shipped) | 189 (96%) | 118 (60%) | **136 (69%)** |

The last row uses stricter scoring: "pizza mamma" no longer counts as "pizza / mamma". Dishes written
with a "/" went from 0/24 exact to 7/24 (11/24 with remembered dishes). Turned photos give the same
results as upright ones.

Measured and **not** shipped:
- **Fine-tuning the recognizer on these pages** (`tools/train/`, 4-fold cross-validation on unseen pages):
  91% exact on dishes written before, but only 52% on new dishes. It memorises phrases, so the stock
  model is kept.
- **A cookbook vocabulary** (768 Wikibooks recipes): recipe grammar isn't menu grammar, and it lowered accuracy.
- **Full-resolution originals vs messenger copies:** no difference (112 vs 116 exact); the small
  reader, not the image, is the limit.
- TrOCR (invents English words), a large general Italian dictionary, and reading wrapped second lines.

## Development
```sh
npm install                        # dev only: tesseract.js, jpeg-js, onnxruntime-node for the tools
npm test                           # unit tests (+ private ones when private/ exists)
python3 -m http.server -d app      # then open http://localhost:8000
node tools/ocr-bench.mjs [--personal] [--log]   # accuracy on private/dataset (local only)
python3 tests/validate_ics.py      # .ics checked with the icalendar library
python3 tools/ui-check.py OUT      # phone-size browser run: real scan + mocked Google Calendar
```
