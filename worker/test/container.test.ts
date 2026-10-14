import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

// container/check.ts is plain Node + git + tsc, so it runs here against temporary git repos (issue #8).

const HERE = dirname(fileURLToPath(import.meta.url));
const CHECK = join(HERE, "../container/check.ts");
const TSC_BIN = join(HERE, "../node_modules/.bin");
const run = promisify(execFile);
const GIT_DIR = dirname(execFileSync("which", ["git"], { encoding: "utf8" }).trim());

function repo(root: string, name: string, files: Record<string, string>, from?: string): string {
  const dir = join(root, name);
  if (from) execFileSync("git", ["clone", "-q", from, dir]);
  else {
    mkdirSync(dir);
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  }
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", name], { cwd: dir });
  return dir;
}

/** A baseline and three PRs: A changes applyDiscount's parameters (and its caller), B adds a new caller, C is unrelated. */
function airspace() {
  const root = mkdtempSync(join(tmpdir(), "atc-check-"));
  const base = repo(root, "shop", {
    "tsconfig.json": JSON.stringify({ compilerOptions: { strict: true, noEmit: true, target: "es2022", module: "esnext", moduleResolution: "bundler" }, include: ["src"] }),
    "src/price.ts": "export function applyDiscount(price: number, pct: number): number {\n  return price * (1 - pct / 100);\n}\n",
    "src/cart.ts": 'import { applyDiscount } from "./price";\nexport const total = applyDiscount(100, 10);\n',
  });
  const a = repo(root, "shop--pr1", {
    "src/price.ts": "export function applyDiscount(price: number, d: { pct: number }): number {\n  return price * (1 - d.pct / 100);\n}\n",
    "src/cart.ts": 'import { applyDiscount } from "./price";\nexport const total = applyDiscount(100, { pct: 10 });\n',
  }, base);
  const b = repo(root, "shop--pr2", { "src/checkout.ts": 'import { applyDiscount } from "./price";\nexport const pay = applyDiscount(50, 5);\n' }, base);
  const c = repo(root, "shop--pr3", { "src/readme.ts": "export const about = 'shop';\n" }, base);
  const cache = join(root, "cache");
  const work = join(root, "work");
  const ref = (dir: string) => ({ name: dir.split("/").pop()!, remote: dir, token: "" });
  // This test's own node first: the tsc shim runs `node`, which must be the one running the tests.
  const check = async (input: object, path = `${dirname(process.execPath)}:${TSC_BIN}:${GIT_DIR}:/usr/bin:/bin`) => {
    const { stdout } = await run(process.execPath, ["--experimental-strip-types", "--no-warnings", CHECK], {
      env: { CHECK_INPUT: JSON.stringify(input), ATC_CACHE: cache, ATC_WORK: work, PATH: path, HOME: root },
    });
    return JSON.parse(stdout.split("\n").find((l) => l.startsWith("@@RESULT "))!.slice(9));
  };
  return { root, base: ref(base), a: ref(a), b: ref(b), c: ref(c), cache, check, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("two pair checks in parallel on one shared cache both give the right answer", { timeout: 120_000 }, async () => {
  const s = airspace();
  try {
    // Four at once, so the shared repo sees concurrent fetches, worktree adds and ref updates.
    const [ab, bc, ac, ab2] = await Promise.all([
      s.check({ mode: "pair", a: s.a, b: s.b, baseline: s.base }),
      s.check({ mode: "pair", a: s.b, b: s.c, baseline: s.base }),
      s.check({ mode: "pair", a: s.a, b: s.c, baseline: s.base }),
      s.check({ mode: "pair", a: s.a, b: s.b, baseline: s.base }),
    ]);
    for (const r of [ab, bc, ac, ab2]) assert.equal(r.error, undefined, r.error);
    // A and B each typecheck alone, merge cleanly, and the merge fails: B's new caller uses the old parameters.
    for (const r of [ab, ab2]) {
      assert.deepEqual([r.aloneA.ok, r.aloneB.ok, r.merge.clean, r.merge.typecheck.ok], [true, true, true, false]);
      assert.equal(r.merge.typecheck.errors[0].file, "src/checkout.ts");
    }
    for (const r of [bc, ac]) assert.deepEqual([r.aloneA.ok, r.aloneB.ok, r.merge.clean, r.merge.typecheck.ok], [true, true, true, true]);
    assert.deepEqual(readdirSync(join(s.cache, "tc")).filter((f) => !f.endsWith(".json")), []); // no temp files left behind
    assert.deepEqual(readdirSync(join(s.cache, "tsbuild")).filter((f) => !f.endsWith(".tsbuildinfo")), []);
    assert.deepEqual(readdirSync(s.cache).filter((f) => f.startsWith("git.lock")), []); // no lock or lock debris
  } finally {
    s.cleanup();
  }
});

test("an environment failure (no tsc) is not cached; the next run gets the real result", { timeout: 60_000 }, async () => {
  const s = airspace();
  try {
    const broken = await s.check({ mode: "single", repo: s.c, baseline: s.base }, `${GIT_DIR}:/usr/bin:/bin`); // tsc isn't on this PATH
    assert.equal(broken.result.ok, false);
    assert.deepEqual(readdirSync(join(s.cache, "tc")), []); // nothing cached
    const real = await s.check({ mode: "single", repo: s.c, baseline: s.base });
    assert.deepEqual([real.result.ok, real.result.cached], [true, false]);
    const again = await s.check({ mode: "single", repo: s.c, baseline: s.base });
    assert.deepEqual([again.result.ok, again.result.cached], [true, true]); // real outcomes are cached
  } finally {
    s.cleanup();
  }
});

test("a lock left by a killed check is broken once, and every waiting check still gets the right answer (review of #34)", { timeout: 120_000 }, async () => {
  const s = airspace();
  try {
    await s.check({ mode: "single", repo: s.c, baseline: s.base }); // creates the cache dirs
    // A check that held the lock and was killed by the hard timeout: its pid is gone.
    const dead = execFileSync(process.execPath, ["-e", "console.log(process.pid)"], { encoding: "utf8" }).trim();
    mkdirSync(join(s.cache, "git.lock"));
    writeFileSync(join(s.cache, "git.lock", "pid"), dead);
    const results = await Promise.all(
      [s.a, s.b, s.c, s.a, s.b, s.c].map((r, i) => s.check({ mode: "pair", a: r, b: [s.b, s.c, s.a][i % 3]!, baseline: s.base })),
    );
    for (const r of results) assert.equal(r.error, undefined, r.error);
    assert.equal(existsSync(join(s.cache, "git.lock")), false); // released at the end
  } finally {
    s.cleanup();
  }
});

test("an old lock directory with no owner (from older code) doesn't wedge the container", { timeout: 60_000 }, async () => {
  const s = airspace();
  try {
    await s.check({ mode: "single", repo: s.c, baseline: s.base });
    const lock = join(s.cache, "git.lock");
    mkdirSync(lock);
    utimesSync(lock, new Date(2026, 0, 1), new Date(2026, 0, 1));
    const r = await s.check({ mode: "single", repo: s.a, baseline: s.base });
    assert.equal(r.error, undefined, r.error);
    assert.equal(r.result.ok, true);
  } finally {
    s.cleanup();
  }
});

test("checks running at once share main's build and each fork's own result instead of redoing them (issue #9)", { timeout: 120_000 }, async () => {
  const s = airspace();
  try {
    // One push's checks, all at once, as ATC starts them: its check on main and its pairs with the others.
    const results = await Promise.all([
      s.check({ mode: "single", repo: s.a, baseline: s.base }),
      s.check({ mode: "pair", a: s.a, b: s.b, baseline: s.base }),
      s.check({ mode: "pair", a: s.a, b: s.c, baseline: s.base }),
    ]);
    const steps = results.flatMap((r) => r.timings as Array<{ step: string; cached?: boolean }>);
    assert.equal(steps.filter((t) => t.step === "build main incremental state").length, 1); // not once per check
    // A sits on main, so "A on main" and "A alone" are the same tree: tsc runs on it once, the other two are cache hits.
    const aTree = steps.filter((t) => t.step === "typecheck on main" || t.step === "typecheck A alone");
    assert.equal(aTree.length, 3);
    assert.equal(aTree.filter((t) => !t.cached).length, 1);
  } finally {
    s.cleanup();
  }
});

// ── more modes (issue #11) ──

test("a textual conflict: both PRs edit the same line, and the merge lists the file", { timeout: 60_000 }, async () => {
  const s = airspace();
  try {
    const d = repo(s.root, "shop--pr4", { "src/cart.ts": 'import { applyDiscount } from "./price";\nexport const total = applyDiscount(100, 20);\n' }, s.base.remote);
    const r = await s.check({ mode: "pair", a: s.a, b: { name: "shop--pr4", remote: d, token: "" }, baseline: s.base });
    assert.equal(r.error, undefined, r.error);
    assert.equal(r.merge.clean, false);
    assert.deepEqual(r.merge.conflicts, ["src/cart.ts"]);
  } finally {
    s.cleanup();
  }
});

test("land: a PR on current main lands (main moves to it); a stale expected head is refused with retry", { timeout: 60_000 }, async () => {
  const s = airspace();
  try {
    const bare = join(s.root, "shop.git");
    execFileSync("git", ["clone", "-q", "--bare", s.base.remote, bare]);
    const main = () => execFileSync("git", ["rev-parse", "main"], { cwd: bare, encoding: "utf8" }).trim();
    const base = { name: "shop", remote: bare, token: "" };
    const before = main();
    const cHead = execFileSync("git", ["rev-parse", "HEAD"], { cwd: s.c.remote, encoding: "utf8" }).trim();
    const ok = await s.check({ mode: "land", fork: { ...s.c, expectedHead: cHead }, baseline: { ...base, expectedHead: before } });
    assert.equal(ok.error, undefined, ok.error);
    assert.equal(ok.landed, true);
    assert.equal(main(), ok.landedSha); // pushed to main
    // Another landing pinned to the old main: the guard refuses it instead of landing on a main it didn't check.
    const stale = await s.check({ mode: "land", fork: { ...s.a }, baseline: { ...base, expectedHead: before } });
    assert.deepEqual([stale.landed, stale.retry], [false, true]);
    assert.equal(main(), ok.landedSha); // nothing moved
  } finally {
    s.cleanup();
  }
});

test("land: a PR that fits alone but breaks on the new main is refused as a main conflict, and main doesn't move", { timeout: 60_000 }, async () => {
  const s = airspace();
  try {
    const bare = join(s.root, "shop.git");
    execFileSync("git", ["clone", "-q", "--bare", s.base.remote, bare]);
    const main = () => execFileSync("git", ["rev-parse", "main"], { cwd: bare, encoding: "utf8" }).trim();
    const base = { name: "shop", remote: bare, token: "" };
    const first = await s.check({ mode: "land", fork: s.a, baseline: { ...base, expectedHead: main() } }); // A changes applyDiscount
    assert.equal(first.landed, true, first.reason);
    const after = main();
    const second = await s.check({ mode: "land", fork: s.b, baseline: { ...base, expectedHead: after } }); // B calls it the old way
    assert.deepEqual([second.landed, second.mainConflict], [false, true]);
    assert.equal(second.typecheck.errors[0].file, "src/checkout.ts");
    assert.equal(main(), after);
  } finally {
    s.cleanup();
  }
});
