"""Dissolves between scenes, in place in work/frames (run once, after a full director.mjs): the last frame of a scene melts into the next.
    film/.venv/bin/python film/dissolve.py
"""
import json
from pathlib import Path
from PIL import Image
HERE = Path(__file__).resolve().parent
FPS, N, SIZE = 30, 14, (1920, 1080)
tl = json.loads((HERE / "work/timeline.json").read_text())
frame = lambda i: HERE / f"work/frames/{i:05d}.jpg"
pos = 0
for sc in tl["scenes"][:-1]:
    pos += round((sc["end"] - sc["start"]) * FPS)
    a = Image.open(frame(pos - 1)).convert("RGB").resize(SIZE)
    for k in range(N):
        p = (k + 1) / (N + 1); p = p * p * (3 - 2 * p)
        Image.blend(a, Image.open(frame(pos + k)).convert("RGB").resize(SIZE), p).save(frame(pos + k), quality=95)
print("dissolved", len(tl["scenes"]) - 1, "cuts")
