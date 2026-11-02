# PROGRESS

## Current state
- Live site: https://floorwalker.43-160-214-187.sslip.io (branch `main`, old UI, PayPal sandbox only).
- Redesign preview: https://floorwalker-next.43-160-214-187.sslip.io (branch `redesign`, own data dir, unit `floorwalker-next`, port 18811, deploy with `notes/deploy-next.sh`). The owner decides when to switch.
- **Blocker since 2026-11-02 18:27 UTC: the Gemini key has no prepaid credit (HTTP 402). Live and preview share it, so on both the agents and rule compiling fail and every request falls back to "AI review unavailable" (fail closed). The owner has to top up in AI Studio.**
- Tests on `redesign`: 118 unit tests, 228 browser flow steps (full run before the depletion). The live e2e on the preview gave 31 PASS / 10 FAIL: 8 from the depleted credit, 2 are the demo-refused billing paths (`notes/e2e-next-RESULTS.md`); rerun after the top-up.
- Before/after comparison: `notes/compare/compare.html`. Screens from before the last small ledger text fix: reshoot after the top-up.

## Next
0. After the top-up: rerun `node tests/e2e-live.mjs <preview>` (then restore `tests/e2e-live-*` if it isn't the live target), reshoot with `SHOTS_BASE=<preview> node notes/live-shots.mjs notes/gallery-next`.
1. Owner accepts the redesign and decides the switch: merge `redesign` to main, deploy live, retire the preview unit and nginx site. Add the new features to `devpost/STORY.md` at that point.
2. Film: re-record on the new UI (Ask button moved to the top bar, add the Tessa "Approve and stop asking" beat). Storyboard waits for the owner's nod (`notes/film/`). Use one measured tap figure in film and STORY (the fresh demo now shows 55 taps per 100 before learning; film said 53, story says 66 to 50). Follow the video spec: naming, music list, 60-second vertical cut, no overwriting.
3. Owner uploads the film to YouTube as Public and fills the personal and attestation fields on Devpost.
4. After the link arrives: update the README and the Devpost video field, reshoot the gallery, make the repo public, submit before Nov 5 if possible.

## Known issues
- Not verified with real devices: passkeys, web push. Not verified without a real webhook: Slack success path.
- `VITE_AG_GRID_LICENSE_KEY` is not set, so an AG Grid watermark may show.
- AI-reviewed holds take about 25 s (Gemini default thinking). Left as is: changing it could change review verdicts behind the published benchmark.
- Repeating sandbox refunds quickly on one capture can return 409, which makes the second-bypass step flaky.
