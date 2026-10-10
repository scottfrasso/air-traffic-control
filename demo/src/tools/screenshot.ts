/** Screenshot the dashboard for a baseline. The API key is read from .env and injected into
 *  localStorage inside the browser, so it never appears on a command line or in logs.
 *    tsx src/tools/screenshot.ts <baseline> <out.png> [width] */
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { config } from "../lib/env.ts";

const [baseline, out = "dashboard.png", width = "1440"] = process.argv.slice(2);
if (!baseline) throw new Error("usage: screenshot.ts <baseline> <out.png> [width]");

// Use whichever Chromium is already in the local Playwright cache.
const cache = join(homedir(), "Library/Caches/ms-playwright");
const dir = readdirSync(cache).filter((d) => /^chromium-\d+$/.test(d)).sort().pop();
const exe = dir && [join(cache, dir, "chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"), join(cache, dir, "chrome-mac/Chromium.app/Contents/MacOS/Chromium")].find(existsSync);

const browser = await chromium.launch({ executablePath: exe });
const page = await browser.newPage({ viewport: { width: Number(width), height: 900 }, deviceScaleFactor: 2 });
await page.addInitScript((key) => localStorage.setItem("agentmesh-key", key), config.apiKey());
await page.goto(`${config.workerUrl}/r/${baseline}`);
await page.waitForSelector(".strip, .empty", { timeout: 15000 });
await page.waitForTimeout(1500);
await page.screenshot({ path: out, fullPage: true });
await browser.close();
console.log(out);
