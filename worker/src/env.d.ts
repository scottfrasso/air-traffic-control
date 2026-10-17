// Secrets are not in wrangler.jsonc, so `wrangler types` can't see them. Declared here
// on both the global `Env` and `Cloudflare.Env` (which the generated types keep separate).
interface AgentmeshSecrets {
  /** Cloudflare API token used only to create per-repo push subscriptions (ADR-0002). */
  CF_API_TOKEN: string;
  /** Claude Managed Agents (review pipeline). Optional: without it every agent step is errored and a human must approve. */
  ANTHROPIC_API_KEY?: string;
}
interface Env extends AgentmeshSecrets {}
declare namespace Cloudflare {
  interface Env extends AgentmeshSecrets {}
}
