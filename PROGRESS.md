# PROGRESS

## Current state
- Live site: https://floorwalker.43-160-214-187.sslip.io (branch `main`, old UI, PayPal sandbox only).
- Redesign preview: https://floorwalker-next.43-160-214-187.sslip.io (branch `redesign`, own data dir, unit `floorwalker-next`, port 18811, deploy with `notes/deploy-next.sh`). The owner decides when to switch.
- The Gemini key ran out of prepaid credit on 2026-11-02 (HTTP 402). The owner chose DeepSeek instead of topping up: with `FLOORWALKER_AI_FALLBACK=deepseek` it stands in automatically on live and preview, and the app shows it. One bench run on it: `bench/deepseek-fallback-RESULTS.md`. Published benchmark numbers remain the Gemini ones.
- Tests on `redesign`: 125 unit tests, 229 browser flow steps (full run on DeepSeek, nothing skipped). Live e2e on DeepSeek: preview 38 PASS / 3 FAIL (39/2 on the run before), live 38 PASS / 2 FAIL. Two FAILs are the demo-refused billing paths; the third is `/v1/payouts`, where DeepSeek sometimes blocks the test's thin request instead of holding it (`notes/e2e-next-RESULTS.md`, `notes/e2e-live-fallback-RESULTS.md`).
- Before/after comparison: `notes/compare/compare.html`.

## Next
1. Owner accepts the redesign and decides the switch: merge `redesign` to main, deploy live, retire the preview unit and nginx site. Add the new features to `devpost/STORY.md` at that point.
2. Film: re-record on the new UI (Ask button moved to the top bar, add the Tessa "Approve and stop asking" beat). Storyboard waits for the owner's nod (`notes/film/`). Use one measured tap figure in film and STORY (the fresh demo now shows 55 taps per 100 before learning; film said 53, story says 66 to 50). Follow the video spec: naming, music list, 60-second vertical cut, no overwriting.
3. Owner uploads the film to YouTube as Public and fills the personal and attestation fields on Devpost.
4. After the link arrives: update the README and the Devpost video field, reshoot the gallery, make the repo public, submit before Nov 5 if possible.

## Known issues
- Not verified with real devices: passkeys, web push. Not verified without a real webhook: Slack success path.
- `VITE_AG_GRID_LICENSE_KEY` is not set, so an AG Grid watermark may show.
- On Gemini, AI-reviewed holds take about 25 s (default thinking). Left as is: changing it could change review verdicts behind the published benchmark.
- Repeating sandbox refunds quickly on one capture can return 409, which makes the second-bypass step flaky.
