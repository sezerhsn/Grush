from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[1]
ASSETS = ROOT / "content" / "grush-org" / "assets"
ASSETS.mkdir(parents=True, exist_ok=True)

font = ImageFont.load_default()

# OG image 1200x630
og = Image.new("RGB", (1200, 630), (11, 11, 11))
d = ImageDraw.Draw(og)
d.text((60, 220), "GRUSH", fill=(255, 255, 255), font=font)
d.text((60, 300), "Proof of Reserves", fill=(200, 200, 200), font=font)
(ASSETS / "og-image.png").write_bytes(b"")  # ensure overwrite even if locked
og.save(ASSETS / "og-image.png", "PNG")

# Favicon (ICO)
ico = Image.new("RGB", (256, 256), (11, 11, 11))
di = ImageDraw.Draw(ico)
di.text((86, 86), "G", fill=(255, 255, 255), font=font)
ico.save(ASSETS / "favicon.ico", format="ICO", sizes=[(16,16), (32,32), (48,48), (64,64), (128,128), (256,256)])

print("OK:", ASSETS / "og-image.png", ASSETS / "favicon.ico")