// KEK rotation (spec 61.1, 61.2, 61.9): started by staff holding key.rotate, naming a new key in
// the cell's provider; every sealed row's DEK re-wrapped under the new version without its
// ciphertext opened; the old version retired once nothing references it; the events in each
// organisation's audit log. A connection's secret replacing a live one is a rotation of it.

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { setConnectionSecrets } from '../../src/contracts/connect-registry/connection.contract.ts';
import { readObject } from '../../src/contracts/connect-runtime/read.contract.ts';
import { readKeyRotation, startKeyRotation } from '../../src/contracts/credential/keyRotation.contract.ts';
import { inTx, uuidv7 } from '../db/harness.helper.ts';
import { startRecognitionCell, type RecognitionCell } from './recognition.helper.ts';

let rc: RecognitionCell;

before(async () => {
  rc = await startRecognitionCell([]);
});

after(async () => {
  await rc?.close();
});

const events = async (name: string) => (await inTx(rc.cell.app, { orgId: rc.cell.org }, () => rc.cell.app.query(
  `select payload->'detail' as detail from platform.outbox where organisation_id = $1 and payload->>'event' = $2 order by created_at`, [rc.cell.org, name],
))).rows.map((r) => r.detail as Record<string, unknown>);

async function until<T>(what: string, check: () => Promise<T | undefined>, ms = 40_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const found = await check();
    if (found !== undefined) return found;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

const readSuppliers = () => rc.cell.client('executor').call(readObject, { body: { connectionId: rc.crm, reason: 'query', step: { object: 'suppliers' } } }, rc.cell.as(rc.root));

describe('KEK rotation (spec 61.2)', () => {
  test('every sealed secret is re-wrapped under the new version and still opens; the old version is retired; each organisation is told', async () => {
    assert.equal((await readSuppliers()).rows.length > 0, true);
    const staff = rc.cell.client('admin-portal');
    const operatorId = uuidv7();
    await assert.rejects(staff.call(startKeyRotation, { body: { keyUri: 'vault-transit:nowhere', operatorId } }, {}), { code: 'kms.rotation_key_unusable' },
      'a key that is not in the provider is refused: Silo never creates one');
    const started = await staff.call(startKeyRotation, { body: { keyUri: 'local:kek-2', operatorId } }, {});
    assert.ok(started.previousKeyVersionId !== null);
    await assert.rejects(staff.call(startKeyRotation, { body: { keyUri: 'local:kek-3', operatorId } }, {}), { code: 'kms.rotation_in_progress' });

    const done = await until('the rotation to complete', async () => {
      const { versions } = await staff.call(readKeyRotation, {}, {});
      return versions.some((v) => v.status === 'decrypt_only') ? undefined : versions;
    });
    assert.deepEqual(done.map((v) => [v.id, v.status]), [[started.keyVersionId, 'active']]);
    const { rows: [old] } = await rc.cell.migrate.query('select status, retired_at from iam.kms_key_versions where id = $1', [started.previousKeyVersionId]);
    assert.equal(old.status, 'retired');
    const { rows: wrapped } = await rc.cell.migrate.query(
      `select distinct key_version_id from connect.connection_credentials where revoked_at is null and dek_wrapped is not null`);
    assert.deepEqual(wrapped.map((r) => r.key_version_id), [started.keyVersionId], 'every live secret under the new version');
    assert.equal((await readSuppliers()).rows.length > 0, true, 'and it still opens');

    assert.deepEqual((await events('key_rotation_started')).map((d) => [d['key_version_id'], d['previous_key_version_id'], d['operator_id']]),
      [[started.keyVersionId, started.previousKeyVersionId, operatorId]]);
    assert.deepEqual((await events('key_version_retired')).map((d) => d['key_version_id']), [started.previousKeyVersionId]);
    assert.deepEqual((await events('key_rotation_completed')).map((d) => d['retired_key_version_id']), [started.previousKeyVersionId]);
  });

  test('a connection\'s secret replacing a live one is recorded as its rotation (spec 61.9)', async () => {
    await rc.gateway.call(setConnectionSecrets, { params: { connectionId: rc.crm }, body: { values: { token: 'tok_valid' } } }, rc.cell.as(rc.root));
    assert.ok((await events('credential_rotated')).some((d) => d['connection_id'] === rc.crm && d['field'] === 'token'));
    assert.equal((await readSuppliers()).rows.length > 0, true);
  });
});
