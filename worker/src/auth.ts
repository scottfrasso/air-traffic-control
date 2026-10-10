const encoder = new TextEncoder();

/** Constant-time check of `Authorization: Bearer <key>` (or `?key=` for the dashboard's WebSocket/EventSource). */
export function isAuthorized(request: Request, env: Env): boolean {
  const header = request.headers.get("authorization") ?? "";
  const presented = header.startsWith("Bearer ") ? header.slice(7) : (new URL(request.url).searchParams.get("key") ?? "");
  const expected = env.AGENTMESH_API_KEY;
  if (!expected || !presented) return false;
  const a = encoder.encode(presented);
  const b = encoder.encode(expected);
  return a.byteLength === b.byteLength && crypto.subtle.timingSafeEqual(a, b);
}

export function unauthorized(): Response {
  return Response.json({ error: "missing or invalid API key" }, { status: 401, headers: { "WWW-Authenticate": "Bearer" } });
}
