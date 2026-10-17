import { matchesGlob } from "./repoconfig";
import { REVIEWERS, type Approval, type CheckName, type Classification, type Finding, type PrState, type RawFinding, type Reviewer, type Tier, type Verdict } from "./types";

/**
 * The merge policy, as pure functions (spec: "Verdict and merge policy"). Models classify and find; this code
 * decides. Everything here only raises requirements, never lowers what a person or a hard rule set.
 */

/** Files whose change always needs a person: the pipeline's own configuration and the reviewers' guidance. */
export const ALWAYS_HUMAN = [".atc/ci.yml", ".atc/review.yml", ".atc/owners", "REVIEW.md"];

export function applyHardRules(c: Classification, changedPaths: string[], owners: string[]): Classification {
  const reasons = [...c.humanReasons];
  for (const p of changedPaths) {
    if (ALWAYS_HUMAN.includes(p)) reasons.push(`changes ${p}`);
    const owned = owners.find((g) => matchesGlob(p, g));
    if (owned) reasons.push(`changes ${p} (listed in .atc/owners as ${owned})`);
  }
  const added = reasons.length > c.humanReasons.length;
  return { ...c, needsHuman: c.needsHuman || added, humanReasons: [...new Set(reasons)] };
}

const TIER_RANK: Record<Tier, number> = { low: 0, medium: 1, high: 2 };

/**
 * A follow-up run's classification never drops below the PR's previous one: a small push after a risky change must
 * not make the risky change need fewer people (review of PR #50).
 */
export function atLeast(prev: Classification | null, next: Classification): Classification {
  if (!prev) return next;
  return {
    ...next,
    tier: TIER_RANK[prev.tier] > TIER_RANK[next.tier] ? prev.tier : next.tier,
    needsHuman: prev.needsHuman || next.needsHuman,
    humanReasons: [...new Set([...prev.humanReasons, ...next.humanReasons])],
  };
}

/**
 * The reviewers that actually run: the classifier's pick, plus correctness on any change (a model must not be able
 * to talk the pipeline out of reviewing code at all), plus every reviewer that still has open findings (only a
 * reviewer that runs again can see that its finding was fixed).
 */
export function effectiveReviewers(picked: Reviewer[], openFindingsBy: Reviewer[], hasChanges: boolean): Reviewer[] {
  const set = new Set<Reviewer>([...picked, ...openFindingsBy, ...(hasChanges ? (["correctness"] as const) : [])]);
  return REVIEWERS.filter((r) => set.has(r));
}

const BY_TIER: Record<Tier, number> = { low: 0, medium: 1, high: 2 };

export function requiredApprovals(tier: Tier, needsHuman: boolean): number {
  return Math.max(BY_TIER[tier], needsHuman ? 1 : 0);
}

/**
 * Approvals that count: for the current head only, one per person. The author counts as one approver (they direct
 * the agent), but a high-tier PR needs at least one approver who isn't the author.
 */
export function countApprovals(approvals: Approval[], head: string, author: string, tier: Tier) {
  const people = new Set(approvals.filter((a) => a.sha === head).map((a) => a.by));
  const nonAuthor = [...people].filter((p) => p !== author).length;
  return {
    count: people.size,
    nonAuthor,
    satisfied: (required: number) => people.size >= required && (tier !== "high" || required === 0 || nonAuthor >= 1),
  };
}

/** Per finding, real if at least `quorum` of its verifier votes say so. */
export function tallyVotes(votes: boolean[][], quorum = 2): boolean[] {
  return votes.map((v) => v.filter(Boolean).length >= quorum);
}

/** After this many runs a PR stops getting new nits (the post's convergence lesson). */
export const NIT_RUNS = 3;

/** Drop findings the author already resolved (same file and class), and from run NIT_RUNS + 1 on, new nits. */
export function filterNew(found: RawFinding[], resolved: Array<{ file: string; class: string }>, runNumber: number): RawFinding[] {
  const done = new Set(resolved.map((r) => `${r.file}\u0000${r.class}`));
  return found.filter((f) => !done.has(`${f.file}\u0000${f.class}`) && (runNumber <= NIT_RUNS || f.severity !== "nit"));
}

export interface VerdictInput {
  state: PrState;
  ci: Verdict["ci"];
  /** The review run for the current head finished (all reviewers and verifiers done, errored or not). */
  reviewDone: boolean;
  /** Steps that errored (failed, ran out of budget, returned invalid output). */
  errored: string[];
  /** Open findings for this PR (verified ones only; nits included). */
  open: Finding[];
  securityRan: boolean;
  classification: Classification | null;
  approvals: Approval[];
  head: string;
  author: string;
  /** The current run: the commit it checked, whether it's over, and what it ran (null: everything). None yet: null. */
  run?: { sha: string; finished: boolean; only: CheckName[] | null } | null;
}

const blocking = (f: Finding) => f.status === "open" && f.severity === "important";

export function computeVerdict(i: VerdictInput): Verdict {
  const ciFailed = i.ci === "fail";
  const done = i.reviewDone && !ciFailed;
  const importantOpen = i.open.filter(blocking);
  const securityOpen = importantOpen.filter((f) => f.reviewer === "security");
  const review: Verdict["review"] = ciFailed ? "skipped" : !done ? "pending" : i.errored.length ? "incomplete" : importantOpen.length ? "findings" : "clean";
  const security: Verdict["security"] = ciFailed ? "skipped" : !done ? "pending" : securityOpen.length ? "blocking" : i.securityRan ? "clear" : "skipped";

  const humanReasons = [...(i.classification?.humanReasons ?? [])];
  if (i.ci === "none") humanReasons.push("no CI configured");
  if (review === "incomplete") humanReasons.push(`review incomplete: ${i.errored.map((e) => `${e} errored`).join(", ")}`);
  const needsHuman = !!i.classification?.needsHuman || i.ci === "none" || review === "incomplete";
  const tier = i.classification?.tier ?? null;
  const required = tier ? requiredApprovals(tier, needsHuman) : needsHuman ? 1 : 0;
  const counted = countApprovals(i.approvals, i.head, i.author, tier ?? "low");

  const run = i.run === undefined ? { sha: i.head, finished: i.reviewDone || ciFailed, only: null } : i.run;
  const checks: Verdict["checks"] = !run ? "not_run" : !run.finished ? "running" : run.sha !== i.head ? "stale" : run.only ? "partial" : "done";
  const short = (sha: string) => sha.slice(0, 7);

  const blockers: string[] = [];
  if (i.state === "draft") blockers.push("PR is a draft");
  else if (i.state !== "ready") blockers.push(`PR is ${i.state}`);
  if (i.state === "ready" && checks === "not_run") blockers.push("checks haven't run on this commit");
  if (checks === "stale") blockers.push(`checks ran on ${short(run!.sha)}, the head is ${short(i.head)}: run the checks again`);
  if (checks === "partial") blockers.push(`only some checks ran (${run!.only!.join(", ")}): run all the checks before merging`);
  if (ciFailed) blockers.push("CI failed");
  if (i.state === "ready" && checks !== "not_run" && (i.ci === "pending" || review === "pending")) blockers.push("review in progress");
  if (importantOpen.length) blockers.push(`${importantOpen.length} open important finding${importantOpen.length > 1 ? "s" : ""}`);
  if (securityOpen.length) blockers.push("open security finding");
  if (done && counted.count < required) blockers.push(`needs ${required} approval${required > 1 ? "s" : ""}, has ${counted.count}`);
  if (done && tier === "high" && required > 0 && counted.nonAuthor === 0) blockers.push("high risk: needs an approval from someone other than the author");

  return { checks, checkedSha: run?.sha ?? null, ci: i.ci, review, security, tier, requiredApprovals: required, approvals: counted.count, needsHuman, humanReasons, mergeable: blockers.length === 0, blockers };
}

export function mergeGate(v: Verdict): { ok: boolean; blockers: string[] } {
  return { ok: v.mergeable, blockers: v.blockers };
}

const STOP = new Set(["the", "and", "for", "into", "with", "from", "that", "this", "when", "are", "not", "has", "have", "its", "but", "via", "new", "still", "only"]);
const words = (f: RawFinding) =>
  new Set(`${f.class} ${f.title}`.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2 && !STOP.has(w)).map((w) => (w.length > 3 ? w.replace(/s$/, "") : w)));
/** Same bug: same file, within a few lines, and most of the shorter description's words in the other. */
const LINE_SLACK = 5;
const SIMILAR = 0.5;
function sameBug(a: RawFinding, b: RawFinding): boolean {
  if (a.file !== b.file || Math.abs(a.line - b.line) > LINE_SLACK) return false;
  const [x, y] = [words(a), words(b)];
  let both = 0;
  for (const w of x) if (y.has(w)) both++;
  return both / Math.max(1, Math.min(x.size, y.size)) >= SIMILAR;
}
/** The reviewer a finding belongs to by what it is about. */
function lane(f: RawFinding): Reviewer {
  const text = `${f.class} ${f.title}`.toLowerCase();
  if (/inject|auth|secret|ssrf|xss|csrf|traversal|deserial|crypt|sql|escap/.test(text)) return "security";
  if (/\btests?\b|coverage|untested/.test(text)) return "tests";
  return "correctness";
}
const SEVERITY_RANK: Record<RawFinding["severity"], number> = { important: 0, nit: 1, "pre-existing": 2 };

/**
 * Reviewers overlap (live run, 10-17: every reviewer reported the same off-by-one). Before verification, keep one
 * finding per bug across reviewers: the one from the reviewer whose lane it is, else the most severe, else the first
 * reviewer. Findings from one reviewer are never merged with each other, and different bugs on one line stay apart.
 */
export function dedupeAcross(byRole: Partial<Record<Reviewer, RawFinding[]>>): Partial<Record<Reviewer, RawFinding[]>> {
  const all = REVIEWERS.flatMap((r) => (byRole[r] ?? []).map((f) => ({ r, f })));
  const group = all.map((_, i) => i);
  const root = (i: number): number => (group[i] === i ? i : (group[i] = root(group[i]!)));
  for (let i = 0; i < all.length; i++)
    for (let j = i + 1; j < all.length; j++) if (all[i]!.r !== all[j]!.r && sameBug(all[i]!.f, all[j]!.f)) group[root(j)] = root(i);
  const keep = new Set<number>();
  const members = new Map<number, number[]>();
  all.forEach((_, i) => members.set(root(i), [...(members.get(root(i)) ?? []), i]));
  for (const ids of members.values()) {
    const best = [...ids].sort((a, b) => {
      const [x, y] = [all[a]!, all[b]!];
      return Number(y.r === lane(y.f)) - Number(x.r === lane(x.f)) || SEVERITY_RANK[x.f.severity] - SEVERITY_RANK[y.f.severity] || a - b;
    })[0]!;
    keep.add(best);
  }
  const out: Partial<Record<Reviewer, RawFinding[]>> = {};
  for (const r of REVIEWERS) if (byRole[r]) out[r] = [];
  all.forEach(({ r, f }, i) => keep.has(i) && out[r]!.push(f));
  return out;
}
