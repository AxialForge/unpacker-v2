"""Draw numbered callouts on the clean screenshots.

    python docs/_tools/annotate.py [screenshots_dir]

For every <shot>.callouts.json written by capture.js this produces
<shot>_annotated.png next to <shot>_clean.png. Each control gets a thin outline,
a numbered circle placed just outside it, and a leader line from the circle to
the control. Colours are the same on every image. The number on the image is the
row number in the manual's callout table.
"""
import json
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ACCENT = (224, 49, 49)      # callout fill, outline and leader line
TEXT = (255, 255, 255)      # number
HALO = (255, 255, 255)      # ring around the circle so it reads on any ground
RADIUS = 10
GAP = 16                    # distance from the control edge to the circle centre


def font(size):
    for name in ("segoeuib.ttf", "arialbd.ttf", "DejaVuSans-Bold.ttf"):
        try:
            return ImageFont.truetype(name, size)
        except OSError:
            continue
    return ImageFont.load_default()


def overlaps(cx, cy, placed, boxes, own):
    for px, py in placed:
        if (px - cx) ** 2 + (py - cy) ** 2 < (2 * RADIUS + 2) ** 2:
            return True
    for b in boxes:
        if b is own:
            continue
        # a circle sitting on top of a small neighbouring control hides it
        if b["width"] * b["height"] < 60000 and b["x"] - RADIUS < cx < b["x"] + b["width"] + RADIUS and b["y"] - RADIUS < cy < b["y"] + b["height"] + RADIUS:
            return True
    return False


def place(box, size, placed, boxes):
    w, h = size
    x, y, bw, bh = box["x"], box["y"], box["width"], box["height"]
    mid = y + min(bh / 2, 60)
    small = bw < 30 and bh < 30
    lead = [(x - GAP, mid), (x - GAP - 2 * RADIUS - 4, mid), (x + bw / 2, y - GAP), (x + bw / 2, y + bh + GAP)] if small else [(x - GAP, mid)]
    candidates = lead + [
        (x + bw + GAP, mid), (x + RADIUS, y - GAP), (x + bw - RADIUS, y - GAP),
        (x + RADIUS, y + bh + GAP), (x + bw - RADIUS, y + bh + GAP), (x - GAP, y), (x + bw + GAP, y),
        (x + bw / 2, y - GAP), (x + bw / 2, y + bh + GAP), (x + RADIUS + 4, y + RADIUS + 4), (x + bw - RADIUS - 4, y + RADIUS + 4),
    ]
    inside = [(cx, cy) for cx, cy in candidates if RADIUS + 2 <= cx <= w - RADIUS - 2 and RADIUS + 2 <= cy <= h - RADIUS - 2]
    for cx, cy in inside:
        if not overlaps(cx, cy, placed, boxes, box):
            return cx, cy
    for cx, cy in inside:  # accept overlap with a control, never with another circle
        if not overlaps(cx, cy, placed, [], box):
            return cx, cy
    return inside[0] if inside else (max(RADIUS + 2, min(w - RADIUS - 2, x)), max(RADIUS + 2, min(h - RADIUS - 2, y)))


def nearest_on_box(cx, cy, box):
    x, y, bw, bh = box["x"], box["y"], box["width"], box["height"]
    return max(x, min(cx, x + bw)), max(y, min(cy, y + bh))


def annotate(meta_path):
    meta = json.loads(meta_path.read_text(encoding="utf-8"))
    src = meta_path.parent / meta["image"]
    img = Image.open(src).convert("RGB")
    draw = ImageDraw.Draw(img)
    f = font(12)
    boxes = [c["box"] for c in meta["callouts"]]
    placed = []
    # biggest controls first so small ones get the free spots near them last... no:
    # place in reading order, which keeps numbers near where the eye expects them
    for c in meta["callouts"]:
        b = c["box"]
        draw.rectangle([b["x"] - 2, b["y"] - 2, b["x"] + b["width"] + 1, b["y"] + b["height"] + 1], outline=ACCENT, width=1)
    for c in meta["callouts"]:
        b = c["box"]
        cx, cy = place(b, img.size, placed, boxes)
        placed.append((cx, cy))
        tx, ty = nearest_on_box(cx, cy, b)
        if (tx - cx) ** 2 + (ty - cy) ** 2 > RADIUS ** 2:
            draw.line([cx, cy, tx, ty], fill=ACCENT, width=2)
        draw.ellipse([cx - RADIUS - 1.5, cy - RADIUS - 1.5, cx + RADIUS + 1.5, cy + RADIUS + 1.5], fill=HALO)
        draw.ellipse([cx - RADIUS, cy - RADIUS, cx + RADIUS, cy + RADIUS], fill=ACCENT)
        label = str(c["number"])
        l, t, r, btm = draw.textbbox((0, 0), label, font=f)
        draw.text((cx - (r - l) / 2 - l, cy - (btm - t) / 2 - t), label, fill=TEXT, font=f)
        c["callout_centre"] = {"x": round(cx), "y": round(cy)}
    out = meta_path.parent / meta["image"].replace("_clean.png", "_annotated.png")
    img.save(out, optimize=True)
    meta["annotated_image"] = out.name
    meta_path.write_text(json.dumps(meta, indent=2), encoding="utf-8")
    return out.name, len(meta["callouts"])


def main():
    root = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).resolve().parents[1] / "release-package"
    metas = sorted(root.rglob("*.callouts.json"))
    for m in metas:
        name, n = annotate(m)
        print(f"{name}: {n} callouts")
    print(f"{len(metas)} images annotated")


if __name__ == "__main__":
    main()
