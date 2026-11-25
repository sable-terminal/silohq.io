import type { Executor } from '../infra/db.infra';
import type {
  DiscoveryFinding,
  DiscoverySettings,
  FindingDecision,
  RunSummary,
  ScanAuthorisation,
  ScanMethod,
} from '../models/discovery.model';
import { generateId } from '../utils/tokens.util';

/**
 * §9 — discovery settings, scan authorisations, runs and findings.
 *
 * THE TWO TRIGGERS IN 019 ARE THE ENFORCEMENT, AND NOTHING HERE DUPLICATES
 * THEM. An authorisation cannot be inserted while discovery is off, and a run
 * cannot start under an authorisation that has expired or been revoked —
 * database-side, so the rule holds for any path that ever inserts a row,
 * including one written later by somebody who did not read this file. They
 * surface as errors, which is information: the service turns them into refusals
 * naming the switch or the window.
 *
 * NO STRUCTURE IS FILTERED ON THE WAY IN. `structureOnly` strips anything that
 * is not shape and it stays in the service, because it is a rule about what
 * Silo agrees to store rather than a fact about the column — a second caller
 * inserting a finding must be made to apply it too, and would not be if this
 * file did it quietly on their behalf.
 */

/* ── 9.1 Settings ───────────────────────────────────────────────────────── */

const SETTINGS_COLUMNS = `
  organisation_id, enabled, enabled_by, enabled_at, disabled_by, disabled_at
`;

interface SettingsRow {
  organisation_id: string;
  enabled: boolean;
  enabled_by: string | null;
  enabled_at: Date | null;
  disabled_by: string | null;
  disabled_at: Date | null;
}

function mapSettings(row: SettingsRow): DiscoverySettings {
  return {
    organisationId: row.organisation_id,
    enabled: row.enabled,
    enabledBy: row.enabled_by,
    enabledAt: row.enabled_at,
    disabledBy: row.disabled_by,
    disabledAt: row.disabled_at,
  };
}

/**
 * Turn discovery on or off for an organisation.
 *
 * THE ROW IS CREATED BY THE FIRST DECISION, not by the organisation existing:
 * off is the absence of a row, so there is nothing to read that could disagree
 * with the switch before anybody has touched it.
 *
 * THE `CASE` EXPRESSIONS KEEP BOTH ATTRIBUTIONS. Turning it off must not erase
 * who turned it on, and turning it on must clear the disabling — otherwise the
 * row reads as enabled and disabled at once, which the two pairs of columns
 * exist precisely to tell apart.
 */
export async function saveEnabled(
  db: Executor,
  input: { organisationId: string; enabled: boolean; by: string },
): Promise<DiscoverySettings> {
  const { rows } = await db.query<SettingsRow>(
    `INSERT INTO discovery_settings (organisation_id, enabled, enabled_by, enabled_at)
     VALUES ($1, $2, $3, CASE WHEN $2 THEN now() END)
     ON CONFLICT (organisation_id) DO UPDATE
       SET enabled = EXCLUDED.enabled,
           enabled_by = CASE WHEN $2 THEN $3 ELSE discovery_settings.enabled_by END,
           enabled_at = CASE WHEN $2 THEN now() ELSE discovery_settings.enabled_at END,
           disabled_by = CASE WHEN $2 THEN NULL ELSE $3::uuid END,
           disabled_at = CASE WHEN $2 THEN NULL ELSE now() END
     RETURNING ${SETTINGS_COLUMNS}`,
    [input.organisationId, input.enabled, input.by],
  );
  return mapSettings(rows[0]!);
}

/* ── 9.2 Authorisations ─────────────────────────────────────────────────── */

const AUTHORISATION_COLUMNS = `
  id, organisation_id, agent_id, ranges, methods, authorised_by, authorised_at,
  approval_id, expires_at, revoked_by, revoked_at
`;

interface AuthorisationRow {
  id: string;
  organisation_id: string;
  agent_id: string;
  ranges: string[];
  methods: ScanMethod[];
  authorised_by: string;
  authorised_at: Date;
  approval_id: string | null;
  expires_at: Date;
  revoked_by: string | null;
  revoked_at: Date | null;
}

function mapAuthorisation(row: AuthorisationRow): ScanAuthorisation {
  return {
    id: row.id,
    organisationId: row.organisation_id,
    agentId: row.agent_id,
    ranges: row.ranges,
    methods: row.methods,
    authorisedBy: row.authorised_by,
    authorisedAt: row.authorised_at,
    approvalId: row.approval_id,
    expiresAt: row.expires_at,
    revokedBy: row.revoked_by,
    revokedAt: row.revoked_at,
  };
}

/**
 * Record one scan's permission.
 *
 * `$4::cidr[]` RATHER THAN TEXT. The cast is what refuses a malformed range, and
 * it refuses it in the type system of the database rather than in whichever
 * regex the caller remembered to write.
 *
 * The insert fails outright when discovery is off — see the trigger note above.
 */
export async function insertAuthorisation(
  db: Executor,
  input: {
    id: string;
    organisationId: string;
    agentId: string;
    ranges: string[];
    methods: ScanMethod[];
    authorisedBy: string;
    approvalId: string | null;
    expiresAt: Date;
  },
): Promise<void> {
  await db.query(
    `INSERT INTO discovery_authorisations
       (id, organisation_id, agent_id, ranges, methods, authorised_by, approval_id, expires_at)
     VALUES ($1, $2, $3, $4::cidr[], $5, $6, $7, $8)`,
    [
      input.id,
      input.organisationId,
      input.agentId,
      input.ranges,
      input.methods,
      input.authorisedBy,
      input.approvalId,
      input.expiresAt,
    ],
  );
}

/**
 * Close the window early.
 *
 * `revoked_at IS NULL` IS THERE FOR CORRECTNESS, NOT ACCESS. Revoking twice
 * would move the timestamp and the attribution onto the second attempt, and the
 * record of when the permission actually ended — the thing a review is reading
 * — would be the later, less true one.
 *
 * Null means no live authorisation by that id. Whether that is "already
 * revoked" or "never existed" is the service's to phrase.
 */
export async function revokeAuthorisation(
  db: Executor,
  input: { id: string; by: string },
): Promise<ScanAuthorisation | null> {
  const { rows } = await db.query<AuthorisationRow>(
    `UPDATE discovery_authorisations
        SET revoked_by = $2, revoked_at = now()
      WHERE id = $1 AND revoked_at IS NULL
      RETURNING ${AUTHORISATION_COLUMNS}`,
    [input.id, input.by],
  );
  return rows[0] ? mapAuthorisation(rows[0]) : null;
}

/* ── 9.3 Runs ───────────────────────────────────────────────────────────── */

interface RunSummaryRow {
  id: string;
  authorisation_id: string;
  agent_id: string;
  status: RunSummary['status'];
  hosts_contacted: number;
  started_at: Date;
  completed_at: Date | null;
  findings: string;
}

function mapRunSummary(row: RunSummaryRow): RunSummary {
  return {
    id: row.id,
    authorisationId: row.authorisation_id,
    agentId: row.agent_id,
    status: row.status,
    hostsContacted: row.hosts_contacted,
    startedAt: row.started_at,
    // count(*) is bigint, which arrives as a string.
    findings: Number(row.findings),
    completedAt: row.completed_at,
  };
}

/**
 * Open a run.
 *
 * 'running' IS WRITTEN HERE BECAUSE IT IS THE ONLY THING A NEW RUN CAN BE. It is
 * not a choice the caller makes — 019's `discovery_run_finished` constraint
 * refuses any other status without a `completed_at`, so a run that starts
 * finished is a contradiction rather than an option.
 *
 * Fails when the authorisation has expired or been revoked — see the trigger
 * note above.
 */
export async function insertRun(
  db: Executor,
  input: { id: string; authorisationId: string },
): Promise<void> {
  await db.query(
    `INSERT INTO discovery_runs (id, authorisation_id, status) VALUES ($1, $2, 'running')`,
    [input.id, input.authorisationId],
  );
}

export async function completeRun(
  db: Executor,
  input: { runId: string; hostsContacted: number },
): Promise<void> {
  await db.query(
    `UPDATE discovery_runs
        SET hosts_contacted = $2, status = 'completed', completed_at = now()
      WHERE id = $1`,
    [input.runId, input.hostsContacted],
  );
}

/**
 * The scans that have run, newest first.
 *
 * THE AGENT COMES FROM THE AUTHORISATION because that is where it lives: a run
 * knows what it ran under and nothing else, so "what has this agent contacted"
 * needs the join before it can be asked.
 *
 * Columns are written out with their alias rather than derived from a shared
 * list by string surgery, for the reason `membership.repo` gives: both tables
 * have an `id`, and the shared lists here are multi-line templates.
 */
export async function listRuns(db: Executor): Promise<RunSummary[]> {
  const { rows } = await db.query<RunSummaryRow>(
    `SELECT r.id, r.authorisation_id, a.agent_id, r.status, r.hosts_contacted,
            r.started_at, r.completed_at,
            (SELECT count(*) FROM discovery_candidates f WHERE f.run_id = r.id) AS findings
       FROM discovery_runs r
       JOIN discovery_authorisations a ON a.id = r.authorisation_id
      ORDER BY r.started_at DESC LIMIT 100`,
  );
  return rows.map(mapRunSummary);
}

/* ── 9.3 / 9.4 Findings ─────────────────────────────────────────────────── */

const FINDING_COLUMNS = `
  id, run_id, host, port, method, structure, proposed_transport, confidence,
  decision, reviewed_by, reviewed_at, promoted_connection_id, found_at
`;

interface FindingRow {
  id: string;
  run_id: string;
  host: string;
  port: number | null;
  method: ScanMethod;
  structure: Record<string, unknown>;
  proposed_transport: string | null;
  confidence: string | null;
  decision: FindingDecision | null;
  reviewed_by: string | null;
  reviewed_at: Date | null;
  promoted_connection_id: string | null;
  found_at: Date;
}

function mapFinding(row: FindingRow): DiscoveryFinding {
  return {
    id: row.id,
    runId: row.run_id,
    host: row.host,
    port: row.port,
    method: row.method,
    structure: row.structure,
    proposedTransport: row.proposed_transport,
    // numeric(3,2) arrives as a string; coerced once, here.
    confidence: row.confidence === null ? null : Number(row.confidence),
    decision: row.decision,
    reviewedBy: row.reviewed_by,
    reviewedAt: row.reviewed_at,
    promotedConnectionId: row.promoted_connection_id,
    foundAt: row.found_at,
  };
}

/**
 * Record one thing an agent saw.
 *
 * ONE ROW PER CALL, NOT A BATCH, because §9.3 wants a probe logged individually
 * against the authorisation it ran under and the audit write belongs beside the
 * insert it describes. A batch here would put the two out of step: rows written
 * in one statement and a trail assembled afterwards from what the caller
 * remembers it sent.
 *
 * `structure` is whatever the service decided may be stored — this file does not
 * inspect it.
 */
export async function insertFinding(
  db: Executor,
  input: {
    runId: string;
    host: string;
    port: number | null;
    method: ScanMethod;
    structure: unknown;
    proposedTransport: string | null;
    confidence: number | null;
  },
): Promise<void> {
  await db.query(
    `INSERT INTO discovery_candidates
       (id, run_id, host, port, method, structure, proposed_transport, confidence)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      generateId(),
      input.runId,
      input.host,
      input.port,
      input.method,
      JSON.stringify(input.structure),
      input.proposedTransport,
      input.confidence,
    ],
  );
}

export async function findFinding(db: Executor, id: string): Promise<DiscoveryFinding | null> {
  const { rows } = await db.query<FindingRow>(
    `SELECT ${FINDING_COLUMNS} FROM discovery_candidates WHERE id = $1`,
    [id],
  );
  return rows[0] ? mapFinding(rows[0]) : null;
}

/**
 * Findings, optionally narrowed to one run.
 *
 * `$1::uuid IS NULL OR` IS THE OPTIONAL FILTER, not a permission: with no run
 * named the caller is asking for every finding it can see, and which ones those
 * are is decided by the row level security in 019 reaching through the run to
 * the authorisation's organisation.
 *
 * THE JOIN TO `discovery_runs` NARROWS NOTHING — `run_id` is a NOT NULL foreign
 * key, so every finding has exactly one run. It is here because it was here
 * before this file existed and removing it is a behaviour change this pass is
 * not making.
 */
export async function listFindings(
  db: Executor,
  options: { runId?: string | null } = {},
): Promise<DiscoveryFinding[]> {
  const { rows } = await db.query<FindingRow>(
    `SELECT f.id, f.run_id, f.host, f.port, f.method, f.structure, f.proposed_transport,
            f.confidence, f.decision, f.reviewed_by, f.reviewed_at,
            f.promoted_connection_id, f.found_at
       FROM discovery_candidates f
       JOIN discovery_runs r ON r.id = f.run_id
      WHERE ($1::uuid IS NULL OR f.run_id = $1)
      ORDER BY f.found_at DESC LIMIT 500`,
    [options.runId ?? null],
  );
  return rows.map(mapFinding);
}

/**
 * Write a person's decision onto a finding.
 *
 * NOTHING HERE REFUSES A SECOND DECISION. The service reads the finding first
 * and stops when one has already been taken, because "that was already
 * rejected" is an answer to give somebody rather than a row silently not
 * updating.
 */
export async function decideFinding(
  db: Executor,
  input: { id: string; decision: FindingDecision; reviewedBy: string },
): Promise<DiscoveryFinding | null> {
  const { rows } = await db.query<FindingRow>(
    `UPDATE discovery_candidates
        SET decision = $2, reviewed_by = $3, reviewed_at = now()
      WHERE id = $1
      RETURNING ${FINDING_COLUMNS}`,
    [input.id, input.decision, input.reviewedBy],
  );
  return rows[0] ? mapFinding(rows[0]) : null;
}
