# Submission video

- `atc-demo.mp4`: **v8, 6:52, approved 2026-10-11. This is the file to submit.** 1920×1080, 30 fps, narrated. It follows
  the say-it / show-it / recap structure and explains the problem in plain graphics before the airport (ADR-0017, issue #13).
  Script with timings: [`VIDEO_SCRIPT_V8.md`](VIDEO_SCRIPT_V8.md). (v7, 2:57, was too short and has been replaced.)

It is rendered from `video/` (Remotion). The demo section replays the recorded run `booking-261010213346`
from `video/src/data/run.json`. To re-render: `pnpm --dir video voiceover` (only changed lines are regenerated),
then `pnpm --dir video render`, which writes `video/out/atc.mp4`.

- `atc-linkedin.mp4`: the 60-second cut (1:05, Scott voice) for LinkedIn, with burned-in captions. Rendered from the
  `ATCShort` composition: `pnpm --dir video voiceover --short --voice scott`, then `pnpm --dir video render:short:scott`
  (writes `video/out/atc-short-scott.mp4`). Its numbers come from the same run as the long video; the flight-log card
  is from the public replay run (`shop-261011185716`) and says so, because `booking-261010213346` predates flight logs.

Form answers: [`FORM_DRAFT.md`](FORM_DRAFT.md). Check their lengths with `./check-form.sh`.
