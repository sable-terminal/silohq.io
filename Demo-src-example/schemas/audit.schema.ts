import { z } from 'zod';
import { uuid } from '../utils/schemas.util';

/**
 * §12 — reading the audit trail.
 *
 * ── The cursor is opaque to the client and structured to us ────────────────
 *
 * `authEvent.repo.list` pages on `(occurred_at, id)` rather than on OFFSET,
 * because this table grows without bound and `OFFSET 50000` makes Postgres walk
 * fifty thousand rows to throw them away. Both halves are needed: two events can
 * share a timestamp, and ordering on time alone makes the page boundary
 * non-deterministic, so a row is shown twice or skipped.
 *
 * A CLIENT THAT BUILT THAT PAIR ITSELF WOULD BE DECIDING THE PAGE BOUNDARY, so
 * it is handed back whole from the previous page and parsed here. The shape is
 * checked rather than trusted: a malformed cursor is a 400 and not a query that
 * pages from somewhere unexpected.
 */
const cursor = z
  .string()
  .max(128)
  .regex(
    /^\d{4}-\d{2}-\d{2}T[\d:.]+Z?_\d+$/,
    'That is not a page cursor. Use the `next` value from the previous page.',
  );

export const listAuthEvents = z
  .object({
    /*
     * A CLOSED SET, MATCHING THE `AuthEvent` UNION. An unknown event name would
     * silently match nothing and read as "that never happened", which is the
     * one answer an audit trail must never give by accident.
     */
    event: z.string().min(1).max(64).optional(),
    membershipId: uuid.optional(),
    from: z.coerce.date().optional(),
    to: z.coerce.date().optional(),
    before: cursor.optional(),
    /* Bounded here as well as in the repo: a caller asking for a million rows
       should be refused at the door rather than served a truncated answer. */
    limit: z.coerce.number().int().min(1).max(200).optional(),
  })
  .strict();
