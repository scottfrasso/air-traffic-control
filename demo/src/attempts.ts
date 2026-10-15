/**
 * Competing attempts at one task (issue #19), end to end against deployed Cloudflare resources:
 *   1. Two agents take the same task ("free-shipping") and say so in declare_intent.
 *   2. X changes cartTotal's signature (two files); Y adds a new module (one file). Both typecheck.
 *   3. Once both are checked, ATC picks Y (smaller blast radius) and tells X to STAND DOWN, with why. X can't land.
 *   4. A person picks X instead (POST /choose), then picks Y back: the sequence follows the pick.
 *   5. Y lands; its flight log on main says what it was chosen over and why. X stands down for good.
 *   6. A second task: ATC picks one attempt, whose agent then goes quiet. After `stallSeconds` the other gets the task
 *      and lands; the quiet one stands down for good. Nobody had to press anything.
 *
 *   ./demo/run.sh --attempts [--browser]
 * --browser: step 4 clicks PICK on the live dashboard in a real (headless) Chromium instead of calling the API.
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { Agentmesh, type Signal } from "./lib/agentmesh.ts";
import { config } from "./lib/env.ts";
import { Repo } from "./lib/git.ts";
import { say, sleep, waitFor } from "./lib/log.ts";
import { seed } from "./seed.ts";

type LandResponse = { landed: boolean; reason?: string; retry?: boolean; baselineHead?: string };
type Entry = { fork: string; pr: string; clearance: string; reason: string };

let failed = false;
const check = (ok: boolean, what: string) => {
  say(ok ? "check" : "fail", `${ok ? "PASS" : "FAIL"} ${what}`);
  if (!ok) failed = true;
  return ok;
};
const step = (n: number, title: string) => console.log(`\n\x1b[1m── ${n}. ${title}\x1b[0m`);

const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(2, 14);
const work = mkdtempSync(join(tmpdir(), "agentmesh-attempts-"));
const baseline = await seed(`shop-${stamp}`);
const mesh = new Agentmesh(baseline);
say("system", `dashboard: ${config.workerUrl}/r/${baseline}`);
const TASK = "free-shipping";

const sequence = async () => ((await mesh.state()) as unknown as { sequence?: Entry[] }).sequence ?? [];
const entry = async (fork: string) => (await sequence()).find((e) => e.fork === fork);

try {
  step(1, `Two agents take the same task (${TASK})`);
  const x = await mesh.createFork("x");
  const y = await mesh.createFork("y");
  await mesh.call("POST", "/intents", { fork: x.fork, description: "Free shipping over $50: add it to cartTotal", files: ["src/cart.ts", "src/index.ts"], symbols: ["cartTotal"], task: TASK });
  const yi = await mesh.call<{ sameTask?: string[] }>("POST", "/intents", { fork: y.fork, description: "Free shipping over $50: a shipping module", files: ["src/shipping.ts"], symbols: [], task: TASK });
  check(yi.sameTask?.includes(x.fork) === true, `declare_intent tells Y that PR${x.pr} is on the same task`);

  step(2, "X changes cartTotal's signature; Y adds one new file");
  const rx = Repo.clone(x.remote, x.token, join(work, "x"), { name: "agent-x", email: "x@agentmesh.dev" });
  const cart = join(rx.dir, "src/cart.ts");
  writeFileSync(
    cart,
    readFileSync(cart, "utf8").replace(
      /export function cartTotal\([^)]*\): Cents \{\n.*\n\}/,
      `export function cartTotal(items: LineItem[], discountPercent: number, taxRate: number, freeShippingOver: Cents): Cents {
  const goods = applyTax(applyDiscount(subtotal(items), discountPercent), taxRate);
  return goods >= freeShippingOver ? goods : goods + 499;
}`,
    ),
  );
  const index = join(rx.dir, "src/index.ts");
  writeFileSync(index, readFileSync(index, "utf8").replace("cartTotal(items, 10, 0.08)", "cartTotal(items, 10, 0.08, 5000)"));
  rx.commitAll("Free shipping over $50 in cartTotal");
  rx.push(x.remote);
  say("A", `PR${x.pr} pushed ${rx.head().slice(0, 7)}: cartTotal(items, discount, tax) → cartTotal(..., freeShippingOver)`);

  const ry = Repo.clone(y.remote, y.token, join(work, "y"), { name: "agent-y", email: "y@agentmesh.dev" });
  writeFileSync(
    join(ry.dir, "src/shipping.ts"),
    `import type { Cents } from "./money";

/** Shipping is free from $50; otherwise a flat $4.99. */
export function shippingFor(goods: Cents): Cents {
  return goods >= 5000 ? 0 : 499;
}
`,
  );
  ry.commitAll("Free shipping over $50 as its own module");
  ry.push(y.remote);
  say("B", `PR${y.pr} pushed ${ry.head().slice(0, 7)}: new src/shipping.ts`);

  step(3, "Both are checked; ATC picks one and tells the other to stand down");
  const [ex, ey] = await waitFor("ATC's pick between the two attempts", async () => {
    const [a, b] = [await entry(x.fork), await entry(y.fork)];
    return a?.clearance === "stand_down" || b?.clearance === "stand_down" ? ([a!, b!] as const) : null;
  }, 300_000, 2000);
  say("system", `ATC ${ex.pr} ${ex.clearance.toUpperCase()}: ${ex.reason}`);
  say("system", `ATC ${ey.pr} ${ey.clearance.toUpperCase()}: ${ey.reason}`);
  check(ex.clearance === "stand_down" && /smaller blast radius \(0 vs 1 breaking changes to exported symbols\)/.test(ex.reason), `PR${x.pr} stands down: Y has the smaller blast radius`);
  check(ey.clearance === "cleared", `PR${y.pr} is cleared to land`);
  const refused = await mesh.call<LandResponse>("POST", "/land", { fork: x.fork });
  check(!refused.landed && !refused.retry && /which ships/.test(refused.reason ?? ""), `PR${x.pr}'s landing is refused: ${refused.reason}`);
  const told = (await mesh.call<Signal[]>("GET", `/signals?fork=${x.fork}`)).filter((s) => s.kind === "stand_down");
  check(told.length === 1 && told[0]!.about_fork === y.fork, `PR${x.pr} got one stand_down signal naming PR${y.pr}`);

  step(4, "A person overrides the pick, then picks ATC's choice back");
  if (process.argv.includes("--browser")) await pickOnDashboard(x.fork);
  else await mesh.call("POST", "/choose", { fork: x.fork, by: "attempts-demo" });
  const flipped = await waitFor("the sequence to follow the pick", async () => {
    const [a, b] = [await entry(x.fork), await entry(y.fork)];
    return a?.clearance === "cleared" && b?.clearance === "stand_down" ? b : null;
  }, 30_000, 1000);
  check(/picked by (attempts-demo|a person on the dashboard) over ATC's ranking/.test(flipped.reason), `PR${y.pr} now stands down: ${flipped.reason}`);
  await mesh.call("POST", "/choose", { fork: y.fork, by: "attempts-demo" });
  check((await entry(y.fork))?.clearance === "cleared", `picked back: PR${y.pr} is cleared again`);

  step(5, `PR${y.pr} lands; its flight log says what it was chosen over`);
  let landed: LandResponse;
  for (;;) {
    landed = await mesh.call<LandResponse>("POST", "/land", { fork: y.fork });
    if (!landed.retry) break;
    say("B", `land: ${landed.reason}`);
    await sleep(3000);
  }
  check(landed.landed, `PR${y.pr} landed: ${landed.landed ? `main is now ${landed.baselineHead?.slice(0, 7)}` : landed.reason}`);
  const after = await waitFor(`PR${x.pr} standing down for good`, async () => {
    const e = await entry(x.fork);
    return e?.clearance === "stand_down" && /already landed this task/.test(e.reason) ? e : null;
  }, 60_000, 1500);
  say("system", `ATC ${after.pr} ${after.clearance.toUpperCase()}: ${after.reason}`);
  check(true, `PR${x.pr} stands down for good once PR${y.pr} landed`);
  const st = await waitFor("the flight log note in git", async () => {
    const s = await mesh.state();
    return s.flightLogs?.some((l) => l.fork === y.fork && l.noted) ? s : null;
  }, 60_000, 1000);
  const log = st.flightLogs!.find((l) => l.fork === y.fork)!;
  const final = Repo.clone(x.baselineRemote, x.baselineToken, join(work, "final"), { name: "verify", email: "verify@agentmesh.dev" });
  final.git(["fetch", "-q", x.baselineRemote, "refs/notes/atc:refs/notes/atc"], { remote: x.baselineRemote });
  const note = final.git(["notes", "--ref=atc", "show", log.landedSha], { allowFail: true });
  const line = note.out.split("\n").find((l) => l.startsWith("ATC-Chosen-Over:")) ?? "";
  say("system", line || "(no ATC-Chosen-Over line)");
  check(note.ok && new RegExp(`^ATC-Chosen-Over: PR${x.pr} \\(smaller blast radius .*; confirmed by attempts-demo\\)$`).test(line), `PR${y.pr}'s git note records the attempt it was chosen over, and why`);
  await mesh.abandon(x.fork); // what the losing agent does next

  step(6, "A second task: ATC's pick goes quiet, and the other attempt gets the task by itself");
  const QUIET_S = 20;
  await mesh.call("POST", "/settings", { stallSeconds: QUIET_S });
  say("system", `stallSeconds = ${QUIET_S}: the attempt that ships must push, ask to land or declare something within ${QUIET_S} s`);
  const q = await mesh.createFork("q");
  const w = await mesh.createFork("w");
  for (const [c, files] of [[q, ["src/gift.ts"]], [w, ["src/wrap.ts", "src/wrap-price.ts"]]] as const)
    await mesh.call("POST", "/intents", { fork: c.fork, description: "Gift wrapping at checkout", files, symbols: [], task: "gift-wrap" });
  const rq = Repo.clone(q.remote, q.token, join(work, "q"), { name: "agent-q", email: "q@agentmesh.dev" });
  writeFileSync(join(rq.dir, "src/gift.ts"), `import type { Cents } from "./money";

/** Gift wrapping: a flat $3. */
export const giftWrap = (): Cents => 300;
`);
  rq.commitAll("Gift wrapping");
  rq.push(q.remote);
  const rw = Repo.clone(w.remote, w.token, join(work, "w"), { name: "agent-w", email: "w@agentmesh.dev" });
  writeFileSync(join(rw.dir, "src/wrap-price.ts"), `import type { Cents } from "./money";

export const WRAP_PRICE: Cents = 300;
`);
  writeFileSync(join(rw.dir, "src/wrap.ts"), `import type { Cents } from "./money";
import { WRAP_PRICE } from "./wrap-price";

/** Gift wrapping at checkout. */
export const wrapCost = (): Cents => WRAP_PRICE;
`);
  rw.commitAll("Gift wrapping (two modules)");
  rw.push(w.remote);
  say("system", `PR${q.pr} (one file) and PR${w.pr} (two files) pushed, both on task gift-wrap`);
  const firstPick = await waitFor("ATC's pick for gift-wrap", async () => {
    const e = await entry(w.fork);
    return e?.clearance === "stand_down" ? e : null;
  }, 300_000, 2000);
  say("system", `ATC ${firstPick.pr} STAND_DOWN: ${firstPick.reason}`);
  check(/1 vs 2 exported symbols changed|fewer files touched \(1 vs 2\)/.test(firstPick.reason), `PR${q.pr} is ATC's pick (the smaller change); PR${w.pr} stands down`);
  say("A", `agent Q stops here: it never asks to land`);
  const t0 = Date.now();
  const handed = await waitFor(`PR${w.pr} to get the task once PR${q.pr} goes quiet`, async () => {
    const e = await entry(w.fork);
    return e?.clearance === "cleared" ? e : null;
  }, 180_000, 2000);
  const quiet = (await entry(q.fork))!;
  say("system", `ATC ${quiet.pr} ${quiet.clearance.toUpperCase()}: ${quiet.reason}`);
  check(quiet.clearance === "stand_down" && /hasn't pushed, asked to land or declared an intent for 20 s/.test(quiet.reason), `after ${Math.round((Date.now() - t0) / 1000)} s, PR${q.pr} is set aside as quiet and PR${w.pr} is ${handed.clearance.toUpperCase()}`);
  let wl: LandResponse;
  for (;;) {
    wl = await mesh.call<LandResponse>("POST", "/land", { fork: w.fork });
    if (!wl.retry) break;
    await sleep(3000);
  }
  check(wl.landed, `PR${w.pr} landed: ${wl.landed ? `main is now ${wl.baselineHead?.slice(0, 7)}` : wl.reason}`);
  const qFinal = await waitFor(`PR${q.pr} standing down for good`, async () => {
    const e = await entry(q.fork);
    return e && /already landed this task/.test(e.reason) ? e : null;
  }, 60_000, 1500);
  check(qFinal.clearance === "stand_down", `PR${q.pr} stands down for good: ${qFinal.reason}`);
  const st2 = await waitFor("PR's flight log in git", async () => {
    const s = await mesh.state();
    return s.flightLogs?.some((l) => l.fork === w.fork && l.noted) ? s : null;
  }, 60_000, 1000);
  const wLog = st2.flightLogs!.find((l) => l.fork === w.fork)!;
  check(new RegExp(`^ATC-Chosen-Over: PR${q.pr} \\(PR${q.pr} went quiet for 20 s\\)$`, "m").test(wLog.note), `PR${w.pr}'s flight log: ATC-Chosen-Over: PR${q.pr} (PR${q.pr} went quiet for 20 s)`);
  await mesh.abandon(q.fork);
} catch (err) {
  failed = true;
  say("fail", (err as Error).message);
} finally {
  rmSync(work, { recursive: true, force: true });
}

/** Click PICK on `fork`'s row of the live dashboard. The API key goes into the page's localStorage, never a command line. */
async function pickOnDashboard(fork: string) {
  const { chromium } = await import("playwright-core");
  const cache = join(homedir(), "Library/Caches/ms-playwright");
  const dir = existsSync(cache) ? readdirSync(cache).filter((d) => /^chromium-\d+$/.test(d)).sort().pop() : undefined;
  const exe = dir && [join(cache, dir, "chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"), join(cache, dir, "chrome-mac/Chromium.app/Contents/MacOS/Chromium")].find(existsSync);
  const browser = await chromium.launch({ executablePath: exe });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.addInitScript((key) => localStorage.setItem("agentmesh-key", key), config.apiKey());
    await page.goto(`${config.workerUrl}/r/${baseline}`);
    const button = page.locator(`button[data-pick="${fork}"]`);
    await button.waitFor({ timeout: 20_000 });
    say("system", `dashboard shows PICK on ${fork.split("--").pop()?.toUpperCase()}'s STAND DOWN row; clicking it`);
    await button.click();
    await page.locator(`li:has(button[data-pick]) .clr.c-stand_down`).first().waitFor({ timeout: 20_000 });
    await page.waitForFunction((f) => !document.querySelector(`button[data-pick="${f}"]`), fork, { timeout: 20_000 });
    check(true, "the PICK button is gone from that row, and the other attempt now shows STAND DOWN with PICK");
  } finally {
    await browser.close();
  }
}

console.log(`\n${failed ? "\x1b[31mATTEMPTS DEMO FAILED" : "\x1b[32mATTEMPTS DEMO PASSED"}\x1b[0m  dashboard: ${config.workerUrl}/r/${baseline}`);
process.exit(failed ? 1 : 0);
