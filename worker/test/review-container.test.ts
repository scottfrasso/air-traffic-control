import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

// container/check.ts modes for the review pipeline: snapshot, ci, merge. Plain Node + git, against local bare repos.

const HERE = dirname(fileURLToPath(import.meta.url));
const CHECK = join(HERE, "../container/check.ts");
const run = promisify(execFile);
const GIT_DIR = dirname(execFileSync("which", ["git"], { encoding: "utf8" }).trim());

/** A bare "remote" with main (a CI config and a source file) and a branch "fix" with one more commit. */
function repo(opts: { ci?: string; fixFiles?: Record<string, string> } = {}) {
  const root = mkdtempSync(join(tmpdir(), "atc-review-"));
  const remote = join(root, "shop.git");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", remote]);
  const work = join(root, "work");
  execFileSync("git", ["clone", "-q", remote, work]);
  const g = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: work, encoding: "utf8" }).trim();
  const write = (files: Record<string, string>) => {
    for (const [p, t] of Object.entries(files)) {
      mkdirSync(dirname(join(work, p)), { recursive: true });
      writeFileSync(join(work, p), t);
    }
  };
  write({ "src/cart.ts": "export const total = 1;\n", ...(opts.ci ? { ".atc/ci.yml": opts.ci } : {}), "REVIEW.md": "Money is in cents.\n" });
  g("add", "-A");
  g("commit", "-q", "-m", "base");
  g("push", "-q", "origin", "HEAD:main");
  const base = g("rev-parse", "HEAD");
  g("checkout", "-q", "-b", "fix");
  write(opts.fixFiles ?? { "src/cart.ts": "export const total = 2;\n", "src/new.ts": "export const n = 1;\n" });
  g("add", "-A");
  g("commit", "-q", "-m", "fix");
  g("push", "-q", "origin", "HEAD:fix");
  const head = g("rev-parse", "HEAD");
  const ref = { name: "shop", remote, token: "" };
  const check = async (input: object) => {
    const { stdout } = await run(process.execPath, ["--experimental-strip-types", "--no-warnings", CHECK], {
      env: { CHECK_INPUT: JSON.stringify(input), ATC_CACHE: join(root, "cache"), ATC_WORK: join(root, "w"), PATH: `${dirname(process.execPath)}:${GIT_DIR}:/usr/bin:/bin`, HOME: root, SECRET_TOKEN: "do-not-leak" },
    });
    return JSON.parse(stdout.split("\n").find((l) => l.startsWith("@@RESULT "))!.slice(9));
  };
  const mainHead = () => execFileSync("git", ["rev-parse", "main"], { cwd: remote, encoding: "utf8" }).trim();
  return { root, remote, base, head, ref, check, g, write, mainHead, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("snapshot: the repo at head as a tar.gz, the diff against base, the changed paths and the config files", { timeout: 60_000 }, async () => {
  const r = repo({ ci: "commands:\n  - name: t\n    run: true\n" });
  try {
    const s = await r.check({ mode: "snapshot", repo: r.ref, branch: "fix", target: "main", sha: r.head, base: r.base });
    assert.equal(s.error, undefined, s.error);
    assert.deepEqual(s.changedPaths.sort(), ["src/cart.ts", "src/new.ts"]);
    assert.match(s.diff, /^\+export const total = 2;$/m);
    assert.equal(s.config.ci, "commands:\n  - name: t\n    run: true\n");
    assert.equal(s.config.reviewMd, "Money is in cents.\n");
    assert.equal(s.config.owners, null);
    const tgz = join(r.root, "repo.tar.gz");
    writeFileSync(tgz, Buffer.from(s.tarGzBase64, "base64"));
    assert.deepEqual(execFileSync("tar", ["-tzf", tgz], { encoding: "utf8" }).split("\n").filter(Boolean).sort(), [".atc/", ".atc/ci.yml", "REVIEW.md", "src/", "src/cart.ts", "src/new.ts"]);
  } finally {
    r.cleanup();
  }
});

test("snapshot with since: only the changes after the last reviewed commit", { timeout: 60_000 }, async () => {
  const r = repo();
  try {
    const since = r.head;
    r.write({ "src/later.ts": "export const l = 1;\n" });
    r.g("add", "-A");
    r.g("commit", "-q", "-m", "later");
    r.g("push", "-q", "origin", "HEAD:fix");
    const head = r.g("rev-parse", "HEAD");
    const s = await r.check({ mode: "snapshot", repo: r.ref, branch: "fix", target: "main", sha: head, base: r.base, since });
    assert.deepEqual(s.changedPaths, ["src/later.ts"]);
    assert.doesNotMatch(s.diff, /total = 2/);
  } finally {
    r.cleanup();
  }
});

test("ci: each command is a check; a failure stops the rest; output is kept", { timeout: 60_000 }, async () => {
  const r = repo();
  try {
    const out = await r.check({
      mode: "ci", repo: r.ref, branch: "fix", sha: r.head,
      commands: [
        { name: "lists files", run: "ls src", timeoutSeconds: 30 },
        { name: "fails", run: "echo boom >&2; exit 3", timeoutSeconds: 30 },
        { name: "never runs", run: "true", timeoutSeconds: 30 },
      ],
    });
    assert.deepEqual(out.checks.map((c: { name: string; status: string }) => [c.name, c.status]), [["lists files", "passed"], ["fails", "failed"], ["never runs", "skipped"]]);
    assert.match(out.checks[0].log, /new\.ts/); // ran at the PR's head
    assert.match(out.checks[1].log, /boom/);
    assert.match(out.checks[1].log, /exit 3/);
  } finally {
    r.cleanup();
  }
});

test("ci: a command that runs past its timeout is killed and errored", { timeout: 60_000 }, async () => {
  const r = repo();
  try {
    const out = await r.check({ mode: "ci", repo: r.ref, branch: "fix", sha: r.head, commands: [{ name: "hangs", run: "sleep 30", timeoutSeconds: 1 }] });
    assert.equal(out.checks[0].status, "errored");
    assert.match(out.checks[0].log, /timed out after 1 s/);
  } finally {
    r.cleanup();
  }
});

test("ci: commands don't see the container's environment (no tokens)", { timeout: 60_000 }, async () => {
  const r = repo();
  try {
    const out = await r.check({ mode: "ci", repo: r.ref, branch: "fix", sha: r.head, commands: [{ name: "env", run: "env", timeoutSeconds: 10 }] });
    assert.doesNotMatch(out.checks[0].log, /do-not-leak|CHECK_INPUT/);
    assert.match(out.checks[0].log, /^CI=true$/m);
  } finally {
    r.cleanup();
  }
});

test("merge: CI passes on the merged commit, then main fast-forwards to it", { timeout: 60_000 }, async () => {
  const r = repo();
  try {
    const out = await r.check({ mode: "merge", repo: r.ref, source: "fix", target: "main", expectedSource: r.head, expectedTarget: r.base, message: "Merge PR1", commands: [{ name: "t", run: "test -f src/new.ts", timeoutSeconds: 10 }] });
    assert.equal(out.merged, true, JSON.stringify(out));
    assert.equal(r.mainHead(), out.sha);
  } finally {
    r.cleanup();
  }
});

test("merge: CI failing on the merged commit leaves main alone", { timeout: 60_000 }, async () => {
  const r = repo();
  try {
    const out = await r.check({ mode: "merge", repo: r.ref, source: "fix", target: "main", expectedSource: r.head, expectedTarget: r.base, message: "Merge PR1", commands: [{ name: "t", run: "exit 1", timeoutSeconds: 10 }] });
    assert.equal(out.merged, false);
    assert.match(out.reason, /CI failed on the merged commit/);
    assert.equal(r.mainHead(), r.base);
  } finally {
    r.cleanup();
  }
});

test("merge: refuses (retry) when the branch moved since the review", { timeout: 60_000 }, async () => {
  const r = repo();
  try {
    const out = await r.check({ mode: "merge", repo: r.ref, source: "fix", target: "main", expectedSource: "0".repeat(40), expectedTarget: r.base, message: "m", commands: [] });
    assert.deepEqual([out.merged, out.retry], [false, true]);
    assert.equal(r.mainHead(), r.base);
  } finally {
    r.cleanup();
  }
});
