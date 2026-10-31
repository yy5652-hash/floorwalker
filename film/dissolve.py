#!/usr/bin/env python3
"""Light-sweep cuts: run once, after a full director run. Each scene change crosses over behind a thin line of prismatic light."""
import json
from pathlib import Path
import numpy as np
from PIL import Image

HERE = Path(__file__).resolve().parent
FRAMES = HERE / "work/frames"
tl = json.loads((HERE / "work/timeline.json").read_text())
FPS, N, SIZE = 30, 12, (1920, 1080)
frame = lambda i: FRAMES / f"{i:05d}.jpg"
load = lambda i: np.asarray(Image.open(frame(i)).convert("RGB").resize(SIZE), dtype=np.float32)
X = np.linspace(0, 1, SIZE[0], dtype=np.float32)[:, None]
PRISM = np.concatenate([np.interp(X, [0, .33, .66, 1], c) for c in ([0, 109, 240, 245], [184, 61, 38, 147], [217, 245, 143, 0])], axis=1).astype(np.float32)
Y = np.arange(SIZE[1], dtype=np.float32)
pos = cuts = 0
for sc in tl["scenes"][:-1]:
    pos += round((sc["end"] - sc["start"]) * FPS)
    a = load(pos - 1)
    rng = np.random.default_rng(pos)
    for k in range(N):
        p = (k + 1) / (N + 1); s = p * p * (3 - 2 * p); amp = 1 - abs(2 * p - 1)
        img = a * (1 - s) + load(pos + k) * s
        # torn horizontal bands
        y = 0
        while y < SIZE[1]:
            h = int(rng.integers(8, 90))
            if rng.random() < 0.55:
                img[y:y + h] = np.roll(img[y:y + h], int(rng.normal(0, 70 * amp)), axis=1)
            y += h
        # split colour channels
        d = int(14 * amp)
        img[..., 0] = np.roll(img[..., 0], d, axis=1); img[..., 2] = np.roll(img[..., 2], -d, axis=1)
        # a thin line of prismatic light sweeps down with the cut
        line = np.exp(-((Y - p * SIZE[1]) / 7) ** 2)[:, None, None] * min(1, amp * 2)
        img = np.clip(img * (1 - line) + PRISM[None, :, :] * line, 0, 255)
        Image.fromarray(img.astype(np.uint8)).save(frame(pos + k), quality=94)
    cuts += 1
print(f"glitched {cuts} cuts")
