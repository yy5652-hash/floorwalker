# PROGRESS

## Current state
- Live site: https://floorwalker.43-160-214-187.sslip.io (PayPal sandbox only). Moving background and button fixes are deployed.
- Tests: 106 unit tests, 149 browser flow steps (`node tests/button-flows.mjs`, results in `tests/button-flows-RESULTS.md`), live end-to-end in `tests/e2e-live-RESULTS.md`.

## Next
1. Film: storyboard v1 waits for the owner's approval (`notes/film/`). No render until approved. Follow the video spec in the owner's global instructions: naming, music list, 60-second vertical cut, no overwriting.
2. Before rendering, re-record the run and use one measured tap figure in both the film and `devpost/STORY.md` (film says 53, story says 66 to 50).
3. Owner uploads the film to YouTube as Public and fills the personal and attestation fields on Devpost.
4. After the link arrives: update the README and the Devpost video field, make the repo public, submit before Nov 5.

## Known issues
- Not verified with real devices: passkeys, web push. Not verified without a real webhook: Slack success path.
- `VITE_AG_GRID_LICENSE_KEY` is not set, so an AG Grid watermark may show.
