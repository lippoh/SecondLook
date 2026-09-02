#!/usr/bin/env python3
"""
tools/make-icons.py - generate SecondLook toolbar icons.
Usage:  python3 tools/make-icons.py
Writes: assets/icons/icon-{16,32,48,128}.png
        assets/icons/icon-alert-48.png  icon-paused-48.png
        assets/icons/icon-camera-48.png
"""
import os
from PIL import Image, ImageDraw
OUT = os.path.join(os.path.dirname(__file__), "..", "assets", "icons")
SIZES = [16, 32, 48, 128]
NAVY = (15, 42, 67)       # tile
AMBER = (217, 119, 6)     # ring / accent
SLATE = (203, 210, 217)   # paused icon ring
RED = (185, 28, 28)       # camera-active dot
def rounded(draw, box, radius, fill):
    draw.rounded_rectangle(box, radius=radius, fill=fill)
def draw_icon(size, ring, pupil=NAVY, tile=NAVY, dot=None):
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    radius = max(2, size // 5)
    rounded(d, [0, 0, size - 1, size - 1], radius, tile)
    cx, cy = size / 2, size / 2
    ring_r = size * 0.34
    lw = max(1, int(size * 0.075))
    d.ellipse([cx - ring_r, cy - ring_r, cx + ring_r, cy + ring_r],
              outline=ring, width=lw)
    pr = size * 0.14
    px = cx + size * 0.06          # pupil offset = the "second glance"
    d.ellipse([px - pr, cy - pr, px + pr, cy + pr], fill=pupil)
    if dot:
        dr = size * 0.10
        d.ellipse([size - dr * 2.2, dr * 1.1,
                   size - dr * 0.6, dr * 2.7], fill=dot)
    return img
def main():
    os.makedirs(OUT, exist_ok=True)
    for size in SIZES:
        draw_icon(size, AMBER).save(
            os.path.join(OUT, f"icon-{size}.png"))
    draw_icon(48, AMBER).save(os.path.join(OUT, "icon-alert-48.png"))
    draw_icon(48, SLATE).save(os.path.join(OUT, "icon-paused-48.png"))
    draw_icon(48, AMBER, dot=RED).save(
        os.path.join(OUT, "icon-camera-48.png"))
    print("icons written to", os.path.abspath(OUT))
if __name__ == "__main__":
    main()