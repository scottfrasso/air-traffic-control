import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep, type WorkflowStepConfig } from "cloudflare:workers";
import { repoRef } from "../artifacts";
import { ManagedAgentsClient, type AgentClient, type Role } from "./agents/client";
import { runReview, type CiResult, type ReviewDeps } from "./orchestrate";
import { buildSnapshot } from "./snapshot";
import type { RepoStore, ReviewRunParams } from "./store";

/** The bindings and settings a review run uses (the generated Env has more). */
export interface ReviewEnv {
  REPOS: DurableObjectNamespace<RepoStore>;
  CHECKER: Env["CHECKER"];
  ARTIFACTS: Env["ARTIFACTS"];
  /** Secret. Without it (or the two below) agents can't run: the review is "incomplete" and needs a human. */
  ANTHROPIC_API_KEY?: string;
  /** JSON {classifier, correctness, security, tests, verifier} → Managed Agent ids, from `pnpm setup:agents`. */
  AGENT_IDS?: string;
  AGENT_ENVIRONMENT_ID?: string;
}

/** Sessions can't start: the pipeline still runs CI and records every agent step as errored, with this reason. */
class UnconfiguredAgents implements AgentClient {
  private readonly why = "agents not configured: set ANTHROPIC_API_KEY, AGENT_IDS and AGENT_ENVIRONMENT_ID (pnpm setup:agents)";
  async upload(): Promise<string> {
    return "unconfigured";
  }
  async start(): Promise<string> {
    throw new Error(this.why);
  }
  async poll(_id: string, _output: string) {
    return { status: "errored" as const, outputs: {}, error: this.why };
  }
  async interrupt(): Promise<void> {}
}

export function agentsFor(env: Pick<ReviewEnv, "ANTHROPIC_API_KEY" | "AGENT_IDS" | "AGENT_ENVIRONMENT_ID">): AgentClient {
  if (!env.ANTHROPIC_API_KEY || !env.AGENT_IDS || !env.AGENT_ENVIRONMENT_ID) return new UnconfiguredAgents();
  return new ManagedAgentsClient({ apiKey: env.ANTHROPIC_API_KEY, agentIds: JSON.parse(env.AGENT_IDS) as Record<Role, string>, environmentId: env.AGENT_ENVIRONMENT_ID });
}

const QUICK: WorkflowStepConfig = { retries: { limit: 3, delay: "5 seconds", backoff: "exponential" }, timeout: "10 minutes" };
/** CI runs the repo's own commands: up to an hour (checker.ts runTimeoutSeconds), so its step allows a bit more. */
const CI: WorkflowStepConfig = { retries: { limit: 1, delay: "30 seconds", backoff: "constant" }, timeout: "65 minutes" };

/** Starting a session is a POST that isn't idempotent: a retry after a lost response would start a second one. */
const START: WorkflowStepConfig = { retries: { limit: 0, delay: "1 second", backoff: "constant" }, timeout: "2 minutes" };

export function stepConfig(name: string): WorkflowStepConfig {
  return name === "ci" ? CI : name.endsWith(": start") ? START : QUICK;
}

/** The real dependencies of one run: durable steps, the RepoStore, the checker container, Managed Agents. */
export function reviewDeps(env: ReviewEnv, step: WorkflowStep, params: ReviewRunParams): ReviewDeps {
  const store = env.REPOS.getByName(params.repo);
  const checker = env.CHECKER.getByName(`review-${params.repo}`);
  const agents = agentsFor(env);
  // Read-only and short-lived, minted inside the step that uses it, so it never lands in Workflow state.
  const readRef = () => repoRef(env as unknown as Env, params.repo, "read", 3900);
  return {
    store,
    agents,
    snapshot: async (pr, sha, since) => buildSnapshot({ run: (input) => checker.run(input as never), ref: await readRef(), agents, pr, sha, since }),
    ci: async (pr, commands, sha) => {
      const out = JSON.parse(await checker.run({ mode: "ci", repo: await readRef(), branch: pr.source, sha, commands })) as { error?: string; checks?: CiResult[] };
      if (out.error) throw new Error(`CI couldn't run: ${out.error}`);
      return out.checks ?? [];
    },
    step: <T>(name: string, fn: () => Promise<T>) => step.do(name, stepConfig(name), fn as never) as Promise<T>,
    sleep: (name, ms) => step.sleep(name, ms),
  };
}

/** One review run per (PR, head commit), started by RepoStore when a PR is marked ready or a ready PR is pushed to. */
export class ReviewRun extends WorkflowEntrypoint<ReviewEnv, ReviewRunParams> {
  override async run(event: WorkflowEvent<ReviewRunParams>, step: WorkflowStep) {
    return runReview(reviewDeps(this.env, step, event.payload), event.payload);
  }
}
