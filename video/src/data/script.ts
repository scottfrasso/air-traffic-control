/** Voice-over, one clip per chunk. Beat 4's chunks are anchored to real events from the recorded run. */
export const VOICE = { id: "XrExE9yKIg1WjnnlVkGX", name: "Matilda (American English)", model: "eleven_multilingual_v2" };

export const LINES = {
  intro: "Think of every pull request as a plane trying to land on main. On GitHub there's no air traffic controller. Each pull request tries to land as soon as it's ready, and nothing coordinates them.",
  intro2: "We built that controller for AI coding agents. It's called ATC.",
  setup: "Here is what goes wrong without one. Agent A changes the parameters of a function. Agent B, working in a different file, calls that function the old way. Each pull request passes CI on its own, and Git finds no merge conflict.",
  today: "Today, the two changes are first tested together when B tries to merge. A has already merged, so the build breaks and B is sent around. It has to rebase onto the new main, fix the call, and wait for CI again before it can land. By then B's agent has usually finished, so a person ends up doing that work.",
  rewind: "We moved that check earlier.",
  real1: "Here's a recorded run with five agents. Every push is merged with each of the other open pull requests, and the merged code is type checked. Five pull requests make ten pairs.",
  real2: "Only one pair fails. PR1 changes a function's parameters, and PR2 calls that function the old way. Each of them passes on its own.",
  order: "Then ATC decides the landing order. This isn't a merge train, where pull requests land in the order they arrive. ATC knows which functions each pull request changes and which pairs break, and it applies the same rules every time. A pull request that has asked to land goes first, then one that passes on the current main. Between equals, the smaller change goes first.",
  hold: "PR2 is the smaller change, so PR1 is told to hold and land after it. PR1's agent gets that message while it's still working, so it pulls in PR2 and updates the new call.",
  land: "The other three pull requests never conflicted, so they keep their places. All five land in order, and nobody has to rebase.",
  airport: "Each agent works in its own fork in Cloudflare Artifacts. Push events go to a Durable Object that tracks the open forks, and the merge and type check run in a Sandbox.",
  close: "ATC. Air traffic control for AI coding agents.",
} as const;

export type LineId = keyof typeof LINES;
