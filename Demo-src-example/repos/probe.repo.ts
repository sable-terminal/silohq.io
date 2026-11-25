import type { Executor } from '../infra/db.infra';
import type { RunStage, RunStatus } from '../models/connectorLifecycle.model';

/**
 * `probe_runs` — every stage of §7's verification, on every route.
 *
 * ONE STATEMENT FOR A TABLE TWO SERVICES WRITE. The read-only probe and the
 * write-verify-undo cycle used to carry a near-identical upsert each, differing
 * only in the stage they hardcoded and in `read_only`; both are values, so both
 * are parameters, and the shape of the statement is now checkable in one place.
 *
 * NO ROWS ARE STORED HERE AND THERE IS NO COLUMN FOR ANY. `findings` is the
 * SHAPE a run saw — which fields came back, which were declared and did not,
 * how long it took. What the caller passes is the caller's business, but 017
 * has nowhere to put a customer's records and that is on purpose.
 */

/**
 * Start a run, or finish the one already started under this id.
 *
 * AN UPSERT BECAUSE A RUN IS WRITTEN TWICE. The row is inserted `running`
 * before the request goes out to somebody's system, so a probe that hangs and
 * never completes still leaves a trace; the same id is then updated with the
 * outcome. Two inserts would leave two rows and no way to tell which was which.
 *
 * `completed_at` IS DERIVED FROM THE STATUS IN THE STATEMENT because 017's
 * `probe_finished` CHECK refuses a finished run without one, and computing it
 * at the call site is how the two drift.
 */
export async function record(
  db: Executor,
  run: {
    id: string;
    connectionId: string;
    stage: RunStage;
    status: RunStatus;
    findings: Record<string, unknown>;
    errors: unknown[];
    readOnly: boolean;
  },
): Promise<void> {
  await db.query(
    `INSERT INTO probe_runs (id, connection_id, stage, status, findings, errors, read_only, completed_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, CASE WHEN $4 = 'running' THEN NULL ELSE now() END)
     ON CONFLICT (id) DO UPDATE
       SET status = EXCLUDED.status,
           findings = EXCLUDED.findings,
           errors = EXCLUDED.errors,
           completed_at = EXCLUDED.completed_at`,
    [
      run.id,
      run.connectionId,
      run.stage,
      run.status,
      JSON.stringify(run.findings),
      JSON.stringify(run.errors),
      run.readOnly,
    ],
  );
}
