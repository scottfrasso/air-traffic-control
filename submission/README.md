# Submission video

- `atc-demo-v8.mp4`: **v8 draft, 6:52** (1920×1080, 30 fps, narrated). It follows the say-it / show-it / recap
  structure and explains the problem in plain graphics before the airport (ADR-0017, issue #13). Script with
  timings: [`VIDEO_SCRIPT_V8.md`](VIDEO_SCRIPT_V8.md). **Awaiting review.** Once approved, it replaces `atc-demo.mp4`.
- `atc-demo.mp4`: v7, 2:57. **Too short for the rules (5–10 min).** Don't submit it.

Both are rendered from `video/` (Remotion). The demo section replays the recorded run `booking-261010213346`
from `video/src/data/run.json`. To re-render: `pnpm --dir video voiceover` (only changed lines are regenerated),
then `pnpm --dir video render`, which writes `video/out/atc.mp4`.

Form answers: [`FORM_DRAFT.md`](FORM_DRAFT.md). Check their lengths with `./check-form.sh`.
