/** Leave a live scene on the dashboard: A changed applyDiscount's signature, B added a caller. Prints the baseline. */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agentmesh } from "../lib/agentmesh.ts";
import { Repo } from "../lib/git.ts";
import { waitFor } from "../lib/log.ts";
import { agentAChangeSignature, agentBAddCaller } from "../scenario.ts";
import { seed } from "../seed.ts";

const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(2, 14);
const baseline = await seed(`shop-${stamp}`);
const mesh = new Agentmesh(baseline);
const work = mkdtempSync(join(tmpdir(), "agentmesh-scene-"));
const [a, b] = await Promise.all([mesh.createFork("alice"), mesh.createFork("bob")]);
await mesh.call("POST", "/intents", { fork: a.fork, description: "Make discounts structured", files: ["src/pricing.ts", "src/cart.ts"], symbols: ["applyDiscount"] });
const ra = Repo.clone(a.remote, a.token, join(work, "a"), { name: "alice", email: "alice@agentmesh.dev" });
agentAChangeSignature(ra.dir);
ra.commitAll("Discounts are structured");
ra.push(a.remote);
const rb = Repo.clone(b.remote, b.token, join(work, "b"), { name: "bob", email: "bob@agentmesh.dev" });
agentBAddCaller(rb.dir);
rb.commitAll("Member pricing at checkout");
rb.push(b.remote);
await waitFor("signals", async () => ((await mesh.state()).signals ?? []).some((s) => s.kind === "signature_change" && s.fork === b.fork && /checkout/.test(s.message)));
console.log(baseline);
