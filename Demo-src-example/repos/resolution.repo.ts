import type { Executor } from '../infra/db.infra';
import { generateId } from '../utils/tokens.util';
import {
  canonical,
  type ConfirmedResolution,
  type ProposedBy,
  type UnresolvedPair,
} from '../models/resolution.model';

/**
 * §2.6 — unresolved pairs and the mappings they become.
 *
 * EVERY WRITE GOES THROUGH `canonical`. Both tables carry a CHECK that the
 * connections are ordered, so an uncanonicalised write does not silently
 * produce a mirrored duplicate — it fails. Reads canonicalise for the same
 * reason: a lookup for (B, refB, A, refA) must find the row stored as
 * (A, refA, B, refB).
 */

const PAIR_COLUMNS = `
  id, organisation_id, concept_id, connection_a, value_ref_a, connection_b, value_ref_b,
  proposed_by, model_rationale, confirmed_by, confirmed_at, rejected_at, proposed_at
`;

interface PairRow {
  id: string;
  organisation_id: string;
  concept_id: string;
  connection_a: string;
  value_ref_a: string;
  connection_b: string;
  value_ref_b: string;
  proposed_by: ProposedBy;
  model_rationale: string | null;
  confirmed_by: string | null;
  confirmed_at: Date | null;
  rejected_at: Date | null;
  proposed_at: Date;
}

function mapPair(row: PairRow): UnresolvedPair {
  return {
    id: row.id,
    organisationId: row.organisation_id,
    conceptId: row.concept_id,
    connectionA: row.connection_a,
    valueRefA: row.value_ref_a,
    connectionB: row.connection_b,
    valueRefB: row.value_ref_b,
    proposedBy: row.proposed_by,
    modelRationale: row.model_rationale,
    confirmedBy: row.confirmed_by,
    confirmedAt: row.confirmed_at,
    rejectedAt: row.rejected_at,
    proposedAt: row.proposed_at,
  };
}

/* ── Questions ───────────────────────────────────────────────────────────── */

/**
 * Record a pair the matcher could not match.
 *
 * `DO NOTHING` ON CONFLICT, because asking the same question twice makes the
 * queue grow every time anybody runs a detector.
 */
export async function recordPair(
  db: Executor,
  input: {
    organisationId: string;
    conceptId: string;
    connectionA: string;
    valueRefA: string;
    connectionB: string;
    valueRefB: string;
    proposedBy?: ProposedBy;
    modelRationale?: string | null;
  },
): Promise<void> {
  const pair = canonical(input);

  await db.query(
    `INSERT INTO unresolved_pairs
       (id, organisation_id, concept_id, connection_a, value_ref_a,
        connection_b, value_ref_b, proposed_by, model_rationale)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (concept_id, connection_a, value_ref_a, connection_b, value_ref_b)
     DO NOTHING`,
    [
      generateId(),
      pair.organisationId,
      pair.conceptId,
      pair.connectionA,
      pair.valueRefA,
      pair.connectionB,
      pair.valueRefB,
      input.proposedBy ?? 'resolver',
      input.modelRationale ?? null,
    ],
  );
}

export async function readPair(db: Executor, id: string): Promise<UnresolvedPair | null> {
  const { rows } = await db.query<PairRow>(
    `SELECT ${PAIR_COLUMNS} FROM unresolved_pairs WHERE id = $1`,
    [id],
  );
  const row = rows[0];
  return row ? mapPair(row) : null;
}

/** Undecided questions, newest concept activity first. */
export async function openPairs(
  db: Executor,
  options: { conceptId?: string; limit?: number } = {},
): Promise<UnresolvedPair[]> {
  const { rows } = await db.query<PairRow>(
    `SELECT ${PAIR_COLUMNS} FROM unresolved_pairs
      WHERE confirmed_at IS NULL AND rejected_at IS NULL
        AND ($1::uuid IS NULL OR concept_id = $1)
      ORDER BY proposed_at DESC
      LIMIT $2`,
    [options.conceptId ?? null, options.limit ?? 200],
  );

  return rows.map(mapPair);
}

/**
 * Attach a model's suggestion to an open question.
 *
 * IT WRITES A PROPOSAL, NOT A DECISION. `confirmed_at` is untouched — the model
 * fills the other half of the pair in and says why, and a person still has to
 * agree. §2.6 is explicit that this is where inference stops.
 */
export async function attachProposal(
  db: Executor,
  input: { id: string; valueRefB: string; rationale: string },
): Promise<boolean> {
  const pair = await readPair(db, input.id);
  if (!pair || pair.confirmedAt || pair.rejectedAt) return false;

  /*
   * ── Naming the second side makes the pair canonical, so it must be made so ──
   *
   * 041 applies the canonical ordering CHECK only once BOTH sides are named: a
   * one-sided question is directional on purpose — side A holds the row, side B
   * is where it is missing — and ordering it would swap the known reference
   * into the empty column.
   *
   * Which means filling B in is the moment the constraint starts applying. A
   * question recorded with connection_a > connection_b was legal while B was
   * empty and violates the CHECK the instant a proposal lands, so this rewrites
   * all four columns rather than just the one.
   */
  const ordered = canonical({ ...pair, valueRefB: input.valueRefB });

  const { rowCount } = await db.query(
    `UPDATE unresolved_pairs
        SET connection_a = $2, value_ref_a = $3,
            connection_b = $4, value_ref_b = $5,
            model_rationale = $6, proposed_by = 'model'
      WHERE id = $1 AND confirmed_at IS NULL AND rejected_at IS NULL`,
    [
      input.id,
      ordered.connectionA,
      ordered.valueRefA,
      ordered.connectionB,
      ordered.valueRefB,
      input.rationale,
    ],
  );

  return Boolean(rowCount);
}

export async function markConfirmed(
  db: Executor,
  input: { id: string; by: string },
): Promise<boolean> {
  const { rowCount } = await db.query(
    `UPDATE unresolved_pairs
        SET confirmed_by = $2, confirmed_at = now()
      WHERE id = $1 AND confirmed_at IS NULL AND rejected_at IS NULL`,
    [input.id, input.by],
  );
  return Boolean(rowCount);
}

export async function markRejected(db: Executor, id: string): Promise<boolean> {
  const { rowCount } = await db.query(
    `UPDATE unresolved_pairs
        SET rejected_at = now()
      WHERE id = $1 AND confirmed_at IS NULL AND rejected_at IS NULL`,
    [id],
  );
  return Boolean(rowCount);
}

/* ── Answers ─────────────────────────────────────────────────────────────── */

const RESOLUTION_COLUMNS = `
  id, organisation_id, concept_id, connection_a, value_ref_a,
  connection_b, value_ref_b, pair_id, confirmed_by, confirmed_at
`;

interface ResolutionRow {
  id: string;
  organisation_id: string;
  concept_id: string;
  connection_a: string;
  value_ref_a: string;
  connection_b: string;
  value_ref_b: string;
  pair_id: string | null;
  confirmed_by: string;
  confirmed_at: Date;
}

function mapResolution(row: ResolutionRow): ConfirmedResolution {
  return {
    id: row.id,
    organisationId: row.organisation_id,
    conceptId: row.concept_id,
    connectionA: row.connection_a,
    valueRefA: row.value_ref_a,
    connectionB: row.connection_b,
    valueRefB: row.value_ref_b,
    pairId: row.pair_id,
    confirmedBy: row.confirmed_by,
    confirmedAt: row.confirmed_at,
  };
}

/**
 * The exact mappings for a concept.
 *
 * THE HOT PATH. Every resolution of this concept reads this, so it is one
 * indexed scan by concept and nothing more — no join, no filter over decided
 * and rejected proposals, which is why these live in their own table rather
 * than as a view over `unresolved_pairs`.
 */
export async function confirmedFor(
  db: Executor,
  conceptId: string,
): Promise<ConfirmedResolution[]> {
  const { rows } = await db.query<ResolutionRow>(
    `SELECT ${RESOLUTION_COLUMNS} FROM confirmed_resolutions
      WHERE concept_id = $1
      ORDER BY connection_a, value_ref_a`,
    [conceptId],
  );

  return rows.map(mapResolution);
}

export async function confirmResolution(
  db: Executor,
  input: {
    organisationId: string;
    conceptId: string;
    connectionA: string;
    valueRefA: string;
    connectionB: string;
    valueRefB: string;
    pairId: string | null;
    confirmedBy: string;
  },
): Promise<string> {
  const pair = canonical(input);
  const id = generateId();

  await db.query(
    `INSERT INTO confirmed_resolutions
       (id, organisation_id, concept_id, connection_a, value_ref_a,
        connection_b, value_ref_b, pair_id, confirmed_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (concept_id, connection_a, value_ref_a, connection_b, value_ref_b)
     DO NOTHING`,
    [
      id,
      pair.organisationId,
      pair.conceptId,
      pair.connectionA,
      pair.valueRefA,
      pair.connectionB,
      pair.valueRefB,
      input.pairId,
      input.confirmedBy,
    ],
  );

  return id;
}
