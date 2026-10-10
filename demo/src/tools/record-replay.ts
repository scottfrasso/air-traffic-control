/**
 * Record a run's replay to a video file (webm) for the submission video. The API key is injected from .env into
 * the browser, never printed. Usage:
 *   tsx src/tools/record-replay.ts <baseline> <out-dir> [speed=2] [width=1920] [height=1080]
 * The replay's total length is read from the page; recording stops when it finishes (+2 s).
 */
import { existsSync, mkdirSync, readdirSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { config } from "../lib/env.ts";

const [baseline, outDir = "recordings", speed = "2", width = "1920", height = "1080"] = process.argv.slice(2);
if (!baseline) throw new Error("usage: record-replay.ts <baseline> <out-dir> [speed] [width] [height]");
mkdirSync(outDir, { recursive: true });
const cache = join(homedir(), "Library/Caches/ms-playwright");
const dir = readdirSync(cache).filter((d) => /^chromium-\d+$/.test(d)).sort().pop();
const exe = dir && [join(cache, dir, "chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"), join(cache, dir, "chrome-mac/Chromium.app/Contents/MacOS/Chromium")].find(existsSync);

const size = { width: Number(width), height: Number(height) };
const browser = await chromium.launch({ executablePath: exe });
const context = await browser.newContext({ viewport: size, deviceScaleFactor: 1, recordVideo: { dir: outDir, size } });
await context.addInitScript((key) => localStorage.setItem("agentmesh-key", key), config.apiKey());
const page = await context.newPage();
await page.goto(`${config.workerUrl}/r/${baseline}?replay&speed=${speed}`);
await page.waitForSelector("#clk", { timeout: 20000 });
// Wait until the replay clock reaches its end.
await page.waitForFunction(() => { const t = document.getElementById("clk")?.textContent ?? ""; const [a, b] = t.split(" / "); return !!a && a === b; }, undefined, { timeout: 15 * 60_000, polling: 500 });
await page.waitForTimeout(2000);
const video = page.video();
await context.close();
await browser.close();
const src = video ? await video.path() : null;
if (src) {
  const dest = join(outDir, `${baseline}-x${speed}.webm`);
  renameSync(src, dest);
  console.log(dest);
}
