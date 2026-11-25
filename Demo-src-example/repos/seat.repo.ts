import type { Executor } from '../infra/db.infra';
import type { Seat } from '../models/seat.model';
import { generateId } from '../utils/tokens.util';

/**
 * Seats.
 *
 * THE CLAIM STATEMENTS ARE THE POINT OF THIS FILE. Every one of them finds a
 * free seat and takes it in a single UPDATE with the freeness in its own WHERE.
 * Read-then-write is how two administrators inviting simultaneously both see one
 * seat left and both proceed — and the row that results seats two people on one
 * licence, which the unique indexes then refuse at whichever write lands second,
 * with an error about a constraint rather than about capacity.
 */

const COLUMNS = `
  id, organisation_id, held_by, held_since, reserved_for, reserved_at,
  allocated_by, retired_at, created_at
`;

interface Row {
  id: string;
  organisation_id: string;
  held_by: string | null;
  held_since: Date | null;
  reserved_for: string | null;
  reserved_at: Date | null;
  allocated_by: string | null;
  retired_at: Date | null;
  created_at: Date;
}

function map(row: Row): Seat {
  return {
    id: row.id,
    organisationId: row.organisation_id,
    heldBy: row.held_by,
    heldSince: row.held_since,
    reservedFor: row.reserved_for,
    reservedAt: row.reserved_at,
    allocatedBy: row.allocated_by,
    retiredAt: row.retired_at,
    createdAt: row.created_at,
  };
}

export async function list(db: Executor): Promise<Seat[]> {
  const { rows } = await db.query<Row>(
    `SELECT ${COLUMNS} FROM seats ORDER BY created_at`,
  );
  return rows.map(map);
}

/** Add licences to the pool. Returns the seats created. */
export async function provision(
  db: Executor,
  input: { organisationId: string; count: number; by: string | null },
): Promise<Seat[]> {
  const ids = Array.from({ length: input.count }, () => generateId());
  const { rows } = await db.query<Row>(
    `INSERT INTO seats (id, organisation_id, allocated_by)
     SELECT unnest($1::uuid[]), $2, $3
     RETURNING ${COLUMNS}`,
    [ids, input.organisationId, input.by],
  );
  return rows.map(map);
}

/**
 * Reserve one free seat for an invitation.
 *
 * `LIMIT 1` INSIDE A SUBQUERY WITH `FOR UPDATE SKIP LOCKED`. Two concurrent
 * reservations must not both pick the same row and must not both wait on it —
 * skipping the locked one lets the second take a different free seat, which is
 * the behaviour that matches what a person expects when there are two left.
 *
 * Returns null when nothing was free, which the caller turns into a refusal
 * naming capacity rather than a constraint violation.
 */
export async function reserve(
  db: Executor,
  input: { invitationId: string; by: string },
): Promise<Seat | null> {
  const { rows } = await db.query<Row>(
    `UPDATE seats SET reserved_for = $1, reserved_at = now(), allocated_by = $2
      WHERE id = (
        SELECT id FROM seats
         WHERE retired_at IS NULL AND held_by IS NULL AND reserved_for IS NULL
         ORDER BY created_at
         LIMIT 1
         FOR UPDATE SKIP LOCKED
      )
      RETURNING ${COLUMNS}`,
    [input.invitationId, input.by],
  );
  return rows[0] ? map(rows[0]) : null;
}

/** Turn an invitation's reservation into an occupied seat. */
export async function claimReserved(
  db: Executor,
  input: { invitationId: string; membershipId: string },
): Promise<Seat | null> {
  const { rows } = await db.query<Row>(
    `UPDATE seats
        SET held_by = $2, held_since = now(), reserved_for = NULL, reserved_at = NULL
      WHERE reserved_for = $1
      RETURNING ${COLUMNS}`,
    [input.invitationId, input.membershipId],
  );
  return rows[0] ? map(rows[0]) : null;
}

/** Give a membership a free seat directly, with no invitation involved. */
export async function allocate(
  db: Executor,
  input: { membershipId: string; by: string },
): Promise<Seat | null> {
  const { rows } = await db.query<Row>(
    `UPDATE seats SET held_by = $1, held_since = now(), allocated_by = $2
      WHERE id = (
        SELECT id FROM seats
         WHERE retired_at IS NULL AND held_by IS NULL AND reserved_for IS NULL
         ORDER BY created_at
         LIMIT 1
         FOR UPDATE SKIP LOCKED
      )
      RETURNING ${COLUMNS}`,
    [input.membershipId, input.by],
  );
  return rows[0] ? map(rows[0]) : null;
}

/** Let go of a reservation: the invitation was revoked or ran out. */
export async function releaseReservation(db: Executor, invitationId: string): Promise<void> {
  await db.query(
    `UPDATE seats SET reserved_for = NULL, reserved_at = NULL WHERE reserved_for = $1`,
    [invitationId],
  );
}

/**
 * Take a seat back from a membership.
 *
 * DELIBERATE AND SEPARATE FROM OFFBOARDING. Removing somebody leaves their seat
 * held, so capacity does not silently shrink at the moment an organisation is
 * most likely to be about to refill it. This is the second action that says
 * "and we want the licence back".
 */
export async function reclaim(db: Executor, seatId: string): Promise<Seat | null> {
  const { rows } = await db.query<Row>(
    `UPDATE seats SET held_by = NULL, held_since = NULL
      WHERE id = $1 AND retired_at IS NULL
      RETURNING ${COLUMNS}`,
    [seatId],
  );
  return rows[0] ? map(rows[0]) : null;
}

/** Whether this membership holds a licence now. An allowance is per seat. */
export async function heldBy(db: Executor, membershipId: string): Promise<boolean> {
  const { rows } = await db.query<{ held: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM seats WHERE held_by = $1 AND retired_at IS NULL
     ) AS held`,
    [membershipId],
  );
  return rows[0]?.held ?? false;
}

/**
 * Give up one free licence, whichever is free.
 *
 * FOR A COUNT RATHER THAN A SEAT. §3's release reduces the licence count; which
 * of the unheld seats goes is not a decision anybody has an opinion about, and
 * the `WHERE` still refuses to take one somebody is sitting in.
 */
export async function retireFree(
  db: Executor,
  input: { organisationId: string; by: string },
): Promise<Seat | null> {
  const { rows } = await db.query<Row>(
    `UPDATE seats SET retired_at = now(), retired_by = $2
      WHERE id = (
        SELECT id FROM seats
         WHERE organisation_id = $1 AND retired_at IS NULL AND held_by IS NULL AND reserved_for IS NULL
         ORDER BY created_at DESC
         LIMIT 1
         FOR UPDATE SKIP LOCKED
      )
      RETURNING ${COLUMNS}`,
    [input.organisationId, input.by],
  );
  return rows[0] ? map(rows[0]) : null;
}

/**
 * Give up a licence entirely.
 *
 * THE `WHERE` REFUSES AN OCCUPIED SEAT rather than emptying it first. Retiring a
 * seat somebody is sitting in is a billing change that silently removes their
 * access; making it fail forces the two decisions to be taken separately, which
 * is what they are.
 */
export async function retire(
  db: Executor,
  input: { seatId: string; by: string },
): Promise<Seat | null> {
  const { rows } = await db.query<Row>(
    `UPDATE seats SET retired_at = now(), retired_by = $2
      WHERE id = $1 AND retired_at IS NULL AND held_by IS NULL AND reserved_for IS NULL
      RETURNING ${COLUMNS}`,
    [input.seatId, input.by],
  );
  return rows[0] ? map(rows[0]) : null;
}
