import type { Executor } from '../infra/db.infra';
import { generateId } from '../utils/tokens.util';
import type { Grouping, Omission, Ranked, StoredRanking } from '../models/ranking.model';

/**
 * Rankings, kept because §5.2 promises a challenge is answered with the
 * computation rather than an assertion.
 *
 * THE ROW IS THE ANSWER, NOT A CACHE OF IT. Re-running would answer a different
 * question: the findings will have moved and the model may have changed version
 * underneath the deployment. So there is a read here and no recompute.
 *
 * THE THREE JSONB COLUMNS HOLD REFERENCES AND COMMENTARY. Finding ids with a
 * rank and a rationale, ids that share a factor, ids that were left out and why
 * — there is nothing in this file that could map a figure into one, because the
 * model was never sent one.
 */

const COLUMNS = `id, model_version, ordered_findings, groupings, omissions, created_at`;

interface Row {
  id: string;
  model_version: string;
  ordered_findings: Ranked[] | null;
  groupings: Grouping[] | null;
  omissions: Omission[] | null;
  created_at: Date;
}

function map(row: Row): StoredRanking {
  return {
    id: row.id,
    modelVersion: row.model_version,
    /* The columns are NOT NULL with a `[]` default, but a ranking read back
       through a migration that predates one of them would arrive as null. */
    ordered: row.ordered_findings ?? [],
    groupings: row.groupings ?? [],
    omitted: row.omissions ?? [],
    createdAt: row.created_at,
  };
}

export async function read(db: Executor, rankingId: string): Promise<StoredRanking | null> {
  const { rows } = await db.query<Row>(
    `SELECT ${COLUMNS} FROM rankings WHERE id = $1`,
    [rankingId],
  );

  const row = rows[0];
  return row ? map(row) : null;
}

/**
 * Keep a ranking as it was produced.
 *
 * THE TOKENS ARE RECORDED BESIDE IT RATHER THAN POINTED AT. §5.4 makes this a
 * compile-class operation, and there is no token transaction table in this repo
 * for `token_transaction_ref` to reference yet — so the usage lives in the row
 * meanwhile, and the billing link is a column waiting for the other half.
 */
export async function insert(
  db: Executor,
  input: {
    organisationId: string;
    investigationRef: string | null;
    modelVersion: string;
    ordered: Ranked[];
    groupings: Grouping[];
    omitted: Omission[];
    inputTokens: number;
    outputTokens: number;
    createdBy: string;
  },
): Promise<string> {
  const id = generateId();

  await db.query(
    `INSERT INTO rankings
       (id, organisation_id, investigation_ref, model_version,
        ordered_findings, groupings, omissions,
        input_tokens, output_tokens, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      id,
      input.organisationId,
      input.investigationRef,
      input.modelVersion,
      JSON.stringify(input.ordered),
      JSON.stringify(input.groupings),
      JSON.stringify(input.omitted),
      input.inputTokens,
      input.outputTokens,
      input.createdBy,
    ],
  );

  return id;
}
