import { test } from "node:test";
import assert from "node:assert/strict";
import { publicReplayBaseline } from "../src/public.ts";

const allow = "shop-1, demo-2";

test("allow-listed baseline's timeline is public", () => {
  assert.equal(publicReplayBaseline("GET", "/api/repos/shop-1/timeline", allow), "shop-1");
  assert.equal(publicReplayBaseline("GET", "/api/repos/demo-2/timeline", allow), "demo-2");
});
test("baselines not on the list stay private", () => {
  assert.equal(publicReplayBaseline("GET", "/api/repos/shop-9/timeline", allow), null);
  assert.equal(publicReplayBaseline("GET", "/api/repos/shop-1/timeline", undefined), null);
  assert.equal(publicReplayBaseline("GET", "/api/repos/shop-1/timeline", ""), null);
});
test("only the timeline read is public: no state, live socket, forks, land or other methods", () => {
  for (const p of ["/state", "/live", "/forks", "/land", "/intents", "/webhooks", "/history", "/signals", "/timeline/x", "/reconcile"])
    assert.equal(publicReplayBaseline("GET", `/api/repos/shop-1${p}`, allow), null, p);
  for (const m of ["POST", "PUT", "DELETE", "PATCH"]) assert.equal(publicReplayBaseline(m, "/api/repos/shop-1/timeline", allow), null, m);
  assert.equal(publicReplayBaseline("GET", "/mcp", allow), null);
});
test("HEAD is allowed; OPTIONS, trailing slashes, encoded or differently cased names are not", () => {
  assert.equal(publicReplayBaseline("HEAD", "/api/repos/shop-1/timeline", allow), "shop-1");
  assert.equal(publicReplayBaseline("OPTIONS", "/api/repos/shop-1/timeline", allow), null);
  assert.equal(publicReplayBaseline("GET", "/api/repos/shop-1/timeline/", allow), null);
  assert.equal(publicReplayBaseline("GET", "/api/repos/shop%2D1/timeline", allow), null);
  assert.equal(publicReplayBaseline("GET", "/api/repos/SHOP-1/timeline", allow), null);
});
