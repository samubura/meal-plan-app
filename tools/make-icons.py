"""App icons (notebook page on the accent colour): python3 tools/make-icons.py  (needs Pillow)."""
import pathlib
from PIL import Image, ImageDraw

APP = pathlib.Path(__file__).resolve().parent.parent / 'app'
ACCENT, PAGE, BAND, INK, RULE = '#2e7d4f', '#fcfefb', '#dcefe1', '#1c2a21', '#9fd3b0'


def icon(size, name, pad=0):
    S = 1024
    im = Image.new('RGB', (S, S), ACCENT)
    d = ImageDraw.Draw(im)
    m = 200 + pad
    d.rounded_rectangle((m, m + 40, S - m, S - m + 40), radius=60, fill=PAGE)
    d.rounded_rectangle((m, m + 40, S - m, m + 170), radius=60, fill=BAND)
    d.rectangle((m, m + 120, S - m, m + 170), fill=BAND)
    for x in (m + 130, S - m - 130):
        d.rounded_rectangle((x - 22, m - 20, x + 22, m + 110), radius=22, fill=INK)
    y = m + 250
    for wlen in (0.75, 0.55, 0.7):
        d.line((m + 70, y + 60, S - m - 70, y + 60), fill=RULE, width=10)
        d.rounded_rectangle((m + 80, y, m + 80 + int((S - 2 * m - 160) * wlen), y + 34), radius=17, fill=INK)
        y += 150
    im.resize((size, size), Image.LANCZOS).save(APP / name)


icon(192, 'icon-192.png')
icon(512, 'icon-512.png')
icon(180, 'apple-touch-icon.png')
icon(512, 'icon-maskable-512.png', pad=60)  # extra margin for the maskable safe zone
