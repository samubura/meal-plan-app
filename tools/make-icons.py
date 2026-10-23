"""App icons: a plate seen from above with fork and knife, a short list on the plate (food + plan).
python3 tools/make-icons.py  (needs Pillow)"""
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
    # fork (left)
    fx = c - R - 95 * k
    d.rounded_rectangle((fx - 18 * k, c - 40 * k, fx + 18 * k, c + 300 * k), radius=18 * k, fill=CUTLERY)
    d.rounded_rectangle((fx - 62 * k, c - 120 * k, fx + 62 * k, c - 10 * k), radius=40 * k, fill=CUTLERY)
    for t in (-44, 0, 44):
        d.rounded_rectangle((fx + (t - 11) * k, c - 300 * k, fx + (t + 11) * k, c - 80 * k), radius=11 * k, fill=CUTLERY)
    # knife (right)
    kx = c + R + 95 * k
    d.rounded_rectangle((kx - 18 * k, c + 20 * k, kx + 18 * k, c + 300 * k), radius=18 * k, fill=CUTLERY)
    d.pieslice((kx - 70 * k, c - 300 * k, kx + 70 * k, c + 60 * k), 180, 360, fill=CUTLERY)
    d.rectangle((kx - 70 * k, c - 120 * k, kx + 18 * k, c + 60 * k), fill=CUTLERY)
    d.rounded_rectangle((kx - 18 * k, c - 120 * k, kx + 18 * k, c + 60 * k), radius=4, fill=CUTLERY)
    return im.resize((size, size), Image.LANCZOS)


draw(192, 0.9).save(APP / 'icon-192.png')
draw(512, 0.9).save(APP / 'icon-512.png')
draw(180, 0.9).save(APP / 'apple-touch-icon.png')
draw(512, scale=0.76).save(APP / 'icon-maskable-512.png')  # inside the maskable safe zone
