// A stream made subscribable (decision 2026-11-15), for a test about what subscribing or
// watching does rather than about the change-stream class itself (that class is run for real
// in tests/services/streamConformance.test.ts): a completed change_stream run on the
// connection's current manifest version, every required test passed for each object.

import type pg from 'pg';
import { STREAM_TESTS, streamTestId } from '../../src/contracts/conformance/changeStreamClass.contract.ts';
import { inTx, uuidv7 } from '../db/harness.helper.ts';

export async function markSubscribable(cell: { app: pg.Client; org: string }, connectionId: string, objects: readonly string[]): Promise<string> {
  const tests = objects.flatMap((object) => STREAM_TESTS.map((test) => ({
    id: streamTestId(test, object), class: 'change_stream', object, outcome: test === 'signature' ? 'not_applicable' : 'passed',
    durationMs: 0, reason: test === 'signature' ? 'not_a_signed_source' : null, operator: null,
  })));
  const id = uuidv7();
  await inTx(cell.app, { orgId: cell.org }, async () => {
    const { rows } = await cell.app.query('select manifest_id from connect.connections where id = $1', [connectionId]);
    await cell.app.query(
      `insert into connect.conformance_runs (id, organisation_id, connection_id, manifest_id, suite_version, trigger, route, classes_run,
         results, passed_count, completed_at)
       values ($1, $2, $3, $4, 'fixture', 'manual', 'ai', '{change_stream}', $5, $6, now())`,
      [id, cell.org, connectionId, rows[0].manifest_id, JSON.stringify(tests), tests.filter((t) => t.outcome === 'passed').length]);
  });
  return id;
}
