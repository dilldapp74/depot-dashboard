#!/usr/bin/env python3
"""Erzeugt die App-Symbole in icons/ (braucht Pillow: pip install pillow).

Motiv: steigende Kurslinie über drei Balken auf dunklem Grund.
"maskable" = Vollfläche ohne Rundung; Android schneidet selbst zu (Inhalt in der mittleren 80 %-Zone).
"""
import os
from PIL import Image, ImageDraw

BASE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "icons")
BG, BAR, LINE, DOT = (15, 23, 42), (51, 65, 85), (74, 222, 128), (255, 255, 255)
S = 4  # Überabtastung für glatte Kanten


def draw(size, maskable=False, rounded=True):
    n = size * S
    img = Image.new("RGBA", (n, n), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    if maskable or not rounded:
        d.rectangle([0, 0, n, n], fill=BG)
    else:
        d.rounded_rectangle([0, 0, n - 1, n - 1], radius=int(n * 0.22), fill=BG)
    pad = n * (0.24 if maskable else 0.18)  # Sicherheitszone für maskable
    w = n - 2 * pad

    def pt(x, y):  # x, y in 0..1, y=0 unten
        return (pad + x * w, pad + (1 - y) * w)

    # Balken
    bw = w * 0.16
    for x, h in ((0.12, 0.35), (0.42, 0.55), (0.72, 0.78)):
        x0, _ = pt(x, 0)
        d.rounded_rectangle([x0, pt(0, h)[1], x0 + bw, pt(0, 0)[1]], radius=int(bw * 0.25), fill=BAR)
    # Kurslinie
    pts = [pt(0.0, 0.30), pt(0.25, 0.48), pt(0.45, 0.40), pt(0.70, 0.72), pt(1.0, 0.95)]
    d.line(pts, fill=LINE, width=int(w * 0.075), joint="curve")
    r = w * 0.07
    for p in (pts[0], pts[-1]):
        d.ellipse([p[0] - r, p[1] - r, p[0] + r, p[1] + r], fill=LINE)
    r2 = r * 0.45
    p = pts[-1]
    d.ellipse([p[0] - r2, p[1] - r2, p[0] + r2, p[1] + r2], fill=DOT)
    return img.resize((size, size), Image.LANCZOS)


if __name__ == "__main__":
    os.makedirs(BASE, exist_ok=True)
    draw(192).save(os.path.join(BASE, "icon-192.png"))
    draw(512).save(os.path.join(BASE, "icon-512.png"))
    draw(512, maskable=True).save(os.path.join(BASE, "icon-maskable-512.png"))
    draw(180, rounded=False).convert("RGB").save(os.path.join(BASE, "apple-touch-icon.png"))
    draw(32).save(os.path.join(BASE, "favicon-32.png"))
    print("Symbole erzeugt in", os.path.normpath(BASE))
