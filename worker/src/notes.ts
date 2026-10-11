/**
 * The background writer for flight-log git notes (ADR-0019), kept free of Durable Object state so it can be tested.
 */

/** One checker call carries its input in a single env var (128 KiB cap): stay well under it. */
export const NOTES_BATCH = { count: 10, bytes: 48 * 1024 };

/** The oldest pending notes that fit one checker call. Always at least one, so a big note can't stall the queue. */
export function takeBatch<T extends { note: string }>(pending: T[], max = NOTES_BATCH): T[] {
  const out: T[] = [];
  let bytes = 0;
  for (const p of pending) {
    const size = new TextEncoder().encode(p.note).length;
    if (out.length && (out.length >= max.count || bytes + size > max.bytes)) break;
    out.push(p);
    bytes += size;
  }
  return out;
}

/**
 * One writer at a time: a call while it runs makes it go round again (a landing during a write). `attempt` returns
 * true when nothing is left pending; a failed attempt backs off (base, 2×, 4×…) and gives up after `tries`, leaving
 * the rest to the reconcile alarm. Never throws.
 */
export class NoteWriter {
  private running: Promise<void> | null = null;
  private again = false;

  constructor(
    private readonly attempt: () => Promise<boolean>,
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
    private readonly tries = 4,
    private readonly baseMs = 2000,
  ) {}

  run(): Promise<void> {
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = (async () => {
      try {
        for (let i = 0; i < this.tries; i++) {
          this.again = false;
          const ok = await this.attempt().catch(() => false);
          if (ok && !this.again) return;
          if (!ok) await this.sleep(this.baseMs * 2 ** i);
        }
      } finally {
        this.running = null;
      }
    })();
    return this.running;
  }
}
