// Pure land-time guards (no I/O), so they can be unit tested outside the container.

/**
 * Land only the exact commits ATC checked: main must still be where the coordinator saw it, and the fork
 * must still be at the head whose pair checks and typecheck cleared it. Returns a retry reason, or null to proceed.
 */
export function landGuard(baseHead: string, expectedBase: string, forkHead: string, expectedFork: string | undefined): string | null {
  if (baseHead !== expectedBase) return `main moved to ${baseHead.slice(0, 7)} while landing; retry`;
  if (expectedFork && forkHead !== expectedFork) return `fork moved to ${forkHead.slice(0, 7)} while landing (ATC checked ${expectedFork.slice(0, 7)}); retry`;
  return null;
}
