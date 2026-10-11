import { test } from "node:test";
import assert from "node:assert/strict";
import { landGuard } from "../container/guard.ts";

test("land proceeds when main and the fork are where ATC checked them", () => {
  assert.equal(landGuard("main1", "main1", "fork1", "fork1"), null);
});
test("land refuses with retry when the fork moved after ATC checked it (issue #1)", () => {
  assert.match(landGuard("main1", "main1", "fork2aaaaaa", "fork1bbbbbb") ?? "", /^fork moved to fork2aa while landing \(ATC checked fork1bb\); retry$/);
});
test("land refuses with retry when main moved", () => {
  assert.match(landGuard("main2aaaaaa", "main1", "fork1", "fork1") ?? "", /^main moved to main2aa while landing; retry$/);
});
