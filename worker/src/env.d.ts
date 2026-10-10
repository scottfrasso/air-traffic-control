// Secrets are not in wrangler.jsonc, so `wrangler types` can't see them. Declared here
// on both the global `Env` and `Cloudflare.Env` (which the generated types keep separate).
interface AgentmeshSecrets {
  /** Shared bearer key for /api, /mcp and the dashboard. Set with `wrangler secret put AGENTMESH_API_KEY`. */
  AGENTMESH_API_KEY: string;
}
interface Env extends AgentmeshSecrets {}
declare namespace Cloudflare {
  interface Env extends AgentmeshSecrets {}
}
