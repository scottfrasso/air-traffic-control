import { test } from "node:test";
import assert from "node:assert/strict";
import { ConfigError, matchesGlob, parseCiConfig, parseOwners, parseReviewConfig } from "../src/review/repoconfig";

test("no .atc/ci.yml means no CI configured (null), not an empty pass", () => {
  assert.equal(parseCiConfig(null), null);
});

test("CI commands parse, with a 300 s default timeout", () => {
  const cmds = parseCiConfig("commands:\n  - name: install\n    run: pnpm install --frozen-lockfile\n  - name: test\n    run: pnpm test\n    timeout: 600\n");
  assert.deepEqual(cmds, [
    { name: "install", run: "pnpm install --frozen-lockfile", timeoutSeconds: 300 },
    { name: "test", run: "pnpm test", timeoutSeconds: 600 },
  ]);
});

test("a CI timeout above 900 s is clamped to 900", () => {
  assert.equal(parseCiConfig("commands:\n  - name: slow\n    run: sleep 1\n    timeout: 5000\n")![0]!.timeoutSeconds, 900);
});

test("a CI command without run is a ConfigError naming the field", () => {
  assert.throws(() => parseCiConfig("commands:\n  - name: lint\n"), (e: unknown) => e instanceof ConfigError && /commands\.0\.run/.test(e.message));
});

test("broken YAML is a ConfigError, not a crash", () => {
  assert.throws(() => parseCiConfig("commands: [\n"), ConfigError);
});

test("review budgets default to 200/500/50 cents and override only what's given", () => {
  assert.deepEqual(parseReviewConfig(null).budgets, { classifier: 200, reviewer: 500, verifier: 50 });
  assert.deepEqual(parseReviewConfig("budgets:\n  reviewer: 900\n").budgets, { classifier: 200, reviewer: 900, verifier: 50 });
});

test("owners: one glob per line; blanks and comments ignored", () => {
  assert.deepEqual(parseOwners("# sensitive\nsrc/billing/**\n\n  migrations/*.sql  \n"), ["src/billing/**", "migrations/*.sql"]);
  assert.deepEqual(parseOwners(null), []);
});

test("globs: ** crosses directories, * and ? don't", () => {
  assert.equal(matchesGlob("src/a/b/billing-x.ts", "src/**/billing*.ts"), true);
  assert.equal(matchesGlob("src/billing.ts", "src/**/billing*.ts"), true);
  assert.equal(matchesGlob("src/a/billing.ts", "src/*.ts"), false);
  assert.equal(matchesGlob("src/a.ts", "src/?.ts"), true);
  assert.equal(matchesGlob("src/ab.ts", "src/?.ts"), false);
  assert.equal(matchesGlob("src/a.ts.bak", "src/*.ts"), false);
});

test("a .atc/ci.yml that lists no commands is a ConfigError (not 'pending' forever)", () => {
  assert.throws(() => parseCiConfig("commands: []\n"), (e: unknown) => e instanceof ConfigError && /no commands/.test(e.message));
});

test("budgets are capped server-side: a repo can't give a session an unbounded budget", () => {
  assert.deepEqual(parseReviewConfig("budgets:\n  classifier: 100000\n  reviewer: 999999\n  verifier: 5000\n").budgets, { classifier: 500, reviewer: 2000, verifier: 200 });
});
