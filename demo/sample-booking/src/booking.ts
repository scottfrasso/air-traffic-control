export interface Guest {
  name: string;
  email: string;
}

export interface Booking {
  guest: Guest;
  room: string;
  nights: number;
}

export function createBooking(guest: Guest, room: string): Booking {
  return { guest, room, nights: 1 };
}
