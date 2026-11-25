// credential_unwrapped (spec 61.9, 77; D207): every unwrap of a secret is recorded in
// iam.credential_unwraps, its system of record, and read back through audit as the
// credential_unwrapped trail the Governance page unions with the audit events: the
// credential, reason, calling service and correlation, never a value; an organisation-wide
// holder of audit.read only.

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { listCredentialUnwraps } from '../../src/contracts/audit/read.contract.ts';
import { readObject } from '../../src/contracts/connect-runtime/read.contract.ts';
import { createAuditService } from '../../src/routes/audit/index.route.ts';
import { uuidv7 } from '../db/harness.helper.ts';
import { LOCAL } from '../infra/services.helper.ts';
import { createWritebackCell, type WritebackCell } from './writeback.helper.ts';

let wb: WritebackCell;

before(async () => {
  wb = await createWritebackCell({
    start: async (cell) => {
      await cell.start(createAuditService({ consumer: `unwraps-${uuidv7().slice(-8)}` }), 'audit', 'test_audit_service' as never,
        { DURABLE_BUS: 'jetstream', NATS_DURABLE_URL: LOCAL.natsUrl });
    },
  });
});

after(async () => {
  await wb?.close();
});

describe('the credential_unwrapped trail (spec 61.9)', () => {
  test('each unwrap is read back with its credential, reason and caller; filtered and paged; no value anywhere', async () => {
    // A read through the CRM connection opens its token in the credential service.
    await wb.cell.client('executor').call(readObject, { body: { connectionId: wb.restConnection, reason: 'query', step: { object: 'contacts' } } },
      wb.cell.as(wb.root));
    const { rows: [credential] } = await wb.cell.migrate.query(
      `select id from connect.connection_credentials where connection_id = $1 and field_name = 'token' order by created_at desc limit 1`, [wb.restConnection]);
    const all = await wb.gateway.call(listCredentialUnwraps, { query: { credentialId: credential.id } }, wb.cell.as(wb.root));
    assert.ok(all.unwraps.length >= 1, 'the token was unwrapped and recorded');
    const first = all.unwraps[0]!;
    assert.deepEqual([first.event, first.credential, first.outcome], ['credential_unwrapped', { kind: 'connection_credential', id: credential.id }, 'ok']);
    assert.match(first.callingService, /^[a-z][a-z0-9-]*$/);
    assert.ok(!JSON.stringify(all).includes('test-token'), 'never the value');

    const byReason = await wb.gateway.call(listCredentialUnwraps, { query: { reason: first.reason } }, wb.cell.as(wb.root));
    assert.ok(byReason.unwraps.every((u) => u.reason === first.reason));
    const one = await wb.gateway.call(listCredentialUnwraps, { query: { limit: 1 } }, wb.cell.as(wb.root));
    if (one.nextCursor !== null) {
      const next = await wb.gateway.call(listCredentialUnwraps, { query: { limit: 1, cursor: one.nextCursor } }, wb.cell.as(wb.root));
      assert.notEqual(next.unwraps[0]?.id, one.unwraps[0]!.id, 'the next page starts after the last');
    }
    await assert.rejects(wb.gateway.call(listCredentialUnwraps, { query: { cursor: 'bm9wZQ' } }, wb.cell.as(wb.root)), { code: 'audit.cursor_invalid' });
  });

  test('a member without audit.read is refused', async () => {
    const member = await wb.cell.member('nosy@acme.example', 'Member');
    await assert.rejects(wb.gateway.call(listCredentialUnwraps, { query: {} }, wb.cell.as(member)), { code: 'audit.not_permitted' });
  });
});
