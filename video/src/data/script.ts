/** Voice-over, one clip per chunk. Beat 4's chunks are anchored to real events from the recorded run. */
export const VOICE = { id: "XrExE9yKIg1WjnnlVkGX", name: "Matilda (American English)", model: "eleven_multilingual_v2" };

export const LINES = {
  setup: "Two coding agents, one repo. Agent A adds a parameter to createBooking. Agent B, in another file, calls it the old way. Both pass CI. Git sees no conflict.",
  today: "Today, those changes first meet when B tries to land. A is already down, so B gets waved off, after its agent has finished and moved on.",
  rewind: "So I moved that test earlier.",
  real1: "Every push is merged against the other open forks, and typechecked. This is a real run.",
  real2: "B is flagged seven seconds after its push, while it's still far out. createBooking: expected three arguments, got two.",
  real3: "B pulls in A's change and fixes the call, still in flight.",
  real4: "A lands, then B. No go-around.",
  airport: "Each agent has a fork in Cloudflare Artifacts. Push events go to a Durable Object that tracks the open forks. The merge and typecheck run in a Sandbox.",
  close: "ATC. Air traffic control for coding agents.",
} as const;

export type LineId = keyof typeof LINES;
