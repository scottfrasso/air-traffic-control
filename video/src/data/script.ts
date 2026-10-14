/**
 * Voice-over, one clip per chunk, in the order they play (v8, see submission/VIDEO_SCRIPT_V8.md).
 * Part 1 says what the video will show, part 2 shows it, part 3 recaps it. The demo's chunks are anchored to
 * real events from the recorded run.
 */
export const VOICES = {
  matilda: { id: "XrExE9yKIg1WjnnlVkGX", name: "Matilda (American English)", model: "eleven_multilingual_v2" },
  // The professional clone (HsvQCt45cDuuTZeIGRvB) needs a Creator-tier plan; this is the instant clone.
  scott: { id: "UmenmBo9KC1QmixclBqv", name: "Scott (instant voice clone)", model: "eleven_multilingual_v2" },
} as const;
export type VoiceKey = keyof typeof VOICES;

export const LINES = {
  // ── part 1: what you'll see ──
  open: "Coding agents can work in parallel now. You can point five of them, or fifty, at the same repo. But the tools they push to were designed for a few people taking turns.",
  title: "This is ATC, air traffic control for coding agents, built on Cloudflare.",
  agenda: "I'll show you three things. First, how ATC sees what every agent is changing while the work is still in progress. Second, how it warns two agents that their changes will break each other, before either one tries to merge. And third, how it decides which change goes into main next, so only the agents that really collide have to redo anything.",
  roadmap: "We'll start with the problem, then the idea, then a recorded run on Cloudflare and how it's built, and a short recap at the end.",

  // ── part 2a: the problem, before any airport ──
  fan: "Here's how it works today. Each agent copies main into its own branch and works there. With one agent, that's fine. With twenty, there are twenty copies of main open at the same time, and none of them can see the others.",
  clean: "Here's the collision that hurts the most. One agent changes a function so it needs an extra argument. Another agent, in a different file, adds a new call to that function with the old arguments. Each change builds on its own. Git compares lines, and these two don't touch the same lines, so Git merges them without a conflict. The result doesn't build.",
  late: "Nobody finds out until the second change tries to merge. By then, both agents have finished. One of them has to start over from the new main, and if its agent has already exited, a person ends up fixing it.",
  storm: "There's a second cost. Many teams require a change to be rebased whenever main moves. With lots of agents, main moves all the time, so every open change gets rebased and tested again and again, even if it never touched the same code as anything else.",
  question: "So we asked two questions. Can an agent find out about a collision while it's still working? And can something decide the order changes go in, so only the ones that really collide have to redo work?",

  // ── part 2b: the idea ──
  map: "That's the job of an air traffic controller. So from here on, each agent's change is a plane. Main is the runway, and landing means merging into main. ATC is the tower.",
  clearances: "The tower gives every plane one instruction and one reason. Cleared to land. Follow the plane ahead. Hold, while a conflicting plane lands first. Go around, which means rebase on the new main and then land. Or stand by, while checks run.",
  chaos: "Without a tower, every plane lands as soon as it's ready, and nothing checks how the changes fit together.",
  setup: "Here's that same collision at the airport. Agent A changes a function's arguments. Agent B calls it the old way. Each one passes its checks alone, and Git finds no conflict.",
  today: "A lands first, and the build breaks when B tries to land. B has to go around. It rebases on the new main, fixes the call, and waits for checks again. It lands late, and usually a person did that work.",
  rewind: "ATC moves that check earlier, to every push.",

  // ── part 2c: the recorded run ──
  real1: "Here's a recorded run on Cloudflare with five agents. Each agent works in its own fork of the repo and pushes with plain Git. Every push reaches ATC, which reads what changed: which files, and which functions. Then it test-merges that change with every other open change, and runs the type checker on each combination.",
  real2: "Two of these break the build when they're combined. One changed a function's arguments, and the other still calls it the old way. Each one builds on its own, and Git sees no conflict. ATC tells both agents within seconds, and names the other change. Neither of them has asked to merge yet.",
  order: "A merge queue would land them in the order they arrived. ATC looks at what each change touches and picks the order itself. Smaller changes go first, and of the two that collide, the bigger one holds behind the smaller one.",
  hold: "The agent that holds finds out while it's still working, so it pulls in the other change and fixes the call before its turn comes.",
  land: "All five land in that order. None of them had to rebase, and main builds at the end.",
  agents: "That run used scripted agents, so it plays out the same way every time. We also ran two real Claude Code agents with tasks that collide. They connect to ATC through an MCP server, ask for their clearance, and follow it. One landed first. The other was told to go around, merged the new main, fixed the first agent's new call, and landed. Nobody stepped in.",

  // ── part 2d: how it's built ──
  airport: "Here's how it's built on Cloudflare. First, Artifacts. Each agent gets its own Git fork, so agents work in parallel without touching each other's code, and every push becomes an event ATC can react to right away.",
  durable: "Second, a Durable Object, one per repo. It receives every push event and keeps all the open changes and their check results in one place. Whenever something changes, it works out the landing order again, so every agent gets the same answer within seconds.",
  sandbox: "Third, the Sandbox, where the test merges and builds run in containers, isolated from ATC. To keep it fast, main is built once and reused, only what changed is checked again, and results are cached.",
  worker: "And fourth, one Worker in front of it all. It serves the MCP server the agents talk to, the API, and this dashboard. Each push runs as a Workflow, so a check that fails halfway is retried instead of lost.",

  // ── part 3: what you saw ──
  recap: "So, three things. ATC sees every agent's change while it's in flight, because every push to a fork reaches it within seconds. It warns about collisions early, including the ones Git can't see, by test-merging every pair and running the type checker. And it decides the landing order, so only changes that really collide redo any work. In this run, that was one change out of five, and its agent fixed it before its turn.",
  next: "Next, we want every landed commit to carry the reasons behind it: what the agent meant to do, what it was warned about, and why it waited. Then the next agent can see why main looks the way it does.",
  close: "ATC. Air traffic control for coding agents, built on Cloudflare.",
} as const;

export type LineId = keyof typeof LINES;
