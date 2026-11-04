# PROGRESS

## Current state
- Live site: https://floorwalker.yingzhilu.cn (branch `main`, switched from sslip.io on 2026-11-04 at the owner's word 「直接切换」; PayPal sandbox only). The old address https://floorwalker.43-160-214-187.sslip.io (the one submitted) 301-redirects pages to the new one and keeps proxying `/api/` and `/v1/`, so PayPal webhooks, email links and agents set up there still work (`deploy/nginx-old-address.conf`). Pre-switch copies: data `/opt/floorwalker/backups-preswitch-20261104`, code `/opt/floorwalker/app-code-bak-20261104.tgz`, nginx `*.bak-20261104`. The preview instance `floorwalker-next` is stopped and disabled (data kept). Older: tag `pre-redesign`.
- The Gemini key has no prepaid credit (HTTP 402). With `FLOORWALKER_AI_FALLBACK=deepseek`, DeepSeek stands in automatically and the app shows it; a top-up switches back on its own. One bench run on it: `bench/deepseek-fallback-RESULTS.md`. Published benchmark numbers remain the Gemini ones.
- Tests: 125 unit tests, 230 browser flow steps (full run on DeepSeek before the merge; the page-top step was added and run after it). Live e2e after the switch: 39 PASS / 2 FAIL; both FAILs are the demo-refused billing paths (`tests/e2e-live-RESULTS.md`). On DeepSeek, `/v1/payouts` sometimes blocks the test's thin request instead of holding it.
- Before/after comparison: `notes/compare/compare.html`. Live screens: `notes/gallery-live`.

- **Launch work (merged into `main` and live since 2026-11-04):** code sign-in and sign-up in one screen, optional password, forgot password, change email, sign-in events, Resend email in and out, one currency per workspace, three-step start. Before the switch it was rehearsed locally on a copy of the live data (30 workspaces opened, e2e 38/3 with the 3 FAILs being the two demo-refused billing paths and the webhook that cannot reach localhost). Live e2e after the switch: first run 32/9 (inbox decisions differed while on the DeepSeek fallback), rerun 39 PASS / 2 FAIL, the two demo-refused billing paths.
- Daily database backups run on the server since 2026-11-03 (`floorwalker-backup.timer`, 03:30 UTC, 14 days, `/opt/floorwalker/backups`). Not off-site yet.
- **Email is Resend (owner's choice, 2026-11-04, replacing Postmark):** sending via `POST /emails`; customer email in through the signed `email.received` webhook at `/api/inbound/resend`, body read from the received-emails API; addresses are `TOKEN@FLOORWALKER_INBOUND_DOMAIN`. 170 unit tests, e2e-merchant 8/8, mailroom flow 6/6 locally.
- **Domain:** `floorwalker.yingzhilu.cn` A → 43.160.214.187 added 2026-11-04 (backup `dns-backup/yingzhilu.cn-20261104.tsv`); it is now the main address (`deploy/deploy.sh`). `deploy/preview.sh` now needs `PREVIEW_DOMAIN` set to another name.
- **Resend is live on the preview (2026-11-04):** key "Floorwalker" (full access) in `.env`; domain `floorwalker.yingzhilu.cn` verified (DKIM, SPF MX/TXT, `rsend` CNAME, receiving MX; plus `_dmarc.floorwalker` p=none), records added after the owner's OK, backup `dns-backup/yingzhilu.cn-20261104-before-resend.tsv`. Webhook `email.received` → `https://floorwalker.yingzhilu.cn/api/inbound/resend`. Checked: a sign-in code reached the owner's Gmail inbox (not spam); a test email to the receiving domain came back through the signed webhook (200) and the received-emails API.
- **Next for the owner:** update the Devpost links to https://floorwalker.yingzhilu.cn when convenient (the submitted sslip.io link keeps working). Passkeys made on sslip.io do not work on the new domain; sign in with an email code and add a new one. Top up Gemini or keep DeepSeek as the fallback: on DeepSeek the inbox decisions varied once in two live runs. Not tested yet: Outlook delivery, a real Gmail forwarding rule into a shop address.

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
