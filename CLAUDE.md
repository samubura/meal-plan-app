# Meal Plan Scanner (PWA)

Static PWA on GitHub Pages: photo of a handwritten weekly meal plan -> on-phone OCR -> review ->
one-tap sync to a shared Google calendar (or .ics). Free, no backend, photos never leave the phone.
The user is Italian (talks to me in Italian) and uses an Android phone; UI is Italian, greens palette.

## Layout
- `app/` = everything published (Pages workflow `.github/workflows/pages.yml` uploads only this folder).
  - `index.html`: app UI (Italian, Material-like) + browser glue. Screens on the history stack (home > scan >
    working/review): `home` = the saved plan (localStorage `mealplan.week`; drag ≡ to swap slots, tap = edit
    sheet with "Sposta in", sync pill dirty/clean via a snapshot), `scan`, `working`, `review` (first sync);
    bottom sheets (edit, settings, calendar pick), snackbar. In-app camera (getUserMedia + ImageCapture,
    system camera fallback). Defaults 12:45/60 and 20:00/60. `tools/ui-check.py` drives the whole flow.
  - `lib.js`: pure logic (no DOM), shared with Node tools: image prep, `findLayout`, `traceRow`, `tighten`,
    `parsePlan` (fallback), `FOOD_WORDS`, `correctDish`/`pickDish`/`snapDish` (Tesseract-era path),
    `scanPlan(rgba, w, h, recognize, {readLine, decode, dishes, ...})`, `daysFromReads`, `buildICS`.
  - `ocr.js`: PP-OCRv5 Latin recognizer (`createRecognizer(ort, model, dict)`), CTC helpers
    (`toFrames`, `ctcLogP` with a slash class, `greedyWords`), `decodeLine` (word-pair model `makeLM`,
    slash inference) and `decoderFor(dishes)` = what the app uses.
  - `gemini.js`: optional reading with the user's own AI Studio key (settings; photo sent to Google). `pickModel`
    lists the key's models and takes the newest Flash; `readPlanWithGemini` uses a JSON schema. Any failure or
    45 s timeout -> the on-phone pipeline. `tools/gemini-bench.mjs` (key in `private/gemini.key`).
  - `gcal.js`: Google Identity Services token client + Calendar API upsert (`syncWeek`, ids `meal<yyyymmdd><l|d>`).
    `CLIENT_ID` is empty until the user does the README setup; the button is hidden while empty.
  - `models/latin_PP-OCRv5_mobile_rec.{onnx,dict.json}` (from HF nakamura196/ppocrv5-mobile-web-onnx, Apache-2.0).
  - `sw.js`: shell network-first, `models/` cache-first, jsDelivr/Fonts stale-while-revalidate. Bump cache names on changes.
- `private/` (git-ignored, never commit): `dataset/` (14 photos + `truth.json`), `dataset-full/` (13 full-res
  originals of the same pages, same names), `full-res/` (user's originals), `fixtures/`, `lines/`, `train/` (venv, fold models, cv dumps).
- `tests/lib.test.mjs` (synthetic only), `tests/private.test.mjs` (skips without private/), `tests/validate_ics.py`.
- `tools/`: `ocr-bench.mjs` (end-to-end; `--engine=ppocr --personal --fold=k --model= --dump= --log`, env `DATASET`, `DEGRADE`),
  `photos.mjs` (loading, folds), `score.mjs`, `eval.mjs` + `cv-report.mjs` + `lm-tune.mjs` + `pick-tune.mjs` (offline re-scoring of dumps),
  `fails.mjs`, `crops.mjs` (contact sheets), `make-lines.mjs` + `train/finetune.py` (fine-tuning), `build-lexicon.mjs`
  (Wikibooks lexicon, not shipped), `make-icons.py`, `ui-check.py` (Playwright 390x844, mocks Google APIs).

## Commands
`npm test` · `node tools/ocr-bench.mjs --engine=ppocr [--personal]` · `node tools/cv-report.mjs private/train/cv`
· `python3 tools/ui-check.py OUT` (needs a venv with playwright) · training venv: `private/train/venv` (torch CPU, onnx2torch).
CPU training heats the user's laptop: never run folds in parallel with benches; 4 parallel folds sometimes crash silently, run alone if so.

## Results (Oct 2026, 196 meals; details in README)
Shipped: stock PP-OCRv5 + ink-tight crops + context-aware CTC decoding with slash handling; scored
slash-aware: 118/196 exact first scan, 136/196 with remembered dishes (leave-one-out), ~96% right slot.
`scanPlan` auto-rotates (0/90/270/180, by labels found). Event titles "Pranzo: …"/"Cena: …".
Extra lines: only the strip under dinners (beside the next day's heading). Tried and rejected: the same
strip above lunches (it holds the previous dinner's second line) and per-meal zone segmentation by ink
profile (close lines merge; finds ruled lines instead). Lunch notes are small text on top of the line.
Rejected after measuring: fine-tuning on the user's pages (better on repeated dishes, worse on new ones: 134 vs 139),
Wikibooks cookbook lexicon, full-res photos (no gain), TrOCR, big general dictionary, second-line capture, binary/lum inputs.

## Next ideas
1. More pages (with transcriptions) -> retry fine-tuning with fewer epochs / synthetic lines of new phrases; gate on "new dishes".
2. Better wrapped-line and above-line notes capture (several "wrong" dishes are text outside the line).
3. Replace the Tesseract layout pass with PP-OCRv5 det to drop ~7 MB and a second engine.
4. On-device bigger model only if accuracy must jump (check on-device ML Kit GenAI image support for the user's phone first).
