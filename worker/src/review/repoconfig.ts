import { parse } from "yaml";
import { z } from "zod";

/**
 * Per-repo configuration, read from the PR's head:
 *   .atc/ci.yml      the CI commands that gate the agents
 *   .atc/review.yml  session budgets (US cents) and review depth
 *   .atc/owners      globs of paths that always need a human
 */

export class ConfigError extends Error {
  override name = "ConfigError";
}

export interface CiCommand {
  name: string;
  run: string;
  timeoutSeconds: number;
}

export const DEFAULT_TIMEOUT_S = 300;
export const MAX_TIMEOUT_S = 900;

const ci = z.object({
  commands: z.array(z.object({ name: z.string().min(1), run: z.string().min(1), timeout: z.number().positive().optional() })).min(1, "lists no commands (remove the file for no CI)"),
});

function yaml(text: string, file: string): unknown {
  try {
    return parse(text);
  } catch (err) {
    throw new ConfigError(`${file}: ${(err as Error).message.split("\n")[0]}`);
  }
}

function check<T>(schema: z.ZodType<T>, value: unknown, file: string): T {
  const r = schema.safeParse(value);
  if (!r.success) throw new ConfigError(`${file}: ${r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  return r.data;
}

/** null: the repo has no .atc/ci.yml, so no CI is configured (shown as such, never as green). */
export function parseCiConfig(text: string | null): CiCommand[] | null {
  if (text === null) return null;
  return check(ci, yaml(text, ".atc/ci.yml"), ".atc/ci.yml").commands.map((c) => ({
    name: c.name,
    run: c.run,
    timeoutSeconds: Math.min(MAX_TIMEOUT_S, c.timeout ?? DEFAULT_TIMEOUT_S),
  }));
}

export interface ReviewConfig {
  budgets: { classifier: number; reviewer: number; verifier: number };
  depth?: "quick" | "standard" | "deep";
}

export const DEFAULT_BUDGETS = { classifier: 200, reviewer: 500, verifier: 50 } as const;
/** A repo can raise budgets up to these (US cents per session), never past them (review of PR #50). */
export const MAX_BUDGETS = { classifier: 500, reviewer: 2000, verifier: 200 } as const;

const review = z.object({
  budgets: z.object({ classifier: z.number().positive(), reviewer: z.number().positive(), verifier: z.number().positive() }).partial().optional(),
  depth: z.enum(["quick", "standard", "deep"]).optional(),
});

export function parseReviewConfig(text: string | null): ReviewConfig {
  const r = text === null ? {} : check(review, yaml(text, ".atc/review.yml") ?? {}, ".atc/review.yml");
  const b = { ...DEFAULT_BUDGETS, ...(r.budgets ?? {}) };
  const budgets = { classifier: Math.min(b.classifier, MAX_BUDGETS.classifier), reviewer: Math.min(b.reviewer, MAX_BUDGETS.reviewer), verifier: Math.min(b.verifier, MAX_BUDGETS.verifier) };
  return { budgets, ...(r.depth ? { depth: r.depth } : {}) };
}

export function parseOwners(text: string | null): string[] {
  return (text ?? "")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
}

/** Glob match on repo paths: `**` crosses directories (and may match none), `*` and `?` stay within one. */
export function matchesGlob(path: string, glob: string): boolean {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === "*" && glob[i + 1] === "*") {
      i++;
      if (glob[i + 1] === "/") {
        i++;
        re += "(?:.*/)?";
      } else re += ".*";
    } else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`).test(path);
}
