"""App icons: a plate seen from above with fork and knife, a short list on the plate (food + plan).
python3 tools/make-icons.py  (needs Pillow)"""
import math
import pathlib
from PIL import Image, ImageDraw

APP = pathlib.Path(__file__).resolve().parent.parent / 'app'
ACCENT, PLATE, RIM, INK, CUTLERY = '#2e7d4f', '#fcfefb', '#dcefe1', '#1c2a21', '#fcfefb'


def draw(size, scale=1.0):
    S = 1024
    im = Image.new('RGB', (S, S), ACCENT)
    d = ImageDraw.Draw(im)
    c, k = S / 2, scale
    R = 300 * k  # plate
    d.ellipse((c - R, c - R, c + R, c + R), fill=PLATE)
    r = 228 * k  # inner rim
    d.ellipse((c - r, c - r, c + r, c + r), fill=RIM)
    # the list on the plate: three short lines with dots
    for i, wl in enumerate((0.9, 0.7, 0.8)):
        y = c - 95 * k + i * 95 * k
        d.ellipse((c - 150 * k, y - 17 * k, c - 116 * k, y + 17 * k), fill=INK)
        d.rounded_rectangle((c - 90 * k, y - 15 * k, c - 90 * k + 230 * k * wl, y + 15 * k), radius=15 * k, fill=INK)
    # fork (left): three tines flush with a U-shaped base that narrows into the handle
    fx = c - R - 95 * k
    d.rounded_rectangle((fx - 18 * k, c - 60 * k, fx + 18 * k, c + 300 * k), radius=18 * k, fill=CUTLERY)
    d.chord((fx - 62 * k, c - 200 * k, fx + 62 * k, c - 20 * k), 0, 180, fill=CUTLERY)
    d.polygon([(fx - 40 * k, c - 50 * k), (fx + 40 * k, c - 50 * k), (fx + 18 * k, c), (fx - 18 * k, c)], fill=CUTLERY)
    for t in (-51, 0, 51):
        d.rounded_rectangle((fx + (t - 11) * k, c - 300 * k, fx + (t + 11) * k, c - 100 * k), radius=11 * k, fill=CUTLERY)
    # knife (right): straight spine on the right, curved edge from the tip down to the bolster
    kx = c + R + 95 * k
    d.rounded_rectangle((kx - 18 * k, c + 20 * k, kx + 18 * k, c + 300 * k), radius=18 * k, fill=CUTLERY)
    sx, cy, rx, ry = kx + 18 * k, c - 120 * k, 88 * k, 180 * k
    edge = [(sx - rx * math.sin(a * math.pi / 40), cy - ry * math.cos(a * math.pi / 40)) for a in range(21)]
    d.polygon(edge + [(kx - 70 * k, c + 40 * k), (kx - 18 * k, c + 60 * k), (sx, c + 60 * k)], fill=CUTLERY)
    return im.resize((size, size), Image.LANCZOS)


draw(192, 0.9).save(APP / 'icon-192.png')
draw(512, 0.9).save(APP / 'icon-512.png')
draw(180, 0.9).save(APP / 'apple-touch-icon.png')
draw(512, scale=0.76).save(APP / 'icon-maskable-512.png')  # inside the maskable safe zone
