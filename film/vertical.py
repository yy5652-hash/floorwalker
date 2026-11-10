"""The 60-second vertical cut (1080x1920): pieces of the full film, framed for a phone, with its own large captions.

Picture comes from caption-free frames (node film/director.mjs --nocap --only=<scenes below>), sound from the full
film's processed narration (work/voice-processed.wav, written by assemble.py), so both line up with the timeline.

    film/.venv/bin/python film/vertical.py --music film/music/<track> --out out/<name>.mp4
"""
import argparse, json, subprocess, sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFont

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import assemble as A  # noqa: E402

M, SR, FPS = A.M, A.SR, A.FPS
W, H = 1080, 1920
BOX_Y, BOX = 300, 1080            # the picture sits in a 1080x1080 window
NOCAP_SCENES = ["hook", "maya", "phone", "jordan", "ledger", "bench", "end"]

# (scene, first line, last line, how to frame it). "fit" shows the whole 16:9 frame; a number is the left edge of a
# 1080-wide crop of the 1920-wide frame, where that scene's action is.
CUT = [
    ("hook", "h3", "h3", "fit"),
    ("hook", "h1", "h1", "fit"),
    ("maya", "m1", "m1", 840),
    ("maya", "m3", "m3", "fit"),
    ("phone", "p2", "p2", 735),
    ("jordan", "j1", "j1", 420),
    ("jordan", "j2", "j2", "fit"),
    ("ledger", "lg2", "lg2", "fit"),
    ("bench", "b1", "b1", "fit"),
    ("bench", "b3", "b3", "fit"),
    ("end", "e1", "e1", "fit"),
]
PAD_IN, PAD_OUT = 0.2, 0.32

FONT = "/System/Library/Fonts/SFNS.ttf"


def font(size, weight=600):
    f = ImageFont.truetype(FONT, size)
    try:
        f.set_variation_by_axes([weight])
    except Exception:
        pass
    return f


def wrap(draw, text, f, width):
    lines, cur = [], ""
    for word in text.split():
        nxt = f"{cur} {word}".strip()
        if draw.textlength(nxt, font=f) <= width:
            cur = nxt
        else:
            lines.append(cur)
            cur = word
    return lines + [cur] if cur else lines


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--music", required=True)
    ap.add_argument("--out", required=True)
    a = ap.parse_args()
    timeline = json.loads((HERE / "work/timeline.json").read_text())
    scenes = {s["id"]: s for s in timeline["scenes"]}
    # Where each scene starts in the caption-free frames (they were rendered in timeline order, these scenes only).
    first, n = {}, 0
    for s in timeline["scenes"]:
        if s["id"] in NOCAP_SCENES:
            first[s["id"]] = n
            n += round((s["end"] - s["start"]) * FPS)
    frames_dir = HERE / "work/frames-nocap"
    if len(list(frames_dir.glob("*.jpg"))) != n:
        raise SystemExit(f"work/frames-nocap has the wrong number of frames for {NOCAP_SCENES}")
    raw = subprocess.run([M.FFMPEG, "-loglevel", "error", "-i", str(HERE / "work/voice-processed.wav"), "-f", "f32le", "-ac", "1", "-ar", str(SR), "-"], check=True, capture_output=True).stdout
    voice_full = np.frombuffer(raw, dtype=np.float32).astype(np.float64)

    pieces = []                    # (scene, t0, t1 on the film clock, frame, [(line text, start, end on the film clock)])
    for scene, l0, l1, frame in CUT:
        sc = scenes[scene]
        ids = [l["id"] for l in sc["lines"]]
        lines = sc["lines"][ids.index(l0): ids.index(l1) + 1]
        t0 = max(sc["start"], lines[0]["start"] - PAD_IN)
        t1 = min(sc["end"], lines[-1]["end"] + PAD_OUT)
        pieces.append((scene, t0, t1, frame, [(l["text"], l["start"], l["end"]) for l in lines]))
    total = sum(t1 - t0 for _, t0, t1, _, _ in pieces)
    print(f"vertical cut: {total:.1f} s in {len(pieces)} pieces")

    work = HERE / "work/vertical"
    work.mkdir(parents=True, exist_ok=True)
    for old in work.glob("*.jpg"):
        old.unlink()
    title_f, cap_f, small_f = font(40, 500), font(60, 650), font(30, 500)
    small_cap_f = font(50, 650)
    voice = []
    k = 0
    for scene, t0, t1, frame, lines in pieces:
        voice.append(voice_full[int(t0 * SR): int(t1 * SR)])
        for i in range(round((t1 - t0) * FPS)):
            t = t0 + i / FPS
            src = frames_dir / f"{first[scene] + round((t - scenes[scene]['start']) * FPS):05d}.jpg"
            im = Image.open(src).convert("RGB")
            page = Image.new("RGB", (W, H), (255, 255, 255))
            if frame == "fit":
                pic = im.resize((W, round(W * im.height / im.width)), Image.LANCZOS)
                page.paste(pic, (0, BOX_Y + (BOX - pic.height) // 2))
            else:
                pic = im.crop((frame, 0, frame + 1080, 1080))
                page.paste(pic, (0, BOX_Y))
            d = ImageDraw.Draw(page)
            d.text((W // 2, 170), "F L O O R W A L K E R", font=title_f, fill=(11, 18, 32), anchor="mm")
            for j, c in enumerate([(0, 184, 217), (109, 61, 245), (240, 38, 143), (245, 147, 0)]):
                d.line([(300 + j * 120, 220), (300 + (j + 1) * 120, 220)], fill=c, width=3)
            line = next((x for x in lines if x[1] - 0.12 <= t <= x[2] + 0.4), None)
            if line:
                f, step = cap_f, 76
                rows = wrap(d, line[0], f, 960)
                if len(rows) > 4:  # long lines step down so the caption stays clear of the footer
                    f, step = small_cap_f, 62
                    rows = wrap(d, line[0], f, 980)
                for r, row in enumerate(rows):
                    d.text((W // 2, BOX_Y + BOX + 100 + r * step), row, font=f, fill=(11, 18, 32), anchor="mm")
            d.text((W // 2, H - 120), "Recorded live run · PayPal sandbox", font=small_f, fill=(100, 112, 130), anchor="mm")
            page.save(work / f"{k:05d}.jpg", quality=90)
            k += 1

    voice = np.concatenate(voice)
    n = len(voice)
    bed = A.track(a.music, n / SR, True)
    fx = np.zeros((n, 2))
    wav = work / "mix.wav"
    A.mix_down(voice, bed, fx, wav, n / SR, duck_db=-13.0, music_gain=1.0, fx_gain=0.0)
    out = HERE / a.out
    subprocess.run([M.FFMPEG, "-y", "-hide_banner", "-loglevel", "error", "-framerate", str(FPS), "-i", str(work / "%05d.jpg"), "-i", str(wav),
                    "-vf", "scale=in_range=full:out_range=tv:out_color_matrix=bt709:flags=lanczos,format=yuv420p",
                    "-color_range", "tv", "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709",
                    "-c:v", "libx264", "-preset", "slow", "-crf", "19", "-profile:v", "high", "-r", str(FPS),
                    "-c:a", "aac", "-b:a", "256k", "-movflags", "+faststart", "-shortest", str(out)], check=True)
    print(out, f"{M.probe_duration(out):.2f} s", f"{out.stat().st_size / 2**20:.1f} MiB")


if __name__ == "__main__":
    main()
