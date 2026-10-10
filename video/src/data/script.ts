/** Voice-over, one clip per chunk. Beat 4's chunks are anchored to real events from the recorded run. */
export const VOICE = { id: "XrExE9yKIg1WjnnlVkGX", name: "Matilda (American English)", model: "eleven_multilingual_v2" };

export const LINES = {
  intro: "Think of every pull request as a plane trying to land on main. On GitHub there's no air traffic controller. Each pull request tries to land as soon as it's ready, and nothing coordinates them.",
  intro2: "So we built that controller for AI coding agents, on Cloudflare. It's called ATC.",
  setup: "Here is what goes wrong without one. Agent A changes the parameters of a function. Agent B, working in a different file, calls that function the old way. Each pull request passes CI on its own, and Git finds no merge conflict.",
  today: "Today, the two changes are first tested together when B tries to merge. A has already merged, so the build breaks and B is sent around. It has to rebase onto the new main, fix the call, and wait for CI again before it can land. By then B's agent has usually finished, so a person ends up doing that work.",
  rewind: "We moved that check earlier.",
  real1: "Here's a recorded run with five agents. Every time an agent pushes, ATC analyzes its pull request against each of the other open ones. It merges them ahead of time and checks that the combined code still builds.",
  real2: "Two of them break the build when they're combined. One changed a function's parameters, and the other still calls it the old way. Each one builds fine on its own.",
  order: "A merge train would land them in the order they arrived. ATC analyzes what each change touches and picks the order itself. Smaller changes go first, and of the two that broke together, the bigger one waits behind the smaller one.",
  hold: "The agent that has to wait finds out while it's still working, so it pulls in the other change and fixes the call before its turn.",
  land: "All five land in that order, and none of them has to rebase.",
  airport: "Here's how it's built on Cloudflare. Each agent gets its own Git fork in Cloudflare Artifacts, so agents work in parallel without touching each other's code, and every push becomes an event ATC can react to.",
  durable: "Those events go to a Durable Object, one per repo. It keeps every open pull request and the landing order in one place, so every agent gets the same answer.",
  sandbox: "The test merges and builds run in Sandbox containers, so agents' code is built in isolation, never inside ATC itself.",
  close: "ATC. Air traffic control for AI coding agents, built on Cloudflare.",
} as const;

export type LineId = keyof typeof LINES;
