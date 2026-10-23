"""Fine-tune the PP-OCRv5 Latin line recognizer on the user's own handwriting (CPU, PyTorch).

The app's ONNX model is converted to PyTorch (onnx2torch), trained with CTC loss on the line images
from tools/make-lines.mjs (private/lines), and exported back to ONNX with the same input/output.

  private/train/venv/bin/python tools/train/finetune.py --fold 0 --out private/train/fold0.onnx   # cross-validation
  private/train/venv/bin/python tools/train/finetune.py --out app/models/rec-personal.onnx       # all photos

Needs: torch (CPU), torchvision, onnx, onnx2torch, onnxruntime, pillow, numpy.
"""
import argparse, json, math, pathlib, random
import numpy as np, onnx, onnxruntime as ort, torch
import torch.nn.functional as F
from onnx2torch import convert
from PIL import Image, ImageFilter

ROOT = pathlib.Path(__file__).resolve().parents[2]
H = 48

# Same page photographed twice: always in the same fold.
SAME = {'photo_2026-10-23_13-36-08.jpg': 'photo_2026-10-23_13-36-01 (2).jpg'}


def folds(photos, k):
    groups = sorted({SAME.get(p, p) for p in photos})
    return {p: groups.index(SAME.get(p, p)) % k for p in photos}


def base_model(path):
    """Constant-folded copy of the app model (onnx2torch needs weights as initializers)."""
    if not path.exists():
        so = ort.SessionOptions()
        so.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_BASIC
        so.optimized_model_filepath = str(path)
        so.log_severity_level = 3
        ort.InferenceSession(str(ROOT / 'app/models/latin_PP-OCRv5_mobile_rec.onnx'), so)
    return convert(onnx.load(str(path)))


def augment(img, rng):
    w, h = img.size
    img = img.rotate(rng.uniform(-2, 2), resample=Image.BILINEAR, expand=True, fillcolor=255)
    sh = rng.uniform(-0.25, 0.25)  # slant
    w, h = img.size
    img = img.transform((w + int(abs(sh) * h), h), Image.AFFINE, (1, sh, -abs(sh) * h if sh > 0 else 0, 0, 1, 0), Image.BILINEAR, fillcolor=255)
    w, h = img.size
    t, b = int(rng.uniform(-0.08, 0.15) * h), int(rng.uniform(-0.08, 0.15) * h)  # vertical crop / pad
    img = img.crop((0, -t, w, h + b))
    img = img.resize((max(8, int(img.size[0] * rng.uniform(0.85, 1.15))), img.size[1]), Image.BILINEAR)
    if rng.random() < 0.5:
        img = img.filter(ImageFilter.GaussianBlur(rng.uniform(0.2, 1.2)))
    a = np.asarray(img, dtype=np.float32)
    lo, hi = rng.uniform(0, 70), rng.uniform(180, 255)  # contrast / dim light
    a = lo + a * (hi - lo) / 255
    a += np.random.default_rng(rng.randrange(1 << 30)).normal(0, rng.uniform(0, 8), a.shape)
    return Image.fromarray(np.clip(a, 0, 255).astype(np.uint8))


def to_tensor(img):
    w, h = img.size
    W = max(16, min(1600, round(w * H / h)))
    a = np.asarray(img.resize((W, H), Image.BILINEAR), dtype=np.float32) / 127.5 - 1
    return torch.from_numpy(a)


def batches(items, size, rng, aug):
    items = items[:]
    rng.shuffle(items)
    for i in range(0, len(items), size):
        chunk = items[i:i + size]
        xs = [to_tensor(augment(img, rng) if aug else img) for img, _ in chunk]
        Wm = max(x.shape[1] for x in xs)
        x = torch.ones(len(xs), 3, H, Wm)  # pad with paper (white = 1)
        for j, t in enumerate(xs):
            x[j, :, :, :t.shape[1]] = t
        yield x, [lab for _, lab in chunk]


def fold(c):
    import unicodedata
    return ''.join(ch for ch in unicodedata.normalize('NFD', c) if not unicodedata.combining(ch)).lower()


def folding(chars):
    """Matrix pooling every class into its lowercase, accent-free class (column 0 = blank).
    Training on pooled classes means a label typed as "Roma" fits handwriting "ROMA" too;
    the app's decoder (ocr.js) compares case- and accent-insensitively as well."""
    folded = ['']
    for c in chars[1:]:
        if fold(c) not in folded:
            folded.append(fold(c))
    M = torch.zeros(len(chars), len(folded))
    for i, c in enumerate(chars):
        M[i, folded.index(fold(c)) if i else 0] = 1
    return M, {c: i for i, c in enumerate(folded)}


def greedy(probs, chars):
    out, prev = [], -1
    for c in probs.argmax(-1).tolist():
        if c != prev and c != 0:
            out.append(chars[c])
        prev = c
    return ''.join(out).strip()


def cer(a, b):
    import difflib
    return 1 - difflib.SequenceMatcher(None, a, b).ratio()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--fold', type=int, help='hold out this fold (of --folds); omit to train on everything')
    ap.add_argument('--folds', type=int, default=4)
    ap.add_argument('--epochs', type=int, default=40)
    ap.add_argument('--lr', type=float, default=2e-4)
    ap.add_argument('--batch', type=int, default=16)
    ap.add_argument('--seed', type=int, default=0)
    ap.add_argument('--threads', type=int, default=16)
    ap.add_argument('--out', required=True)
    a = ap.parse_args()
    torch.manual_seed(a.seed)
    rng = random.Random(a.seed)
    torch.set_num_threads(a.threads)

    chars = [''] + json.loads((ROOT / 'app/models/latin_PP-OCRv5_mobile_rec.dict.json').read_text()) + [' ']
    M, idx = folding(chars)
    lines = ROOT / 'private/lines'
    rows = [l.split('\t') for l in (lines / 'labels.tsv').read_text().splitlines() if l]
    fold_of = folds({r[2] for r in rows}, a.folds)
    train, held = [], []
    for name, label, photo, _ in rows:
        tgt = [idx[fold(c)] for c in label if fold(c) in idx]
        if not tgt:
            continue
        item = (Image.open(lines / name).convert('L'), (label, tgt))
        (held if a.fold is not None and fold_of[photo] == a.fold else train).append(item)
    print(f'train {len(train)} lines, held out {len(held)}')

    net = base_model(ROOT / 'private/train/rec-basic.onnx')
    opt = torch.optim.AdamW([p for p in net.parameters() if p.requires_grad], lr=a.lr, weight_decay=1e-4)
    steps = a.epochs * math.ceil(len(train) / a.batch)
    sched = torch.optim.lr_scheduler.OneCycleLR(opt, max_lr=a.lr, total_steps=steps, pct_start=0.1)

    def evaluate(items):
        net.eval()
        with torch.no_grad():
            errs = [cer(fold(greedy(net(torch.stack([to_tensor(img)] * 3)[None])[0], chars)), fold(lab[0])) for img, lab in items]
        net.train()
        return sum(errs) / max(1, len(errs))

    if held:
        print(f'epoch 0 held-out CER {evaluate(held):.3f}')
    for ep in range(1, a.epochs + 1):
        tot = 0
        for x, labs in batches(train, a.batch, rng, aug=True):
            probs = net(x)
            logp = (probs @ M).clamp_min(1e-8).log().permute(1, 0, 2)  # T, B, folded classes
            T = logp.shape[0]
            tg = torch.tensor([i for _, t in labs for i in t])
            loss = F.ctc_loss(logp, tg, torch.full((len(labs),), T, dtype=torch.long), torch.tensor([len(t) for _, t in labs]), blank=0, zero_infinity=True)
            opt.zero_grad()
            loss.backward()
            opt.step()
            sched.step()
            tot += loss.item()
        if ep % 5 == 0 or ep == a.epochs:
            msg = f'epoch {ep} loss {tot:.2f}'
            if held:
                msg += f' held-out CER {evaluate(held):.3f}'
            print(msg, flush=True)

    net.eval()
    dummy = torch.ones(1, 3, H, 320)
    torch.onnx.export(net, dummy, a.out, input_names=['x'], output_names=['fetch_name_0'], opset_version=17,
                      dynamic_axes={'x': {0: 'b', 3: 'w'}, 'fetch_name_0': {0: 'b', 1: 't'}}, dynamo=False)
    s = ort.InferenceSession(a.out)
    xr = np.random.rand(1, 3, H, 480).astype('float32') * 2 - 1
    diff = np.abs(s.run(None, {'x': xr})[0] - net(torch.from_numpy(xr)).detach().numpy()).max()
    print(f'exported {a.out} (ONNX vs torch max diff {diff:.2e})')


if __name__ == '__main__':
    main()
