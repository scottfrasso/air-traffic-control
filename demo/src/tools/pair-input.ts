/** Dev helper: seed a baseline, create forks a/b with the demo edits, write a `pair` CHECK_INPUT JSON to argv[2]. */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agentmesh } from "../lib/agentmesh.ts";
import { Repo } from "../lib/git.ts";
import { agentAChangeSignature, agentBAddCaller } from "../scenario.ts";
import { seed } from "../seed.ts";

const out = process.argv[2] ?? "pair-input.json";
const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(2, 14);
const baseline = await seed(`ctest-${stamp}`);
const mesh = new Agentmesh(baseline);
const work = mkdtempSync(join(tmpdir(), "agentmesh-ctest-"));
const [a, b] = await Promise.all([mesh.createFork("a"), mesh.createFork("b")]);
const ra = Repo.clone(a.remote, a.token, join(work, "a"), { name: "a", email: "a@x" });
agentAChangeSignature(ra.dir);
ra.commitAll("A");
ra.push(a.remote);
const rb = Repo.clone(b.remote, b.token, join(work, "b"), { name: "b", email: "b@x" });
agentBAddCaller(rb.dir);
rb.commitAll("B");
rb.push(b.remote);
writeFileSync(out, JSON.stringify({ mode: "pair", a: { name: a.fork, remote: a.remote, token: a.token }, b: { name: b.fork, remote: b.remote, token: b.token } }));
console.log(baseline);
