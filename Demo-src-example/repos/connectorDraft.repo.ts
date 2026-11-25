import type { Executor } from '../infra/db.infra';

/**
 * Drafts, and the vocabulary the builder's dropdowns are made of.
 *
 * NO PARSING ON THE WAY OUT, unlike `connector.repo`. That one refuses a
 * manifest it cannot parse, because executing a document it does not understand
 * is how a connector silently does something other than what its author
 * configured. A draft is unparseable by definition — half-finished is its whole
 * purpose — so it comes back as it went in and validation is something the
 * builder asks for explicitly.
 */

export interface Draft {
  id: string;
  name: string;
  document: Record<string, unknown>;
  sourceRoute: 'ai' | 'visual';
  failedStage: string | null;
  publishedManifestId: string | null;
  publishedAt: Date | null;
  createdBy: string;
  updatedAt: Date;
}

interface Row {
  id: string;
  name: string;
  document: Record<string, unknown>;
  source_route: 'ai' | 'visual';
  failed_stage: string | null;
  published_manifest_id: string | null;
  published_at: Date | null;
  created_by: string;
  updated_at: Date;
}

const toDraft = (row: Row): Draft => ({
  id: row.id,
  name: row.name,
  document: row.document,
  sourceRoute: row.source_route,
  failedStage: row.failed_stage,
  publishedManifestId: row.published_manifest_id,
  publishedAt: row.published_at,
  createdBy: row.created_by,
  updatedAt: row.updated_at,
});

const COLUMNS = `id, name, document, source_route, failed_stage,
                 published_manifest_id, published_at, created_by, updated_at`;

export async function list(db: Executor): Promise<Draft[]> {
  const { rows } = await db.query<Row>(
    `SELECT ${COLUMNS} FROM connector_drafts ORDER BY updated_at DESC LIMIT 200`,
  );
  return rows.map(toDraft);
}

export async function find(db: Executor, id: string): Promise<Draft | null> {
  const { rows } = await db.query<Row>(
    `SELECT ${COLUMNS} FROM connector_drafts WHERE id = $1`,
    [id],
  );
  return rows[0] ? toDraft(rows[0]) : null;
}

export async function insert(
  db: Executor,
  input: {
    id: string;
    organisationId: string;
    name: string;
    document: Record<string, unknown>;
    sourceRoute: 'ai' | 'visual';
    failedStage: string | null;
    createdBy: string;
  },
): Promise<Draft> {
  const { rows } = await db.query<Row>(
    `INSERT INTO connector_drafts
       (id, organisation_id, name, document, source_route, failed_stage, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING ${COLUMNS}`,
    [
      input.id,
      input.organisationId,
      input.name,
      JSON.stringify(input.document),
      input.sourceRoute,
      input.failedStage,
      input.createdBy,
    ],
  );
  return toDraft(rows[0]!);
}

export async function update(
  db: Executor,
  id: string,
  patch: { name?: string; document?: Record<string, unknown> },
): Promise<Draft | null> {
  const { rows } = await db.query<Row>(
    `UPDATE connector_drafts
        SET name = COALESCE($2, name),
            document = COALESCE($3::jsonb, document)
      WHERE id = $1
      RETURNING ${COLUMNS}`,
    [id, patch.name ?? null, patch.document ? JSON.stringify(patch.document) : null],
  );
  return rows[0] ? toDraft(rows[0]) : null;
}

export async function markPublished(
  db: Executor,
  id: string,
  manifestId: string,
): Promise<void> {
  await db.query(
    `UPDATE connector_drafts
        SET published_manifest_id = $2, published_at = now(), failed_stage = NULL
      WHERE id = $1`,
    [id, manifestId],
  );
}

export async function remove(db: Executor, id: string): Promise<boolean> {
  const { rowCount } = await db.query(`DELETE FROM connector_drafts WHERE id = $1`, [id]);
  return (rowCount ?? 0) > 0;
}

/* ── The vocabulary ─────────────────────────────────────────────────────── */

export interface Vocabulary {
  transports: { kind: string; protocol: string; description: string }[];
  authStrategies: { strategy: string; description: string }[];
  signingAlgorithms: { name: string; description: string }[];
  pushdown: { capability: string; description: string }[];
  mutations: { capability: string; description: string }[];
}

/**
 * What the builder is allowed to offer, read from the database rather than
 * listed in the client.
 *
 * THIS IS THE "CONNECTORS ARE DATA" RULE APPLIED TO THE BUILDER ITSELF. A
 * dropdown hard-coded in the frontend is a second copy of the enumeration that
 * drifts the first time somebody adds a transport, and it drifts silently —
 * the new option simply never appears and nobody can say why.
 *
 * FILTERED BY ROUTE, because not every transport is offered on every route,
 * and a transport not yet built is offered on none. The presets that write
 * paging and record expressions are code, not rows, and the service adds them.
 */
export async function vocabulary(db: Executor, route: 'ai' | 'visual'): Promise<Vocabulary> {
  const [transports, auth, signing, pushdown, mutations] = await Promise.all([
    db.query<{ kind: string; protocol: string; description: string }>(
      `SELECT kind, protocol, description FROM connector_transports
        WHERE $1 = ANY(routes) ORDER BY kind`,
      [route],
    ),
    db.query<{ strategy: string; description: string }>(
      `SELECT strategy, description FROM connector_auth_strategies
        WHERE user_selectable ORDER BY strategy`,
    ),
    db.query<{ name: string; description: string }>(`SELECT name, description FROM signing_algorithms ORDER BY name`),
    db.query<{ capability: string; description: string }>(
      `SELECT capability, description FROM pushdown_capabilities ORDER BY capability`,
    ),
    db.query<{ capability: string; description: string }>(
      `SELECT capability, description FROM mutation_capabilities ORDER BY capability`,
    ),
  ]);

  return {
    transports: transports.rows,
    authStrategies: auth.rows,
    signingAlgorithms: signing.rows,
    pushdown: pushdown.rows,
    mutations: mutations.rows,
  };
}
