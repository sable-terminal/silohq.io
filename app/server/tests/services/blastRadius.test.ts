// The blast radius walk (spec 43.7): before the preview, the records that reference what a
// mutation deletes, by the foreign keys the manifest declares. A reference the source
// cascades is a cascading delete and the walk goes on from it; any other is a dependent
// record, re-pointed on revert where its key is writable. The walk is bounded, and says at
// which hop it stopped; it holds references and counts, never values.

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { proposeActionType, publishActionTypeVersion } from '../../src/contracts/actions/actionType.contract.ts';
import { proposeMutation } from '../../src/contracts/actions/mutation.contract.ts';
import type { ServiceClient } from '../../src/infra/serviceClient.infra.ts';
import { createActionsService } from '../../src/routes/actions/index.route.ts';
import { service as approvalsService } from '../../src/routes/approvals/index.route.ts';
import { inTx, uuidv7 } from '../db/harness.helper.ts';
import type { Signed } from './connect.helper.ts';
import { createWritebackCell, freePort, type WritebackCell } from './writeback.helper.ts';

let wb: WritebackCell;
let gateway: ServiceClient;
let root: Signed;
let deleteOrder = '';
const keyed = (who: Signed) => ({ ...wb.cell.as(who), idempotencyKey: uuidv7() });

before(async () => {
  wb = await createWritebackCell({
    blast: true,
    start: async (cell) => {
      const [actionsPort, approvalsPort] = [await freePort(), await freePort()];
      await cell.start(createActionsService(), 'actions', 'test_app', { HTTP_PORT: String(actionsPort), SERVICE_URL_APPROVALS: `http://127.0.0.1:${approvalsPort}` });
      await cell.start(approvalsService, 'approvals', 'test_app', { HTTP_PORT: String(approvalsPort) });
    },
  });
  gateway = wb.gateway;
  root = wb.root;
  await wb.enableWrites(wb.sqlConnection);
  const type = await gateway.call(proposeActionType, { body: { apiName: 'delete_order', displayName: 'Delete order', owningScopeId: wb.cell.scopes['engineering']! } }, keyed(root));
  await gateway.call(publishActionTypeVersion, { params: { actionTypeId: type.id }, body: {
    ontologyVersionId: wb.ontologyVersionId, objectTypeId: wb.orderTypeId, rules: [{ kind: 'delete_object' }], permittedConnections: [wb.sqlConnection],
  } }, keyed(root));
  deleteOrder = type.id;
});

after(async () => {
  await wb?.close();
});

describe('the blast radius walk (spec 43.7)', () => {
  test('a delete reports what the source would cascade, hop by hop, and what it would leave pointing at nothing', async () => {
    const m = await gateway.call(proposeMutation, { body: { actionTypeId: deleteOrder, objects: [{ connectionId: wb.sqlConnection, reference: '1' }] } }, keyed(root));
    const radius = m.preview!.blastRadius;
    assert.equal(radius.computed, true);
    assert.equal(radius.hops, 2);
    assert.equal(radius.boundedAtHop, null, 'the walk ran to its end');
    assert.deepEqual(radius.counts, { dependent_record: 1, cascading_delete: 4, broken_relationship: 0, ontology_link: 0 });
    assert.deepEqual(radius.relationships!.map((r) => `${r.via}:${r.kind}:${r.count}`).sort(),
      ['line_notes.line_id:cascading_delete:2', 'order_lines.order_id:cascading_delete:2', 'shipments.order_id:dependent_record:1']);
    const { rows } = await inTx(wb.cell.app, { orgId: wb.cell.org }, () => wb.cell.app.query(
      `select kind, dependent_reference, via, hop, repointable from action.blast_radius_results where mutation_id = $1 order by hop, via, dependent_reference`, [m.id]));
    assert.deepEqual(rows.map((r) => `${r.hop}:${r.via}:${r.dependent_reference}:${r.repointable}`), [
      '1:order_lines.order_id:1:false', '1:order_lines.order_id:2:false', '1:shipments.order_id:1:true',
      '2:line_notes.line_id:1:false', '2:line_notes.line_id:2:false',
    ]);
    const { rows: events } = await inTx(wb.cell.app, { orgId: wb.cell.org }, () => wb.cell.app.query(
      `select payload->'detail' as d from platform.outbox where organisation_id = $1 and payload->>'event' = 'blast_radius_computed'
       and payload->'resource'->>'id' = $2`, [wb.cell.org, m.id]));
    assert.deepEqual([events[0]!.d.dependants, events[0]!.d.cascading], [5, 4]);
  });

  test('past its bound the walk says so, and at which hop', async () => {
    const m = await gateway.call(proposeMutation, { body: { actionTypeId: deleteOrder, objects: [{ connectionId: wb.sqlConnection, reference: '2' }] } }, keyed(root));
    const radius = m.preview!.blastRadius;
    assert.equal(radius.boundedAtHop, 1);
    const lines = radius.relationships!.find((r) => r.via === 'order_lines.order_id')!;
    assert.deepEqual([lines.count, lines.bounded], [100, true]);
  });

  test('a record nothing references has a complete radius: each relationship checked, none touched', async () => {
    const m = await gateway.call(proposeMutation, { body: { actionTypeId: deleteOrder, objects: [{ connectionId: wb.sqlConnection, reference: '5' }] } }, keyed(root));
    const radius = m.preview!.blastRadius;
    assert.deepEqual([radius.computed, radius.boundedAtHop, radius.hops], [true, null, 0]);
    assert.deepEqual(radius.relationships!.map((r) => `${r.via}:${r.count}`).sort(), ['order_lines.order_id:0', 'shipments.order_id:0']);
  });
});
