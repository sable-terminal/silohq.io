/**
 * A seat, and the three things it can be.
 *
 * DERIVED, NEVER STORED. A `status` column would be a fourth source of truth
 * beside `held_by`, `reserved_for` and `retired_at`, and the first time one of
 * them is updated without the other, the column that everything reads is the one
 * that is wrong.
 */

export interface Seat {
  id: string;
  organisationId: string;
  heldBy: string | null;
  heldSince: Date | null;
  reservedFor: string | null;
  reservedAt: Date | null;
  allocatedBy: string | null;
  retiredAt: Date | null;
  createdAt: Date;
}

export type SeatState = 'free' | 'reserved' | 'held' | 'retired';

export function stateOf(seat: Seat): SeatState {
  if (seat.retiredAt) return 'retired';
  if (seat.heldBy) return 'held';
  if (seat.reservedFor) return 'reserved';
  return 'free';
}

export interface SeatCounts {
  /** Licences the organisation is paying for. Excludes retired. */
  total: number;
  held: number;
  reserved: number;
  free: number;
}

export function countSeats(seats: readonly Seat[]): SeatCounts {
  const live = seats.filter((seat) => !seat.retiredAt);
  const held = live.filter((seat) => seat.heldBy !== null).length;
  const reserved = live.filter((seat) => seat.reservedFor !== null).length;

  return {
    total: live.length,
    held,
    reserved,
    /*
     * FREE IS WHAT IS LEFT, NOT WHAT IS UNOCCUPIED. A reserved seat has an
     * invitation waiting on it and is not available to a second invitation —
     * counting it as free is how the last licence gets promised to two people.
     */
    free: live.length - held - reserved,
  };
}
