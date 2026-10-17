/** Shared types of the PR and review pipeline (spec: docs/superpowers/specs/2026-10-17-pr-review-pipeline-design.md). */

export type PrState = "draft" | "ready" | "merged" | "closed";
export type Tier = "low" | "medium" | "high";
export type Severity = "important" | "nit" | "pre-existing";
export type Reviewer = "correctness" | "security" | "tests";
export const REVIEWERS: readonly Reviewer[] = ["correctness", "security", "tests"];

/** What the author says the PR does. An agent may draft it; the author owns it. */
export interface Intent {
  what: string;
  why: string;
  testing: string;
  risk: string;
  revert: string;
}

export interface Pr {
  id: number;
  title: string;
  /** The person (email) who opened it; agents act as the person directing them. */
  author: string;
  /** Branch with the work, e.g. "fix-cart". */
  source: string;
  /** Branch it merges into, usually "main". */
  target: string;
  state: PrState;
  head: string;
  /** Target's head when the PR was opened or last merged onto (for the diff). */
  base: string | null;
  intent: Intent;
  createdAt: number;
  /** The review run currently in charge of this PR, if any. */
  currentRun: number | null;
}

export interface Classification {
  tier: Tier;
  needsHuman: boolean;
  humanReasons: string[];
  reviewers: Reviewer[];
  depth: "quick" | "standard" | "deep";
}

/** A finding as a reviewer reports it. */
export interface RawFinding {
  file: string;
  line: number;
  severity: Severity;
  class: string;
  title: string;
  evidence: string;
  suggestion?: string;
}

export interface Finding extends RawFinding {
  id: number;
  pr: number;
  reviewer: Reviewer;
  sha: string;
  run: number;
  status: "open" | "fixed" | "resolved";
  resolution?: { kind: ResolutionKind; reason: string; by: string };
}

export type ResolutionKind = "wrong" | "intentional" | "wontfix";

export interface Approval {
  pr: number;
  sha: string;
  by: string;
  at: number;
}

export type StepStatus = "pending" | "running" | "passed" | "failed" | "errored" | "skipped";

/** One CI command's result, or one pipeline step (classifier, a reviewer, verification). */
export interface CheckRow {
  run: number;
  name: string;
  kind: "ci" | "step";
  status: StepStatus;
  log: string;
  ms: number;
}

export interface Verdict {
  ci: "pass" | "fail" | "none" | "pending";
  review: "clean" | "findings" | "incomplete" | "pending" | "skipped";
  security: "clear" | "blocking" | "pending" | "skipped";
  tier: Tier | null;
  requiredApprovals: number;
  approvals: number;
  needsHuman: boolean;
  humanReasons: string[];
  mergeable: boolean;
  blockers: string[];
}
