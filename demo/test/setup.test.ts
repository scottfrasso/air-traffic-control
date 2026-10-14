import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { withVars } from "../src/setup.ts";

test("setup points wrangler.jsonc at the account and queue, and is idempotent (issue #18)", () => {
  const real = readFileSync(new URL("../../worker/wrangler.jsonc", import.meta.url), "utf8");
  const once = withVars(real, { CF_ACCOUNT_ID: "acct123", PUSH_QUEUE_ID: "queue456" });
  assert.match(once, /"CF_ACCOUNT_ID": "acct123"/);
  assert.match(once, /"PUSH_QUEUE_ID": "queue456"/);
  assert.equal(withVars(once, { CF_ACCOUNT_ID: "acct123", PUSH_QUEUE_ID: "queue456" }), once);
  assert.equal(once.split("\n").length, real.split("\n").length); // nothing else changed
  assert.throws(() => withVars(real, { NOPE: "x" }), /no "NOPE" var/);
});
