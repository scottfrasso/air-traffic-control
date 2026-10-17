import { matchesGlob } from "./repoconfig";
import type { Approval, Classification, Finding, PrState, RawFinding, Tier, Verdict } from "./types";

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

  const blockers: string[] = [];
  if (i.state === "draft") blockers.push("PR is a draft");
  else if (i.state !== "ready") blockers.push(`PR is ${i.state}`);
  if (ciFailed) blockers.push("CI failed");
  if (i.state === "ready" && (i.ci === "pending" || review === "pending")) blockers.push("review in progress");
  if (importantOpen.length) blockers.push(`${importantOpen.length} open important finding${importantOpen.length > 1 ? "s" : ""}`);
  if (securityOpen.length) blockers.push("open security finding");
  if (done && counted.count < required) blockers.push(`needs ${required} approval${required > 1 ? "s" : ""}, has ${counted.count}`);
  if (done && tier === "high" && required > 0 && counted.nonAuthor === 0) blockers.push("high risk: needs an approval from someone other than the author");

  return { ci: i.ci, review, security, tier, requiredApprovals: required, approvals: counted.count, needsHuman, humanReasons, mergeable: blockers.length === 0, blockers };
}

export function mergeGate(v: Verdict): { ok: boolean; blockers: string[] } {
  return { ok: v.mergeable, blockers: v.blockers };
}
