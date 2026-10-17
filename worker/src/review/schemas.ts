import { z } from "zod";
import { REVIEWERS, type Classification, type RawFinding } from "./types";

/** An agent's output file didn't match its contract: the step that produced it counts as errored. */
export class InvalidOutput extends Error {
  override name = "InvalidOutput";
}

const classification = z.object({
  tier: z.enum(["low", "medium", "high"]),
  needsHuman: z.boolean(),
  humanReasons: z.array(z.string()).default([]),
  reviewers: z.array(z.enum(REVIEWERS as [string, ...string[]])),
  depth: z.enum(["quick", "standard", "deep"]).default("standard"),
});

const finding = z.object({
  file: z.string().min(1),
  line: z.number().int().nonnegative(),
  severity: z.enum(["important", "nit", "pre-existing"]),
  class: z.string().min(1),
  title: z.string().min(1),
  evidence: z.string().min(1, "every finding must cite evidence"),
  suggestion: z.string().optional(),
});

const review = z.object({ findings: z.array(finding) });
const votes = z.object({ votes: z.array(z.object({ findingIndex: z.number().int().nonnegative(), real: z.boolean(), reason: z.string() })) });

/** Models often wrap JSON in a ```json fence: take what's inside. */
function json(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  try {
    return JSON.parse((fenced?.[1] ?? text).trim());
  } catch {
    throw new InvalidOutput(`not JSON: ${text.slice(0, 80)}`);
  }
}

function check<T>(schema: z.ZodType<T>, text: string): T {
  const r = schema.safeParse(json(text));
  if (!r.success) throw new InvalidOutput(r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
  return r.data;
}

export function parseClassification(text: string): Classification {
  return check(classification, text) as Classification;
}

/** A reviewer's findings. Nits beyond `maxNits` are dropped (the post: cap nits). */
export function parseReview(text: string, maxNits = 5): RawFinding[] {
  const all = check(review, text).findings as RawFinding[];
  let nits = 0;
  return all.filter((f) => f.severity !== "nit" || ++nits <= maxNits);
}

export function parseVotes(text: string): Array<{ findingIndex: number; real: boolean; reason: string }> {
  return check(votes, text).votes;
}
