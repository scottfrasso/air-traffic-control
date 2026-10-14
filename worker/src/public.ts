/**
 * Key-less read-only replay (issue #14, ADR-0020): `GET /api/repos/<baseline>/timeline` for allow-listed baselines
 * only. Everything else still needs the API key, so nothing reachable without it can fork, push, land or open a socket.
 */
export function publicReplayBaseline(method: string, pathname: string, allowList: string | undefined): string | null {
  if (method !== "GET" && method !== "HEAD") return null;
  const m = /^\/api\/repos\/([A-Za-z0-9][A-Za-z0-9._-]{0,62})\/timeline$/.exec(pathname);
  if (!m?.[1]) return null;
  const allowed = (allowList ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  return allowed.includes(m[1]) ? m[1] : null;
}
