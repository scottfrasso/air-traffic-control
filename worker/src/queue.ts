import { baselineOf } from "./artifacts";
import { isPushed, type ArtifactsEvent } from "./events";

/** The part of a Queues message the consumer uses. */
export type QueueMessage<T> = { id: string; body: T; attempts: number; ack(): void; retry(options?: { delaySeconds?: number }): void };

/** Back-off for a failed message: 5, 10, 20 s, then 40 s on the last delivery, and then the DLQ (max_retries: 3). */
export const retryDelaySeconds = (attempts: number) => Math.min(60, 5 * 2 ** Math.max(0, attempts - 1));

/**
 * Handle each message on its own (issue #7): ack it on success, retry it with a back-off on failure. One bad message
 * no longer aborts the loop, and the ones that already succeeded aren't redelivered. Messages that keep failing go to
 * the dead-letter queue (agentmesh-push-events-dlq) after max_retries. Retries are safe: onPush de-duplicates by sha.
 */
export async function consumeBatch<T>(messages: readonly QueueMessage<T>[], handle: (body: T) => Promise<void>, log: (msg: string) => void = console.error) {
  for (const msg of messages) {
    try {
      await handle(msg.body);
      msg.ack();
    } catch (err) {
      const delaySeconds = retryDelaySeconds(msg.attempts);
      log(`queue message ${msg.id} failed (attempt ${msg.attempts}), retrying in ${delaySeconds}s: ${err instanceof Error ? err.message : String(err)}`);
      msg.retry({ delaySeconds });
    }
  }
}

/** An Artifacts event → the Coordinator of the repo's baseline. Only pushes to main matter (ADR-0002). */
export async function routePushEvent(env: Env, event: ArtifactsEvent): Promise<void> {
  if (!isPushed(event) || event.payload.ref !== "refs/heads/main") return;
  const repo = event.source.repoName;
  const stub = env.COORDINATOR.getByName(baselineOf(repo));
  await stub.ensure(baselineOf(repo));
  await stub.onPush(repo, event.payload.after, "event", event);
}
