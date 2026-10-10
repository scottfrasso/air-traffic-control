import { changedLines, diffExports, extractExports, extractImports, resolveImport, type SymbolDelta } from "./symbols";

/** Fork repos are named `<baseline>--<agent>`. */
export const forkName = (baseline: string, agent: string) => `${baseline}--${agent}`;
export const baselineOf = (repoName: string) => repoName.split("--")[0] ?? repoName;

export async function headOf(env: Env, repo: string, ref = "main"): Promise<ArtifactsCommitMetadata | null> {
  using handle = await env.ARTIFACTS.get(repo);
  return (await handle.log({ ref, limit: 1 }))[0] ?? null;
}

export type FileChange = "added" | "modified" | "deleted";

export interface TouchedFile {
  path: string;
  change: FileChange;
  lines: number;
  symbols: SymbolDelta[];
  /** Named imports in the fork's version of this file, resolved to repo paths. */
  imports: Array<{ name: string; from: string }>;
}

export interface ForkIndex {
  fork: string;
  headSha: string;
  /** Baseline commit this fork's work is based on (newest fork ancestor that is on baseline main). */
  baseSha: string;
  baselineHead: string;
  files: TouchedFile[];
  diffLines: number;
}

const TEXT = /\.(ts|tsx|mts|cts|js|mjs|json|md)$/;
const CODE = /\.(ts|tsx|mts|cts)$/;

/**
 * Compute what a fork changed relative to its base on baseline, using only the Artifacts
 * binding (log/readCommit/readTree/readBlob). Recurses only into subtrees whose hash differs.
 */
export async function indexFork(env: Env, baseline: string, fork: string, headSha: string): Promise<ForkIndex> {
  using forkRepo = await env.ARTIFACTS.get(fork);
  using baseRepo = await env.ARTIFACTS.get(baseline);

  const [forkLog, baseLog] = await Promise.all([forkRepo.log({ ref: headSha, limit: 200 }), baseRepo.log({ ref: "main", limit: 200 })]);
  const onBaseline = new Set(baseLog.map((c) => c.hash));
  const base = forkLog.find((c) => onBaseline.has(c.hash));
  if (!base) throw new Error(`no common ancestor between ${fork}@${headSha} and ${baseline}/main`);
  const head = forkLog[0];
  if (!head) throw new Error(`cannot resolve ${fork}@${headSha}`);

  const changed: Array<{ path: string; before: string | null; after: string | null }> = [];
  async function walk(prefix: string, beforeTree: string | null, afterTree: string | null) {
    if (beforeTree === afterTree) return;
    const [b, a] = await Promise.all([
      beforeTree ? forkRepo.readTree(beforeTree) : Promise.resolve([]),
      afterTree ? forkRepo.readTree(afterTree) : Promise.resolve([]),
    ]);
    const before = new Map((b ?? []).map((e) => [e.name, e]));
    const after = new Map((a ?? []).map((e) => [e.name, e]));
    const jobs: Promise<void>[] = [];
    for (const name of new Set([...before.keys(), ...after.keys()])) {
      const be = before.get(name);
      const ae = after.get(name);
      if (be?.hash === ae?.hash) continue;
      const path = prefix ? `${prefix}/${name}` : name;
      const bTree = be?.type === "tree" ? be.hash : null;
      const aTree = ae?.type === "tree" ? ae.hash : null;
      if (bTree || aTree) jobs.push(walk(path, bTree, aTree));
      const bBlob = be && be.type !== "tree" ? be.hash : null;
      const aBlob = ae && ae.type !== "tree" ? ae.hash : null;
      if (bBlob !== aBlob) changed.push({ path, before: bBlob, after: aBlob });
    }
    await Promise.all(jobs);
  }
  await walk("", base.treeHash, head.treeHash);

  // Paths that exist at head, for import resolution.
  const headPaths = await listPaths(forkRepo, head.treeHash);
  const exists = (p: string) => headPaths.has(p);

  const readText = async (hash: string | null) => {
    if (!hash) return "";
    const blob = await forkRepo.readBlob(hash);
    return blob ? await blob.text() : "";
  };

  const files: TouchedFile[] = await Promise.all(
    changed
      .sort((x, y) => x.path.localeCompare(y.path))
      .map(async (c): Promise<TouchedFile> => {
        const change: FileChange = !c.before ? "added" : !c.after ? "deleted" : "modified";
        if (!TEXT.test(c.path)) return { path: c.path, change, lines: 1, symbols: [], imports: [] };
        const [before, after] = await Promise.all([readText(c.before), readText(c.after)]);
        const isCode = CODE.test(c.path);
        return {
          path: c.path,
          change,
          lines: changedLines(before, after),
          symbols: isCode ? diffExports(extractExports(before), extractExports(after)) : [],
          imports: isCode
            ? extractImports(after).flatMap((i) => {
                const from = resolveImport(c.path, i.from, exists);
                return from ? [{ name: i.name, from }] : [];
              })
            : [],
        };
      }),
  );

  return {
    fork,
    headSha: head.hash,
    baseSha: base.hash,
    baselineHead: baseLog[0]?.hash ?? base.hash,
    files,
    diffLines: files.reduce((n, f) => n + f.lines, 0),
  };
}

async function listPaths(repo: ArtifactsRepo, treeHash: string, prefix = ""): Promise<Set<string>> {
  const out = new Set<string>();
  const entries = (await repo.readTree(treeHash)) ?? [];
  await Promise.all(
    entries.map(async (e) => {
      const path = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.type === "tree") for (const p of await listPaths(repo, e.hash, path)) out.add(p);
      else out.add(path);
    }),
  );
  return out;
}
