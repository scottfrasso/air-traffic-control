/**
 * Create a fresh baseline repo in Artifacts and "import" the sample repo into it by pushing
 * with a normal git client (Artifacts import() needs a public HTTPS URL; ours is local).
 * Prints the baseline name on stdout's last line.
 *
 *   tsx src/seed.ts [name]
 */
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { artifacts } from "./lib/artifacts.ts";
import { ROOT } from "./lib/env.ts";
import { Repo } from "./lib/git.ts";
import { say } from "./lib/log.ts";

export async function seed(name: string): Promise<string> {
  const created = await artifacts.create(name, "agentmesh demo baseline (shop-core)");
  const dir = mkdtempSync(join(tmpdir(), "agentmesh-seed-"));
  try {
    cpSync(join(ROOT, "sample-repo"), dir, { recursive: true, filter: (src) => !src.includes("node_modules") });
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
    const repo = new Repo(dir, { [created.remote]: created.token }, { name: "agentmesh", email: "seed@agentmesh.dev" });
    repo.commitAll("Import shop-core");
    repo.push(created.remote);
    say("system", `baseline ${name} created and seeded at ${repo.head().slice(0, 7)}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  return name;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(2, 14);
  console.log(await seed(process.argv[2] ?? `shop-${stamp}`));
}
