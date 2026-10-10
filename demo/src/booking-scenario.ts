/**
 * The edits for the video's recorded run, on demo/sample-booking:
 *   A: adds a `nights` parameter to createBooking(guest, room) and updates its caller in front-desk.ts.
 *   B: adds a NEW caller of createBooking in a new file, src/walk-in.ts, the old way.
 * Each fork typechecks alone and plain git merges them cleanly, but the merge doesn't typecheck.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function agentAAddNights(dir: string) {
  const booking = join(dir, "src/booking.ts");
  writeFileSync(
    booking,
    readFileSync(booking, "utf8").replace(
      "export function createBooking(guest: Guest, room: string): Booking {\n  return { guest, room, nights: 1 };",
      "/** Book `room` for `guest` for `nights` nights (at least one). */\nexport function createBooking(guest: Guest, room: string, nights: number): Booking {\n  if (!Number.isInteger(nights) || nights < 1) throw new Error(`nights must be a positive integer, got ${nights}`);\n  return { guest, room, nights };",
    ),
  );
  const desk = join(dir, "src/front-desk.ts");
  writeFileSync(
    desk,
    readFileSync(desk, "utf8")
      .replace("checkIn(guest: Guest, room: string)", "checkIn(guest: Guest, room: string, nights: number)")
      .replace("createBooking(guest, room)", "createBooking(guest, room, nights)"),
  );
}

export function agentBAddWalkIn(dir: string) {
  writeFileSync(
    join(dir, "src/walk-in.ts"),
    `import { createBooking, type Booking, type Guest } from "./booking";

/** Walk-in guests get whatever room is free tonight. */
export function walkIn(guest: Guest, freeRoom: string): Booking {
  return createBooking(guest, freeRoom);
}
`,
  );
}

export function agentBFixWalkIn(dir: string) {
  const file = join(dir, "src/walk-in.ts");
  writeFileSync(file, readFileSync(file, "utf8").replace("createBooking(guest, freeRoom)", "createBooking(guest, freeRoom, 1)"));
}

/** PR1's agent, told to hold behind PR2: pull in PR2's new caller and update it to the new parameters. */
export function agentAFixWalkIn(dir: string) {
  agentBFixWalkIn(dir);
}

// ── background traffic: independent PRs that don't conflict with anything ──

export const BOOKING_TRAFFIC = [
  {
    agent: "c",
    title: "Add booking cancellation",
    apply: (dir: string) =>
      writeFileSync(
        join(dir, "src/cancel.ts"),
        `import type { Booking } from "./booking";

export interface Cancellation {
  booking: Booking;
  reason: string;
}

export function cancelBooking(booking: Booking, reason: string): Cancellation {
  return { booking, reason };
}
`,
      ),
  },
  {
    agent: "d",
    title: "Document check-in",
    apply: (dir: string) => {
      const file = join(dir, "README.md");
      writeFileSync(file, `${readFileSync(file, "utf8")}\n## Check-in\n\nThe front desk calls \`checkIn\` with the guest and room.\n`);
    },
  },
  {
    agent: "e",
    title: "Add nightly rates",
    apply: (dir: string) =>
      writeFileSync(
        join(dir, "src/rates.ts"),
        `/** Nightly room rate in cents, with a weekend surcharge. */
export function nightlyRate(base: number, weekend: boolean): number {
  return weekend ? Math.round(base * 1.2) : base;
}
`,
      ),
  },
];
