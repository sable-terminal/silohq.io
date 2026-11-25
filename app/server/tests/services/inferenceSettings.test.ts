// The organisation's inference switches (decision 2026-11-11; D71): all off at first; set by
// org.inference.manage only (a super admin holds it), audited with what changed.

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { getInferenceSettings, setInferenceSettings } from '../../src/contracts/policy/inference.contract.ts';
import { inTx } from '../db/harness.helper.ts';
import { createConnectCell, type ConnectCell, type Signed } from './connect.helper.ts';

let cell: ConnectCell;
let root: Signed;
let member: Signed;

before(async () => {
  cell = await createConnectCell();
  root = await cell.signIn('root@acme.example');
  member = await cell.member('member@acme.example', 'Member');
});

after(async () => {
  await cell?.close();
});

describe('inference switches (D71)', () => {
  test('off until a holder of org.inference.manage turns one on; each change audited', async () => {
    const gateway = cell.client('gateway');
    assert.deepEqual(await gateway.call(getInferenceSettings, {}, cell.as(member)), { simulation: false, resolution: false, links: false, findings: false });
    await assert.rejects(gateway.call(setInferenceSettings, { body: { simulation: true } }, cell.as(member)), { category: 'forbidden' });
    assert.deepEqual(await gateway.call(setInferenceSettings, { body: { simulation: true, findings: true } }, cell.as(root)),
      { simulation: true, resolution: false, links: false, findings: true });
    const { rows } = await inTx(cell.app, { orgId: cell.org }, () => cell.app.query(
      `select payload->'detail' as d from platform.outbox where organisation_id = $1 and payload->>'event' = 'inference_settings_changed'`, [cell.org]));
    assert.deepEqual(rows.map((r) => r.d.changed), ['simulation,findings']);
  });
});
