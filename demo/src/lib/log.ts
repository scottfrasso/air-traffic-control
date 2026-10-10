const t0 = Date.now();
const colors = { A: "\x1b[33m", B: "\x1b[36m", system: "\x1b[35m", check: "\x1b[32m", fail: "\x1b[31m" } as const;

/** Timestamped, colored narration so the demo reads like a story in the terminal. */
export function say(who: keyof typeof colors, message: string) {
  const secs = ((Date.now() - t0) / 1000).toFixed(1).padStart(6);
  const label = who === "A" || who === "B" ? `agent ${who}` : who;
  console.log(`${secs}s ${colors[who]}${label.padEnd(9)}\x1b[0m ${message}`);
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Poll `fn` until it returns a truthy value or `timeoutMs` elapses. */
export async function waitFor<T>(what: string, fn: () => Promise<T | null | undefined | false>, timeoutMs = 180_000, everyMs = 1500): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs / 1000}s waiting for: ${what}`);
    await sleep(everyMs);
  }
}
