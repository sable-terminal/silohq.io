// Removal's effect on owned connections (spec 55.7): a member who owns a connection is removed;
// the connection goes to the admin above its owning scope, or a super admin where there is
// none, recorded as connection_ownership_transferred; the removed member reaches it no more.

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { createConnection, getConnection } from '../../src/contracts/connect-registry/connection.contract.ts';
import { createConnector, createManifestVersion } from '../../src/contracts/connect-registry/connector.contract.ts';
import { transferOwnedConnections } from '../../src/contracts/connect-registry/ownership.contract.ts';
import { removeMember } from '../../src/contracts/policy/admin.contract.ts';
import type { ServiceClient } from '../../src/infra/serviceClient.infra.ts';
import { inTx, uuidv7 } from '../db/harness.helper.ts';
import { createConnectCell, restManifest, type ConnectCell, type Signed } from './connect.helper.ts';

let cell: ConnectCell;
let gateway: ServiceClient;
let root: Signed;
let leaver: Signed;
const keyed = (who: Signed) => ({ ...cell.as(who), idempotencyKey: uuidv7() });

before(async () => {
  cell = await createConnectCell();
  gateway = cell.client('gateway');
  root = await cell.signIn('root@acme.example');
  leaver = await cell.member('leaver@acme.example', 'Member');
});

after(async () => {
  await cell?.close();
});

describe('a removed member\'s connections (spec 55.7)', () => {
  test('go to the admin above the owning scope, or a super admin; the transfer is audited', async () => {
    const connector = await gateway.call(createConnector, { body: { slug: 'crm', name: 'CRM', provider: 'Example', sourceRoute: 'visual' } }, keyed(root));
    await gateway.call(createManifestVersion, { params: { connectorId: connector.id }, body: { document: restManifest({ baseUrl: 'https://api.example.com' }) } }, keyed(root));
    const connection = await gateway.call(createConnection, {
      body: { connectorId: connector.id, name: 'Leaver CRM', owningScopeId: cell.scopes['engineering']! },
    }, keyed(leaver));
    const owner = async () => (await inTx(cell.app, { orgId: cell.org }, () => cell.app.query(
      'select owning_membership_id as o from connect.connections where id = $1', [connection.id]))).rows[0]!.o as string;
    assert.equal(await owner(), leaver.membershipId);
    await cell.client('gateway').call(removeMember, { params: { membershipId: leaver.membershipId } }, cell.as(root));
    // Policy makes this call in the removal; in this cell policy starts before connect-registry, so the test makes it as policy.
    await assert.rejects(gateway.call(transferOwnedConnections, { body: { membershipId: leaver.membershipId } }, cell.as(root)), { code: 'caller.not_listed' });
    const result = await cell.client('policy').call(transferOwnedConnections, { body: { membershipId: leaver.membershipId } }, cell.as(root));
    assert.equal(result.transferred.length, 1);
    const to = await owner();
    assert.notEqual(to, leaver.membershipId, 'the removed member owns it no more');
    const { rows: held } = await inTx(cell.app, { orgId: cell.org }, () => cell.app.query(
      `select exists (select 1 from iam.role_assignments ra join iam.role_permissions rp on rp.organisation_id = ra.organisation_id and rp.role_id = ra.role_id
         where ra.membership_id = $1 and ra.revoked_at is null and rp.permission_id = 'admin.delegate') as admin`, [to]));
    assert.equal(held[0]!.admin, true, 'it went to an admin');
    const { rows } = await inTx(cell.app, { orgId: cell.org }, () => cell.app.query(
      `select payload->'detail' as d from platform.outbox where organisation_id = $1 and payload->>'event' = 'connection_ownership_transferred'`, [cell.org]));
    assert.deepEqual(rows.map((r) => [r.d.from_membership_id, r.d.to_membership_id]), [[leaver.membershipId, to]]);
    assert.equal((await gateway.call(getConnection, { params: { connectionId: connection.id } }, cell.as(root))).id, connection.id);
  });
});
