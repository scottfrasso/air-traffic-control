import type { SignalData } from "./types";

/**
 * Informational signals derived from the in-flight index. Signals are context for agents,
 * not commands: "fork B is changing the signature of X", "fork A also edits cart.ts".
 * Pure function so it can be unit-tested; the Coordinator persists and de-duplicates.
 */

export type SignalKind = "overlap" | "signature_change" | "intent_overlap" | "semantic_conflict" | "rebase_required" | "landed" | "land_blocked";

export interface DesiredSignal {
  fork: string;
  kind: SignalKind;
  about_fork: string | null;
  symbol: string | null;
  message: string;
  data: SignalData;
  dedupe_key: string;
}

export interface IndexSnapshot {
  forks: Array<{ name: string; agent: string }>;
  touched: Array<{ fork: string; path: string; change: string }>;
  symbolChanges: Array<{ fork: string; path: string; name: string; change: string; before_sig: string | null; after_sig: string | null }>;
  uses: Array<{ fork: string; path: string; symbol: string; from_path: string }>;
  intents: Array<{ fork: string; description: string; files: string[]; symbols: string[] }>;
}

/** Kinds recomputed from scratch on every index change; anything else is event-driven. */
export const DERIVED_KINDS: SignalKind[] = ["overlap", "signature_change", "intent_overlap"];

const BREAKING = new Set(["signature_changed", "removed"]);

export function deriveSignals(snap: IndexSnapshot): DesiredSignal[] {
  const active = new Set(snap.forks.map((f) => f.name));
  const out = new Map<string, DesiredSignal>();
  const add = (s: DesiredSignal) => out.set(s.dedupe_key, s);

  // 1. Breaking export changes reach every other fork that imports, edits, or plans to touch the symbol.
  for (const sc of snap.symbolChanges) {
    if (!active.has(sc.fork) || !BREAKING.has(sc.change)) continue;
    const verb = sc.change === "removed" ? "removing" : "changing the signature of";
    const shape = sc.change === "removed" ? "" : ` from ${sc.before_sig} to ${sc.after_sig}`;
    const reasons = new Map<string, string[]>();
    const note = (fork: string, why: string) => {
      if (fork === sc.fork || !active.has(fork)) return;
      reasons.set(fork, [...(reasons.get(fork) ?? []), why]);
    };
    for (const u of snap.uses) if (u.symbol === sc.name && u.from_path === sc.path) note(u.fork, `you use it in ${u.path}`);
    for (const t of snap.touched) if (t.path === sc.path) note(t.fork, `you also edit ${sc.path}`);
    for (const i of snap.intents) if (i.symbols.includes(sc.name) || i.files.includes(sc.path)) note(i.fork, `you declared an intent touching it`);

    for (const [fork, why] of reasons) {
      add({
        fork,
        kind: "signature_change",
        about_fork: sc.fork,
        symbol: sc.name,
        message: `${sc.fork} is ${verb} ${sc.name} (${sc.path})${shape}; ${unique(why).join(", ")}.`,
        data: { path: sc.path, change: sc.change, before: sc.before_sig, after: sc.after_sig, reasons: unique(why) },
        dedupe_key: `sig:${fork}:${sc.fork}:${sc.name}:${sc.after_sig ?? "removed"}`,
      });
      // The changer learns who depends on it too.
      add({
        fork: sc.fork,
        kind: "signature_change",
        about_fork: fork,
        symbol: sc.name,
        message: `${fork} depends on ${sc.name}, which you are ${verb.replace("changing the signature of", "changing")}: it ${unique(why).map(thirdPerson).join(", ")}.`,
        data: { path: sc.path, change: sc.change, dependents: unique(why) },
        dedupe_key: `sigdep:${sc.fork}:${fork}:${sc.name}:${sc.after_sig ?? "removed"}`,
      });
    }
  }

  // 2. Plain file overlaps between in-flight forks.
  const byPath = new Map<string, string[]>();
  for (const t of snap.touched) if (active.has(t.fork)) byPath.set(t.path, [...(byPath.get(t.path) ?? []), t.fork]);
  for (const [path, forks] of byPath) {
    for (const me of forks)
      for (const other of forks)
        if (me !== other)
          add({
            fork: me,
            kind: "overlap",
            about_fork: other,
            symbol: null,
            message: `${other} also modifies ${path}.`,
            data: { path },
            dedupe_key: `file:${me}:${other}:${path}`,
          });
  }

  // 3. Declared intents vs. other forks' actual changes and intents.
  for (const intent of snap.intents) {
    if (!active.has(intent.fork)) continue;
    for (const other of snap.forks) {
      if (other.name === intent.fork) continue;
      const files = new Set([...snap.touched.filter((t) => t.fork === other.name).map((t) => t.path), ...snap.intents.filter((i) => i.fork === other.name).flatMap((i) => i.files)]);
      const symbols = new Set([...snap.symbolChanges.filter((s) => s.fork === other.name).map((s) => s.name), ...snap.intents.filter((i) => i.fork === other.name).flatMap((i) => i.symbols)]);
      const hitFiles = intent.files.filter((f) => files.has(f));
      const hitSymbols = intent.symbols.filter((s) => symbols.has(s));
      if (!hitFiles.length && !hitSymbols.length) continue;
      const what = [...hitFiles, ...hitSymbols].join(", ");
      add({
        fork: other.name,
        kind: "intent_overlap",
        about_fork: intent.fork,
        symbol: hitSymbols[0] ?? null,
        message: `${intent.fork} plans to "${intent.description}", touching ${what}, which overlaps your work.`,
        data: { files: hitFiles, symbols: hitSymbols, description: intent.description },
        dedupe_key: `intent:${other.name}:${intent.fork}:${what}`,
      });
    }
  }

  return [...out.values()];
}

/** Overlaps returned synchronously from declare_intent: what in-flight work the intent collides with. */
export function intentConflicts(snap: IndexSnapshot, fork: string, files: string[], symbols: string[]) {
  const hits: Array<{ fork: string; reason: string }> = [];
  for (const t of snap.touched) if (t.fork !== fork && files.includes(t.path)) hits.push({ fork: t.fork, reason: `already modifies ${t.path}` });
  for (const s of snap.symbolChanges)
    if (s.fork !== fork && (symbols.includes(s.name) || files.includes(s.path)) && s.change !== "body_changed")
      hits.push({ fork: s.fork, reason: `${s.change.replace("_", " ")} ${s.name} in ${s.path}` });
  for (const u of snap.uses) if (u.fork !== fork && symbols.includes(u.symbol)) hits.push({ fork: u.fork, reason: `uses ${u.symbol} in ${u.path}` });
  for (const i of snap.intents) {
    if (i.fork === fork) continue;
    const f = i.files.filter((x) => files.includes(x));
    const s = i.symbols.filter((x) => symbols.includes(x));
    if (f.length || s.length) hits.push({ fork: i.fork, reason: `plans to "${i.description}" (${[...f, ...s].join(", ")})` });
  }
  const seen = new Set<string>();
  return hits.filter((h) => !seen.has(`${h.fork}|${h.reason}`) && seen.add(`${h.fork}|${h.reason}`));
}

const unique = <T,>(xs: T[]) => [...new Set(xs)];

/** "you use it in X" → "uses it in X", for messages addressed to the other side. */
const thirdPerson = (why: string) =>
  why.replace(/^you use /, "uses ").replace(/^you also edit /, "also edits ").replace(/^you declared /, "declared ");
