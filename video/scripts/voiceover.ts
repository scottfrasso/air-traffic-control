/**
 * Generate the voice-over with ElevenLabs: one MP3 per line in src/data/script.ts, saved to public/vo/,
 * and their durations to src/data/vo.json. Unchanged lines are skipped. The API key is read from the
 * repo-root .env (ELEVENLABS_API_KEY) and never printed.
 *   pnpm voiceover [--force]
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { LINES, VOICE } from "../src/data/script.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../..");
const env = Object.fromEntries(readFileSync(resolve(ROOT, ".env"), "utf8").split("\n").filter((l) => l.includes("=") && !l.trim().startsWith("#")).map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim().replace(/^["']|["']$/g, "")]));
const key = process.env.ELEVENLABS_API_KEY ?? env.ELEVENLABS_API_KEY;
if (!key) throw new Error("ELEVENLABS_API_KEY is not set");

const manifestPath = resolve(HERE, "../src/data/vo.json");
const manifest: Record<string, { file: string; seconds: number; hash: string }> = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, "utf8")) : {};
const force = process.argv.includes("--force");

for (const [id, text] of Object.entries(LINES)) {
  const hash = createHash("sha1").update(`${VOICE.id}|${VOICE.model}|${text}`).digest("hex").slice(0, 12);
  const file = `vo/${id}.mp3`;
  const out = resolve(HERE, "../public", file);
  if (!force && manifest[id]?.hash === hash && existsSync(out)) continue;
  const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${VOICE.id}?output_format=mp3_44100_128`, {
    method: "POST",
    headers: { "xi-api-key": key, "content-type": "application/json", accept: "audio/mpeg" },
    body: JSON.stringify({ text, model_id: VOICE.model, voice_settings: { stability: 0.5, similarity_boost: 0.75, style: 0.15, speed: 1.05, use_speaker_boost: true } }),
  });
  if (!res.ok) throw new Error(`ElevenLabs ${res.status}: ${await res.text()}`);
  writeFileSync(out, Buffer.from(await res.arrayBuffer()));
  const probe = execFileSync("pnpm", ["exec", "remotion", "ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", out], { cwd: resolve(HERE, ".."), encoding: "utf8" });
  const seconds = Number(probe.trim().split("\n").pop());
  manifest[id] = { file, seconds, hash };
  console.log(`${id}: ${seconds.toFixed(2)} s`);
}
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
const total = Object.values(manifest).reduce((s, m) => s + m.seconds, 0);
console.log(`total speech: ${total.toFixed(1)} s`);
