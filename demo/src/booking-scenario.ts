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
      "export function createBooking(guest: Guest, room: string, nights: number): Booking {\n  return { guest, room, nights };",
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
