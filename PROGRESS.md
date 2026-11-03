# PROGRESS

## Current state
- Live site: https://floorwalker.43-160-214-187.sslip.io (branch `main`, redesigned UI since 2026-11-03, PayPal sandbox only). The old version is tagged `pre-redesign`; a copy of the live data from just before the switch is in `/opt/floorwalker/backup-20261103-0442` on the server. The preview address is gone.
- The Gemini key has no prepaid credit (HTTP 402). With `FLOORWALKER_AI_FALLBACK=deepseek`, DeepSeek stands in automatically and the app shows it; a top-up switches back on its own. One bench run on it: `bench/deepseek-fallback-RESULTS.md`. Published benchmark numbers remain the Gemini ones.
- Tests: 125 unit tests, 230 browser flow steps (full run on DeepSeek before the merge; the page-top step was added and run after it). Live e2e after the switch: 39 PASS / 2 FAIL; both FAILs are the demo-refused billing paths (`tests/e2e-live-RESULTS.md`). On DeepSeek, `/v1/payouts` sometimes blocks the test's thin request instead of holding it.
- Before/after comparison: `notes/compare/compare.html`. Live screens: `notes/gallery-live`.

- **Launch work on branch `launch` (not deployed yet), 2026-11-03/04:** code sign-in and sign-up in one screen (owner's sign-in standard, email only until SMS exists), optional password, forgot password, change email, sign-in events page; signed-in devices, delete account, workspace export; approval/blocked/reminder emails with single-use approve and decline links, weekly summary; customer email in through a per-workspace forwarding address (Postmark inbound), pasted messages, `POST /v1/messages`, replies out by email; per-workspace currency (other currencies always wait for the owner); three-step start; `/healthz`. Checks: 169 unit tests, 248 browser flow steps, the brand-new-shop end-to-end test (`tests/e2e-merchant.mjs`, 8/8, real sandbox refunds).
- Daily database backups run on the server since 2026-11-03 (`floorwalker-backup.timer`, 03:30 UTC, 14 days, `/opt/floorwalker/backups`). Not off-site yet.
- **Blocked on the owner:** the Postmark Server API Token in `.env` (without it production refuses to send codes, so the launch branch can't go live), Postmark account approval, and a Tencent Cloud sign-in in Chrome to add `floorwalker.yingzhilu.cn`. DKIM/Return-Path/DMARC records need the owner's OK before they are added.

## Next
1. Film v1 is done (2026-11-03): `film/out/Floorwalker_20261103_1355_v1_横屏.mp4` (177.5 s, 1920x1080) and `_竖屏.mp4` (59.7 s, 1080x1920), copies, storyboard and music list on the Desktop and in `notes/film/`. Music: Bach, Air on the G String, Golden Cut Reborn, YouTube Audio Library licence (no attribution; the file stays out of git and deploys). Waiting for the owner's review.
2. Owner uploads the film to YouTube as Public and fills the personal and attestation fields on Devpost.
3. After the link arrives: update the README and the Devpost video field, upload the new gallery, make the repo public, submit before Nov 5 if possible.

## Known issues
- Not verified with real devices: passkeys, web push. Not verified without a real webhook: Slack success path.
- `VITE_AG_GRID_LICENSE_KEY` is not set, so an AG Grid watermark may show.
- On Gemini, AI-reviewed holds take about 25 s (default thinking). Left as is: changing it could change review verdicts behind the published benchmark.
- Repeating sandbox refunds quickly on one capture can return 409, which makes the second-bypass step flaky.
- Inbound email looks up the workspace by opening every workspace; fine now, slow with many workspaces (keep a token index in core.db).
- The Watch page still shows bypass refunds in USD.
