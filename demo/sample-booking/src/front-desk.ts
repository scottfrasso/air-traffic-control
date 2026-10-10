import { createBooking, type Booking, type Guest } from "./booking";

export function checkIn(guest: Guest, room: string): Booking {
  return createBooking(guest, room);
}
