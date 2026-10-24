"""Voices the narration -> work/voice/<hash>.wav and work/timeline.json (scene, line and sentence times).

One voice: Kokoro-82M (Apache-2.0), af_heart, through the shared media kit (nw_media.speak).

Timeline: each scene starts with `lead` seconds of picture, then its lines, each after `gap` seconds of quiet (or at
`at`, if later), and ends `tail` seconds after the last line. A line is voiced one sentence at a time.

    film/.venv/bin/python film/narrate.py
"""
import hashlib, json, sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
KIT = Path("/Users/hudsonyu/Documents/Codex/2026-09-28/referenced-chatgpt-conversation-this-is-an-4/outputs/submission-assets")
sys.path.insert(0, str(KIT))
import nw_media as M  # noqa: E402

M.ESPEAK_DATA = Path("/tmp/claude-501/allowance-espeak-data")   # espeak-ng truncates long data paths


def main():
    script = json.loads((HERE / "script.json").read_text())
    (HERE / "work/voice").mkdir(parents=True, exist_ok=True)
    t = 0.0
    scenes = []
    for scene in script["scenes"]:
        start = t
        t += scene["lead"]
        lines = []
        for line in scene["lines"]:
            t = max(t + line.get("gap", 0.0), start + line.get("at", 0.0))
            spoken = line.get("spoken", line["text"])
            parts, cur, first = [], t, True
            for s in M.sentences(spoken):
                key = hashlib.sha1(f"{s}|{script['voice']}|{script['rate']}".encode()).hexdigest()[:12]
                wav = HERE / f"work/voice/{key}.wav"
                x = M.speak(s, wav, script["voice"], script["rate"])
                if not first:
                    cur += 0.16
                first = False
                parts.append({"spoken": s, "wav": wav.name, "start": round(cur, 3), "end": round(cur + len(x) / M.SR, 3)})
                cur += len(x) / M.SR
            lines.append({"id": line["id"], "text": line["text"], "spoken": spoken, "start": round(t, 3), "end": round(cur, 3), "parts": parts})
            t = cur
        t += scene["tail"]
        scenes.append({"id": scene["id"], "kind": scene["kind"], "page": scene.get("page"), "start": round(start, 3), "end": round(t, 3), "lines": lines})
    (HERE / "work/timeline.json").write_text(json.dumps({"total": round(t, 3), "scenes": scenes}, indent=1))
    for s in scenes:
        print(f"{s['id']:8s} {s['start']:7.2f}-{s['end']:7.2f}  ({s['end'] - s['start']:5.1f} s)")
    print(f"total {t:.1f} s ({int(t // 60)}:{t % 60:04.1f})")


if __name__ == "__main__":
    main()
