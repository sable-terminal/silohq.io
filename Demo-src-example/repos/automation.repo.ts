import type { Executor } from '../infra/db.infra';

/**
 * §12 — automations, their conditions, their actions and their runs.
 *
 * THE CLAIM IS A CONDITIONAL UPDATE, NOT A READ THEN A WRITE. §7 says a run
 * still in progress when the next is due skips rather than queues, and two
 * runners that both read "not running" and then both wrote would each believe
 * they were the only one. `claim` sets `running_since` only where it is still
 * null, and reports whether it won.
 */

export type Status = 'active' | 'paused';
export type PausedReason = 'owner' | 'failures' | 'halted' | 'owner_removed';
export type FailurePolicy = 'notify_and_continue' | 'pause_after_failures';

export type Source = 'view' | 'findings';

export interface Automation {
  id: string;
  organisationId: string;
  ownerMembershipId: string;
  name: string;
  /** §3 — null where the automation watches the checks rather than a question. */
  source: Source;
  savedViewId: string | null;
  schedule: string;
  timeZone: string;
  status: Status;
  pausedReason: PausedReason | null;
  failurePolicy: FailurePolicy;
  pauseAfter: number | null;
  consecutiveFailures: number;
  runningSince: Date | null;
  lastRunAt: Date | null;
  nextRunAt: Date | null;
}

export interface Condition {
  id: string;
  kind: 'result' | 'finding' | 'value';
  target: string | null;
  operator: string;
  value: unknown;
  combinator: 'and' | 'or';
  sequence: number;
}

export interface Action {
  id: string;
  /** §5 — `mutate` proposes; nothing here writes to a customer's systems. */
  kind: 'notify' | 'mutate' | 'escalate' | 'report';
  configuration: Record<string, unknown>;
  sequence: number;
}

type Row = {
  id: string;
  organisation_id: string;
  owner_membership_id: string;
  name: string;
  source: Source;
  saved_view_id: string | null;
  schedule: string;
  time_zone: string;
  status: Status;
  paused_reason: PausedReason | null;
  failure_policy: FailurePolicy;
  pause_after: number | null;
  consecutive_failures: number;
  running_since: Date | null;
  last_run_at: Date | null;
  next_run_at: Date | null;
};

const COLUMNS = `id, organisation_id, owner_membership_id, name, source, saved_view_id, schedule, time_zone,
                 status, paused_reason, failure_policy, pause_after, consecutive_failures,
                 running_since, last_run_at, next_run_at`;

const map = (row: Row): Automation => ({
  id: row.id,
  organisationId: row.organisation_id,
  ownerMembershipId: row.owner_membership_id,
  name: row.name,
  source: row.source,
  savedViewId: row.saved_view_id,
  schedule: row.schedule,
  timeZone: row.time_zone,
  status: row.status,
  pausedReason: row.paused_reason,
  failurePolicy: row.failure_policy,
  pauseAfter: row.pause_after,
  consecutiveFailures: row.consecutive_failures,
  runningSince: row.running_since,
  lastRunAt: row.last_run_at,
  nextRunAt: row.next_run_at,
});

export async function create(
  db: Executor,
  input: {
    id: string;
    organisationId: string;
    ownerMembershipId: string;
    name: string;
    source: Source;
    savedViewId: string | null;
    schedule: string;
    timeZone: string;
    failurePolicy: FailurePolicy;
    pauseAfter: number | null;
    nextRunAt: Date | null;
  },
): Promise<Automation> {
  const { rows } = await db.query<Row>(
    `INSERT INTO automations
       (id, organisation_id, owner_membership_id, name, source, saved_view_id, schedule, time_zone,
        failure_policy, pause_after, next_run_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     RETURNING ${COLUMNS}`,
    [
      input.id,
      input.organisationId,
      input.ownerMembershipId,
      input.name,
      input.source,
      input.savedViewId,
      input.schedule,
      input.timeZone,
      input.failurePolicy,
      input.pauseAfter,
      input.nextRunAt,
    ],
  );
  return map(rows[0]!);
}

export async function addCondition(
  db: Executor,
  input: {
    id: string;
    organisationId: string;
    automationId: string;
    kind: Condition['kind'];
    target: string | null;
    operator: string;
    value: unknown;
    combinator: Condition['combinator'];
    sequence: number;
  },
): Promise<void> {
  await db.query(
    `INSERT INTO automation_conditions
       (id, organisation_id, automation_id, kind, target, operator, value, combinator, sequence)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      input.id,
      input.organisationId,
      input.automationId,
      input.kind,
      input.target,
      input.operator,
      input.value === undefined ? null : JSON.stringify(input.value),
      input.combinator,
      input.sequence,
    ],
  );
}

export async function addAction(
  db: Executor,
  input: {
    id: string;
    organisationId: string;
    automationId: string;
    kind: Action['kind'];
    configuration: Record<string, unknown>;
    sequence: number;
  },
): Promise<void> {
  await db.query(
    `INSERT INTO automation_actions (id, organisation_id, automation_id, kind, configuration, sequence)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      input.id,
      input.organisationId,
      input.automationId,
      input.kind,
      JSON.stringify(input.configuration),
      input.sequence,
    ],
  );
}

export async function read(db: Executor, id: string): Promise<Automation | null> {
  const { rows } = await db.query<Row>(`SELECT ${COLUMNS} FROM automations WHERE id = $1`, [id]);
  return rows[0] ? map(rows[0]) : null;
}

export async function listOwnedBy(db: Executor, membershipId: string): Promise<Automation[]> {
  const { rows } = await db.query<Row>(
    `SELECT ${COLUMNS} FROM automations WHERE owner_membership_id = $1 ORDER BY created_at DESC`,
    [membershipId],
  );
  return rows.map(map);
}

export async function conditionsFor(db: Executor, automationId: string): Promise<Condition[]> {
  const { rows } = await db.query<{
    id: string;
    kind: Condition['kind'];
    target: string | null;
    operator: string;
    value: unknown;
    combinator: Condition['combinator'];
    sequence: number;
  }>(
    `SELECT id, kind, target, operator, value, combinator, sequence
       FROM automation_conditions WHERE automation_id = $1 ORDER BY sequence`,
    [automationId],
  );
  return rows;
}

export async function actionsFor(db: Executor, automationId: string): Promise<Action[]> {
  const { rows } = await db.query<{
    id: string;
    kind: Action['kind'];
    configuration: Record<string, unknown>;
    sequence: number;
  }>(
    `SELECT id, kind, configuration, sequence
       FROM automation_actions WHERE automation_id = $1 ORDER BY sequence`,
    [automationId],
  );
  return rows;
}

/**
 * Everything due, across tenants. The scheduler's, and only the scheduler's.
 *
 * ORDERED BY HOW LATE THEY ARE, so an outage drains oldest first rather than
 * leaving one automation permanently behind a busier one.
 */
export async function due(db: Executor, at: Date, limit = 200): Promise<Array<{ id: string; organisationId: string }>> {
  const { rows } = await db.query<{ id: string; organisation_id: string }>(
    `SELECT id, organisation_id FROM automations
      WHERE status = 'active' AND running_since IS NULL AND next_run_at IS NOT NULL AND next_run_at <= $1
      ORDER BY next_run_at
      LIMIT $2`,
    [at, limit],
  );
  return rows.map((row) => ({ id: row.id, organisationId: row.organisation_id }));
}

/**
 * Take the automation, or report that somebody else has it.
 *
 * §7's overlap rule, as one statement. A read followed by a write would let two
 * runners both see "free" and both proceed.
 */
export async function claim(db: Executor, id: string, at: Date): Promise<boolean> {
  const { rowCount } = await db.query(
    `UPDATE automations SET running_since = $2 WHERE id = $1 AND running_since IS NULL AND status = 'active'`,
    [id, at],
  );
  return (rowCount ?? 0) > 0;
}

export async function release(
  db: Executor,
  input: { id: string; lastRunAt: Date; nextRunAt: Date | null },
): Promise<void> {
  await db.query(
    `UPDATE automations SET running_since = NULL, last_run_at = $2, next_run_at = $3 WHERE id = $1`,
    [input.id, input.lastRunAt, input.nextRunAt],
  );
}

/**
 * §8 — "A halted connection pauses every automation depending on it."
 *
 * DEPENDING ON IT MEANS ITS CONCEPT REACHES IT. An automation names a saved
 * view or a concept, never a connection, so the dependency is found through the
 * ontology: the concept's objects say which systems answer for it.
 *
 * BOTH SHAPES, DELIBERATELY. A view automation reaches a concept through its
 * view; a findings automation names one on its condition. Pausing only the
 * first would leave a check watching a system that stopped answering — and §8's
 * whole reasoning is that running a condition against a system that is down
 * "produces a false negative, which is the failure mode most likely to be
 * trusted".
 *
 * Returns what it paused, so each can be recorded and its owner told.
 */
export async function pauseDependingOn(
  db: Executor,
  input: { connectionId: string; reason: PausedReason },
): Promise<Array<{ id: string; ownerMembershipId: string; name: string }>> {
  const { rows } = await db.query<{ id: string; owner_membership_id: string; name: string }>(
    `UPDATE automations a
        SET status = 'paused', paused_reason = $2, paused_at = now(), running_since = NULL
      WHERE a.status = 'active'
        AND EXISTS (
              SELECT 1 FROM concept_objects o
               WHERE o.connection_id = $1
                 AND (
                   o.concept_id = (SELECT v.concept_id FROM saved_views v WHERE v.id = a.saved_view_id)
                   OR o.concept_id::text IN (
                        SELECT c.value ->> 'conceptId'
                          FROM automation_conditions c
                         WHERE c.automation_id = a.id AND c.kind = 'finding'
                      )
                 )
            )
      RETURNING a.id, a.owner_membership_id, a.name`,
    [input.connectionId, input.reason],
  );
  return rows.map((row) => ({ id: row.id, ownerMembershipId: row.owner_membership_id, name: row.name }));
}

/**
 * §9 — "On owner removal, automations pause and surface to the admin above
 * them for review. They do not continue running under a removed identity."
 *
 * SUSPENSION PAUSES TOO, by §6's rule that an automation's permissions are the
 * intersection of its grant and what its owner holds AT RUN TIME. A suspended
 * owner holds nothing, so the automation would fail every run until somebody
 * noticed; pausing says what happened instead.
 */
export async function pauseOwnedBy(
  db: Executor,
  input: { membershipId: string; reason: PausedReason },
): Promise<Array<{ id: string; name: string }>> {
  const { rows } = await db.query<{ id: string; name: string }>(
    `UPDATE automations
        SET status = 'paused', paused_reason = $2, paused_at = now(), running_since = NULL
      WHERE owner_membership_id = $1 AND status = 'active'
      RETURNING id, name`,
    [input.membershipId, input.reason],
  );
  return rows;
}

/**
 * AUTH rev 7 — "Crons attached to a transferred view remain paused until the
 * receiving admin both reviews the view and explicitly resumes them."
 *
 * ATTACHED TO THE VIEW, NOT OWNED BY THE LEAVER. `pauseOwnedBy` above already
 * catches the crons the departing person made; this catches a colleague's cron
 * scheduled on a view that person owned. The question it asks at every run is
 * now somebody else's, under a name the colleague never agreed to — so it stops
 * until the new owner says otherwise, which is the same reasoning §9 applies to
 * running under a removed identity.
 */
export async function pauseAttachedToView(
  db: Executor,
  input: { viewId: string; reason: PausedReason },
): Promise<Array<{ id: string; name: string; ownerMembershipId: string }>> {
  const { rows } = await db.query<{ id: string; name: string; owner_membership_id: string }>(
    `UPDATE automations
        SET status = 'paused', paused_reason = $2, paused_at = now(), running_since = NULL
      WHERE saved_view_id = $1 AND status = 'active'
      RETURNING id, name, owner_membership_id`,
    [input.viewId, input.reason],
  );
  return rows.map((row) => ({ id: row.id, name: row.name, ownerMembershipId: row.owner_membership_id }));
}

/** Every cron scheduled on one view, whoever made it. */
export async function attachedToView(db: Executor, viewId: string): Promise<Automation[]> {
  const { rows } = await db.query<Row>(
    `SELECT ${COLUMNS} FROM automations WHERE saved_view_id = $1 ORDER BY created_at`,
    [viewId],
  );
  return rows.map(map);
}

/** A stuck claim, released so a crashed runner does not pause an automation forever. */
export async function releaseStale(db: Executor, before: Date): Promise<number> {
  const { rowCount } = await db.query(
    `UPDATE automations SET running_since = NULL WHERE running_since IS NOT NULL AND running_since < $1`,
    [before],
  );
  return rowCount ?? 0;
}

export async function pause(
  db: Executor,
  input: { id: string; reason: PausedReason },
): Promise<Automation | null> {
  const { rows } = await db.query<Row>(
    `UPDATE automations SET status = 'paused', paused_reason = $2, paused_at = now(), running_since = NULL
      WHERE id = $1 AND status = 'active'
      RETURNING ${COLUMNS}`,
    [input.id, input.reason],
  );
  return rows[0] ? map(rows[0]) : null;
}

export async function resume(db: Executor, input: { id: string; nextRunAt: Date | null }): Promise<Automation | null> {
  const { rows } = await db.query<Row>(
    `UPDATE automations
        SET status = 'active', paused_reason = NULL, paused_at = NULL,
            consecutive_failures = 0, next_run_at = $2
      WHERE id = $1 AND status = 'paused'
      RETURNING ${COLUMNS}`,
    [input.id, input.nextRunAt],
  );
  return rows[0] ? map(rows[0]) : null;
}

export async function remove(db: Executor, id: string): Promise<boolean> {
  const { rowCount } = await db.query(`DELETE FROM automations WHERE id = $1`, [id]);
  return (rowCount ?? 0) > 0;
}

/** Returns the new count, so the caller can decide whether the policy bites. */
export async function recordFailure(db: Executor, id: string): Promise<number> {
  const { rows } = await db.query<{ consecutive_failures: number }>(
    `UPDATE automations SET consecutive_failures = consecutive_failures + 1
      WHERE id = $1 RETURNING consecutive_failures`,
    [id],
  );
  return rows[0]?.consecutive_failures ?? 0;
}

export async function clearFailures(db: Executor, id: string): Promise<void> {
  await db.query(`UPDATE automations SET consecutive_failures = 0 WHERE id = $1 AND consecutive_failures > 0`, [id]);
}

/* ── Runs ────────────────────────────────────────────────────────────────── */

export async function startRun(
  db: Executor,
  input: { id: string; organisationId: string; automationId: string },
): Promise<void> {
  await db.query(
    `INSERT INTO automation_runs (id, organisation_id, automation_id) VALUES ($1, $2, $3)`,
    [input.id, input.organisationId, input.automationId],
  );
}

export async function finishRun(
  db: Executor,
  input: {
    id: string;
    conditionOutcome: 'met' | 'not_met' | null;
    actionsTaken: unknown[];
    error: string | null;
    skippedReason: 'already_running' | 'missed_window' | null;
  },
): Promise<void> {
  await db.query(
    `UPDATE automation_runs
        SET completed_at = now(), condition_outcome = $2, actions_taken = $3, error = $4, skipped_reason = $5
      WHERE id = $1`,
    [input.id, input.conditionOutcome, JSON.stringify(input.actionsTaken), input.error, input.skippedReason],
  );
}

export interface Run {
  id: string;
  startedAt: Date;
  completedAt: Date | null;
  conditionOutcome: 'met' | 'not_met' | null;
  actionsTaken: unknown[];
  error: string | null;
  skippedReason: string | null;
}

export async function runsFor(db: Executor, automationId: string, limit = 50): Promise<Run[]> {
  const { rows } = await db.query<{
    id: string;
    started_at: Date;
    completed_at: Date | null;
    condition_outcome: 'met' | 'not_met' | null;
    actions_taken: unknown[];
    error: string | null;
    skipped_reason: string | null;
  }>(
    `SELECT id, started_at, completed_at, condition_outcome, actions_taken, error, skipped_reason
       FROM automation_runs WHERE automation_id = $1 ORDER BY started_at DESC LIMIT $2`,
    [automationId, limit],
  );
  return rows.map((row) => ({
    id: row.id,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    conditionOutcome: row.condition_outcome,
    actionsTaken: row.actions_taken,
    error: row.error,
    skippedReason: row.skipped_reason,
  }));
}

/* ── Run state: a digest and two numbers, never rows ─────────────────────── */

export interface RunState {
  previousResultHash: string | null;
  previousRowCount: number | null;
  previousFigure: number | null;
  /** §3 — when the figure last took a different value. */
  figureUnchangedSince: Date | null;
}

export async function stateFor(db: Executor, automationId: string): Promise<RunState | null> {
  const { rows } = await db.query<{
    previous_result_hash: string | null;
    previous_row_count: number | null;
    previous_figure: string | null;
    figure_unchanged_since: Date | null;
  }>(
    `SELECT previous_result_hash, previous_row_count, previous_figure, figure_unchanged_since
       FROM automation_run_state WHERE automation_id = $1`,
    [automationId],
  );
  const row = rows[0];
  if (!row) return null;

  return {
    previousResultHash: row.previous_result_hash,
    previousRowCount: row.previous_row_count,
    previousFigure: row.previous_figure === null ? null : Number(row.previous_figure),
    figureUnchangedSince: row.figure_unchanged_since,
  };
}

export async function rememberState(
  db: Executor,
  input: {
    organisationId: string;
    automationId: string;
    resultHash: string;
    rowCount: number;
    figure: number | null;
    at: Date;
  },
): Promise<void> {
  /*
   * §3 — `figure_unchanged_since` MOVES ONLY WHEN THE FIGURE DOES, decided in
   * SQL rather than read-then-written. The whole point of the column is that it
   * survives runs which changed nothing, and a read-then-write would reset it
   * on any retry that re-read its own write.
   */
  await db.query(
    `INSERT INTO automation_run_state
       (automation_id, organisation_id, previous_result_hash, previous_row_count,
        previous_figure, figure_unchanged_since)
     VALUES ($1, $2, $3, $4, $5, CASE WHEN $5::numeric IS NULL THEN NULL ELSE $6::timestamptz END)
     ON CONFLICT (automation_id) DO UPDATE
        SET previous_result_hash   = EXCLUDED.previous_result_hash,
            previous_row_count     = EXCLUDED.previous_row_count,
            previous_figure        = EXCLUDED.previous_figure,
            figure_unchanged_since =
              CASE
                WHEN EXCLUDED.previous_figure IS NULL THEN NULL
                WHEN automation_run_state.previous_figure IS DISTINCT FROM EXCLUDED.previous_figure
                  THEN $6::timestamptz
                ELSE COALESCE(automation_run_state.figure_unchanged_since, $6::timestamptz)
              END,
            updated_at             = now()`,
    [input.automationId, input.organisationId, input.resultHash, input.rowCount, input.figure, input.at],
  );
}


/**
 * §11 — "Home shows crons that ran and found something."
 *
 * ACROSS AUTOMATIONS, WHICH IS WHY IT IS NOT `runsFor`. The per-automation
 * history answers "is this one working"; this answers "did anything I have
 * scheduled find something", and a reader who has to open each check in turn to
 * find out has the problem §11 describes — a result that only lives inside
 * Governance is one nobody sees.
 *
 * ONLY THE RUNS THAT FIRED. The quiet ones are the point of the history and the
 * noise of a feed.
 */
export async function firedFor(
  db: Executor,
  input: { membershipId: string; limit?: number },
): Promise<Array<Run & { automationId: string; automationName: string }>> {
  const { rows } = await db.query<{
    id: string;
    automation_id: string;
    automation_name: string;
    started_at: Date;
    completed_at: Date | null;
    condition_outcome: 'met' | 'not_met' | null;
    actions_taken: unknown[];
    error: string | null;
    skipped_reason: string | null;
  }>(
    `SELECT r.id, r.automation_id, a.name AS automation_name, r.started_at, r.completed_at,
            r.condition_outcome, r.actions_taken, r.error, r.skipped_reason
       FROM automation_runs r
       JOIN automations a ON a.id = r.automation_id
      WHERE a.owner_membership_id = $1 AND r.condition_outcome = 'met'
      ORDER BY r.started_at DESC
      LIMIT $2`,
    [input.membershipId, input.limit ?? 50],
  );

  return rows.map((row) => ({
    id: row.id,
    automationId: row.automation_id,
    automationName: row.automation_name,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    conditionOutcome: row.condition_outcome,
    actionsTaken: row.actions_taken,
    error: row.error,
    skippedReason: row.skipped_reason,
  }));
}

/* ── §4: escalations, which are notifications with a state ───────────────── */

export interface Escalation {
  id: string;
  automationId: string;
  automationName: string;
  runId: string;
  membershipId: string | null;
  scopeId: string | null;
  because: string;
  raisedAt: Date;
  acknowledgedBy: string | null;
  acknowledgedAt: Date | null;
  note: string | null;
}

export async function raiseEscalation(
  db: Executor,
  input: {
    id: string;
    organisationId: string;
    automationId: string;
    runId: string;
    membershipId: string | null;
    scopeId: string | null;
    because: string;
  },
): Promise<void> {
  await db.query(
    `INSERT INTO automation_escalations
       (id, organisation_id, automation_id, run_id, membership_id, scope_id, because)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      input.id,
      input.organisationId,
      input.automationId,
      input.runId,
      input.membershipId,
      input.scopeId,
      input.because,
    ],
  );
}

const ESCALATION_COLUMNS = `e.id, e.automation_id, a.name AS automation_name, e.run_id, e.membership_id,
                            e.scope_id, e.because, e.raised_at, e.acknowledged_by, e.acknowledged_at, e.note`;

type EscalationRow = {
  id: string;
  automation_id: string;
  automation_name: string;
  run_id: string;
  membership_id: string | null;
  scope_id: string | null;
  because: string;
  raised_at: Date;
  acknowledged_by: string | null;
  acknowledged_at: Date | null;
  note: string | null;
};

const mapEscalation = (row: EscalationRow): Escalation => ({
  id: row.id,
  automationId: row.automation_id,
  automationName: row.automation_name,
  runId: row.run_id,
  membershipId: row.membership_id,
  scopeId: row.scope_id,
  because: row.because,
  raisedAt: row.raised_at,
  acknowledgedBy: row.acknowledged_by,
  acknowledgedAt: row.acknowledged_at,
  note: row.note,
});

/**
 * §4 — what is waiting on this person.
 *
 * NAMED DIRECTLY, OR THROUGH A SCOPE THEY BELONG TO. An escalation raised to a
 * scope is answerable by anybody in it; one raised to a membership is not
 * answerable by their colleagues, which is the difference between "somebody
 * should look" and "you should look".
 */
export async function escalationsFor(
  db: Executor,
  input: { membershipId: string; includeAnswered: boolean },
): Promise<Escalation[]> {
  const { rows } = await db.query<EscalationRow>(
    `SELECT ${ESCALATION_COLUMNS}
       FROM automation_escalations e
       JOIN automations a ON a.id = e.automation_id
      WHERE (
              e.membership_id = $1
              OR e.scope_id IN (SELECT scope_id FROM scope_memberships WHERE membership_id = $1)
            )
        AND ($2 OR e.acknowledged_at IS NULL)
      ORDER BY e.raised_at DESC
      LIMIT 200`,
    [input.membershipId, input.includeAnswered],
  );
  return rows.map(mapEscalation);
}

/**
 * Answer one.
 *
 * `acknowledged_at IS NULL` IS THE GUARD, so the first answer stands. A second
 * person reaching the same escalation is told it has been dealt with rather
 * than quietly replacing the name of whoever dealt with it.
 */
export async function acknowledge(
  db: Executor,
  input: { id: string; membershipId: string; note: string | null },
): Promise<boolean> {
  const { rowCount } = await db.query(
    `UPDATE automation_escalations
        SET acknowledged_by = $2, acknowledged_at = now(), note = $3
      WHERE id = $1 AND acknowledged_at IS NULL`,
    [input.id, input.membershipId, input.note],
  );
  return (rowCount ?? 0) > 0;
}

/* ── §5: execute within bounds ───────────────────────────────────────────── */

export interface Authorisation {
  id: string;
  automationId: string;
  maxRows: number;
  permittedFields: string[];
  permittedConnections: string[];
  authorisedBy: string;
  expiresAt: Date;
}

export async function authorise(
  db: Executor,
  input: {
    id: string;
    organisationId: string;
    automationId: string;
    maxRows: number;
    permittedFields: string[];
    permittedConnections: string[];
    authorisedBy: string;
    expiresAt: Date;
  },
): Promise<Authorisation> {
  const { rows } = await db.query<{
    id: string;
    automation_id: string;
    max_rows: number;
    permitted_fields: string[];
    permitted_connections: string[];
    authorised_by: string;
    expires_at: Date;
  }>(
    `INSERT INTO automation_authorisations
       (id, organisation_id, automation_id, max_rows, permitted_fields, permitted_connections,
        authorised_by, expires_at)
     VALUES ($1, $2, $3, $4, $5::text[], $6::uuid[], $7, $8)
     RETURNING id, automation_id, max_rows, permitted_fields, permitted_connections, authorised_by, expires_at`,
    [
      input.id,
      input.organisationId,
      input.automationId,
      input.maxRows,
      input.permittedFields,
      input.permittedConnections,
      input.authorisedBy,
      input.expiresAt,
    ],
  );

  const row = rows[0]!;
  return {
    id: row.id,
    automationId: row.automation_id,
    maxRows: row.max_rows,
    permittedFields: row.permitted_fields,
    permittedConnections: row.permitted_connections,
    authorisedBy: row.authorised_by,
    expiresAt: row.expires_at,
  };
}

/**
 * The live authorisation, if there is one that has not expired.
 *
 * EXPIRY IS APPLIED IN THE QUERY, not by the caller comparing dates. §5 makes
 * the expiry one of the four things execute mode requires, and a caller that
 * forgot to check it would be a caller that writes unattended past the date
 * somebody set — which is the exact failure the expiry exists to prevent.
 */
export async function liveAuthorisation(
  db: Executor,
  input: { automationId: string; at: Date },
): Promise<Authorisation | null> {
  const { rows } = await db.query<{
    id: string;
    automation_id: string;
    max_rows: number;
    permitted_fields: string[];
    permitted_connections: string[];
    authorised_by: string;
    expires_at: Date;
  }>(
    `SELECT id, automation_id, max_rows, permitted_fields, permitted_connections, authorised_by, expires_at
       FROM automation_authorisations
      WHERE automation_id = $1 AND revoked_at IS NULL AND expires_at > $2`,
    [input.automationId, input.at],
  );

  const row = rows[0];
  if (!row) return null;

  return {
    id: row.id,
    automationId: row.automation_id,
    maxRows: row.max_rows,
    permittedFields: row.permitted_fields,
    permittedConnections: row.permitted_connections,
    authorisedBy: row.authorised_by,
    expiresAt: row.expires_at,
  };
}

export async function revokeAuthorisation(db: Executor, automationId: string): Promise<boolean> {
  const { rowCount } = await db.query(
    `UPDATE automation_authorisations SET revoked_at = now()
      WHERE automation_id = $1 AND revoked_at IS NULL`,
    [automationId],
  );
  return (rowCount ?? 0) > 0;
}
