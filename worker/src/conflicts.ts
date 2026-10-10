import type { PairResult, TsError } from "./checker";

export type PairStatus = "clean" | "textual_conflict" | "semantic_conflict" | "inherited_failure";

export interface PairVerdict {
  status: PairStatus;
  /** Errors present in the merge but in neither fork alone. */
  newErrors: TsError[];
  /** Best guess at the symbol involved, from the forks' breaking export changes. */
  symbol: string | null;
  /** Fork whose export change the error is about (the "changer"), and the other one (the "user"). */
  changer: string | null;
  user: string | null;
  conflicts: string[];
}

const key = (e: TsError) => `${e.file}|${e.code}|${e.message}`;

/**
 * "A failure that neither fork has alone becomes a semantic conflict" (prompt.md, milestone 4).
 * `breaking` maps fork → names of exports it removed or changed the signature of.
 */
export function analyzePair(r: PairResult, breaking: Record<string, string[]>): PairVerdict {
  const base = { newErrors: [], symbol: null, changer: null, user: null, conflicts: [] as string[] };
  if (!r.merge.clean) return { ...base, status: "textual_conflict", conflicts: r.merge.conflicts };
  const merged = r.merge.typecheck;
  if (!merged || merged.ok) return { ...base, status: "clean" };
  const alone = new Set([...r.aloneA.errors, ...r.aloneB.errors].map(key));
  const newErrors = merged.errors.filter((e) => !alone.has(key(e)));
  if (!newErrors.length) return { ...base, status: "inherited_failure" };

  for (const err of newErrors) {
    for (const [changer, user] of [
      [r.a, r.b],
      [r.b, r.a],
    ] as const) {
      const hit = (breaking[changer] ?? []).find((name) => new RegExp(`\\b${name.replace(/[$]/g, "\\$")}\\b`).test(`${err.lineText} ${err.message}`));
      if (hit) return { ...base, status: "semantic_conflict", newErrors, symbol: hit, changer, user };
    }
  }
  return { ...base, status: "semantic_conflict", newErrors };
}

export const describeError = (e: TsError) => `${e.file}:${e.line} ${e.code} ${e.message.replace(/\.$/, "")}`;
