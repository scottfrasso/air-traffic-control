/** Voice-over, one clip per chunk. Beat 4's chunks are anchored to real events from the recorded run. */
export const VOICE = { id: "XrExE9yKIg1WjnnlVkGX", name: "Matilda (American English)", model: "eleven_multilingual_v2" };

export const LINES = {
  intro: "Think of every pull request as a plane trying to land on main. On GitHub there's no air traffic controller. Each pull request tries to land as soon as it's ready, and nothing coordinates them.",
  intro2: "We built that controller for AI coding agents. It's called ATC.",
  setup: "Here is what goes wrong without one. Agent A changes the parameters of a function. Agent B, working in a different file, calls that function the old way. Each pull request passes CI on its own, and Git finds no merge conflict.",
  today: "Today, the two changes are first tested together when B tries to merge. A has already merged, so the build breaks and B is sent around. It has to rebase onto the new main, fix the call, and wait for CI again before it can land. By then B's agent has usually finished, so a person ends up doing that work.",
  rewind: "We moved that check earlier.",
  real1: "ATC merges every push with the other open pull requests and runs the type checker. This is a recorded run.",
  real2: "Seven seconds after B pushes, both agents are told that the merged code doesn't type check. B is still a long way from landing.",
  real3: "B pulls in A's change and fixes its call while it's still working.",
  real4: "A lands, then B lands, with no go-around.",
  airport: "Each agent works in its own fork in Cloudflare Artifacts. Push events go to a Durable Object that tracks the open forks, and the merge and type check run in a Sandbox.",
  close: "ATC. Air traffic control for AI coding agents.",
} as const;

export type LineId = keyof typeof LINES;
