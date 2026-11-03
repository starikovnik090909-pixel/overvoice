# Рисует значок OV (красный квадрат со скруглением) и сохраняет как .ico
import sys
from PIL import Image, ImageDraw, ImageFont
S = 256
im = Image.new('RGBA', (S, S), (0, 0, 0, 0)); d = ImageDraw.Draw(im)
for y in range(S):
    t = y / S; d.line([(0, y), (S, y)], fill=(int(229 - 107 * t), int(72 - 43 * t), int(77 - 35 * t), 255))
mask = Image.new('L', (S, S), 0); ImageDraw.Draw(mask).rounded_rectangle([0, 0, S - 1, S - 1], 56, fill=255); im.putalpha(mask)
try: f = ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf', 120)
except Exception: f = ImageFont.load_default()
w = d.textlength('OV', font=f); d.text(((S - w) / 2, 62), 'OV', font=f, fill='white')
im.save(sys.argv[1], sizes=[(256, 256), (64, 64), (32, 32), (16, 16)])
