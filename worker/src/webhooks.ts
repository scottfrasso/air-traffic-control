/** Outbound webhooks (ADR-0014): one signed POST per event, with a timeout and one retry (issue #10). */

const TIMEOUT_MS = 5_000;
const RETRY_AFTER_MS = 1_000;

/** `sha256=<hex>` HMAC of the body with the webhook's secret. */
export async function signature(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)));
  return `sha256=${[...sig].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

/**
 * POST one event. A receiver that is slow (over 5 s), unreachable or answers 5xx/429 gets one more try a second
 * later; then the event is dropped (receivers can catch up from GET /timeline). Never throws.
 */
export async function deliver(url: string, secret: string | null, body: string, fetcher: typeof fetch = fetch, wait = (ms: number) => new Promise((r) => setTimeout(r, ms))): Promise<{ ok: boolean; attempts: number }> {
  const headers: Record<string, string> = { "content-type": "application/json", "user-agent": "atc-webhooks/1" };
  if (secret) headers["x-atc-signature"] = await signature(secret, body);
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await fetcher(url, { method: "POST", headers, body, signal: AbortSignal.timeout(TIMEOUT_MS) });
      await res.body?.cancel(); // the body is never read: free the connection now (review of #40)
      if (res.ok || (res.status < 500 && res.status !== 429)) return { ok: res.ok, attempts: attempt }; // a 4xx won't change on retry
    } catch {
      /* timeout or network error: retry once */
    }
    if (attempt === 1) await wait(RETRY_AFTER_MS);
  }
  return { ok: false, attempts: 2 };
}
