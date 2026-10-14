# 16. Submission video: staged airport scenes + one recorded run

Date: 2026-10-10

## Status

Accepted

## Context

The submission video has to explain the concept, the problem and the fix in about a minute, in the dashboard's
8-bit look. The live dashboard puts planes in fixed approach slots, so a real conflict is flagged close to the
runway, and it can't show today's go-around or a rewind.

## Decision

- `video/` is a Remotion package. `src/scene/` ports the dashboard's canvas drawing so each frame is a pure function
  of the frame number, at 480×270 scaled ×4 to 1920×1080. Text is HTML overlaid on top, in Press Start 2P and VT323.
- Beats 1–3 (the go-around and the rewind) are illustration. Beat 4 is driven by a real recorded run with five PRs, which shows the pair checks and how ATC picks the landing order (its rules in `worker/src/landing.ts`), as opposed to a merge train's arrival order. Its event order,
  PR numbers, typecheck error, clearances and the on-screen clock come from `video/src/data/run.json`, which is
  written by `demo/src/video-run.ts`. That script uses a second sample repo (`demo/sample-booking`, `createBooking`),
  and PR1 (told to hold behind PR2) merges PR2's fork and fixes the call while still in flight.
- Beat 4 maps real time onto video time piecewise, so each event lands on the line that describes it. The clock
  always shows real seconds. Plane distance is staged from the same clock, so B is visibly far out when it's flagged.
- Voice-over: ElevenLabs TTS (Matilda, an American English voice, `eleven_multilingual_v2`), one MP3 per line
  (`pnpm --dir video voiceover`). Every beat's timing is derived from the clip lengths (`video/src/timeline.ts`).

## Consequences

Re-recording the run or editing a line only needs `video-run.ts` / `voiceover` and a re-render. No Worker changes.
