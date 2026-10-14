/**
 * The ~60-second LinkedIn cut (ATCShort): its own narration over clips of the long video's beats. Same rules as
 * script.ts: plain words, no symbol names, "go around" means rebase on the new main and then land.
 * Numbers are from the run the video shows (src/data/run.json).
 */
export const SHORT_LINES = {
  hook: "Cloudflare ran a competition to build a next-gen Git platform on Workers and Artifacts, for lots of coding agents working on one repo.",
  hidden: "Agents find out they collided when they go to merge. And some collisions aren't merge conflicts at all. Say one agent changes a function's arguments, and another calls it the old way in a different file. That merges fine, but it won't build.",
  idea: "So I built ATC, air traffic control for coding agents. Each change is a plane, and main is the runway.",
  run: "This is a real run with five agents. Every push gets test-merged with every other open change and type-checked, so both agents found out within seconds, before either one asked to merge.",
  order: "ATC picked the landing order. The bigger change waited and fixed its call, then all five landed.",
  numbers: "It checked ten pairs, found the one real conflict, and nobody had to rebase. Rebasing on every merge would've been ten.",
  log: "Each landed commit also gets a flight log as a git note, with what it ran into and why it waited.",
  close: "Hey, the GitHub link is in the comments.",
} as const;

export type ShortLineId = keyof typeof SHORT_LINES;
