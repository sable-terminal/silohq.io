// The cell's synthetic organisation (spec 11.2; decision 2026-11-18): made once, at the Fleet
// agent's asking only, on the enterprise plan, with two members each a Super admin, never in a
// login; their sessions minted complete for the agent, and resolved as any member's.

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { resolveSession } from '../../src/contracts/auth/session.contract.ts';
import { issueSyntheticSession, provisionSyntheticTenant } from '../../src/contracts/auth/synthetic.contract.ts';
import { inTx } from '../db/harness.helper.ts';
import { createConnectCell, type ConnectCell } from './connect.helper.ts';

let cell: ConnectCell;

before(async () => {
  cell = await createConnectCell();
});

after(async () => {
  await cell?.close();
});

describe('the synthetic organisation (spec 11.2)', () => {
  test('made once, for the Fleet agent alone; two Super admin members; asking again returns it', async () => {
    await assert.rejects(cell.client('gateway').call(provisionSyntheticTenant, {}), { code: 'caller.not_listed' });
    const agent = cell.client('fleet-control');
    const made = await agent.call(provisionSyntheticTenant, {});
    assert.equal(made.created, true);
    const again = await agent.call(provisionSyntheticTenant, {});
    assert.deepEqual({ ...again, created: true }, made, 'one synthetic organisation a cell');
    const { rows } = await inTx(cell.app, { orgId: made.organisationId }, () => cell.app.query(
      `select o.is_synthetic, o.plan, count(ra.id)::int as supers
         from iam.organisations o join iam.role_assignments ra on ra.organisation_id = o.id
         join iam.roles r on r.id = ra.role_id and r.name = 'Super admin'
        where o.id = $1 group by o.is_synthetic, o.plan`, [made.organisationId]));
    assert.deepEqual(rows[0], { is_synthetic: true, plan: 'enterprise', supers: 2 });
    const login = await cell.migrate.query('select * from iam.find_organisation_for_login($1)', [made.slug]);
    assert.equal(login.rows.length, 0, 'no one signs in to it');
  });

  test('a member\'s session is minted complete for the agent and resolves as any member\'s', async () => {
    const agent = cell.client('fleet-control');
    const { members } = await agent.call(provisionSyntheticTenant, {});
    const minted = await agent.call(issueSyntheticSession, { body: { member: 'approver' } });
    assert.equal(minted.membershipId, members.approver);
    const session = await cell.client('gateway').call(resolveSession, { body: { sessionToken: minted.sessionToken, activity: 'http_request' } });
    assert.deepEqual([session.membershipId, session.authMethod, session.mfa], [members.approver, 'synthetic', 'satisfied']);
    assert.ok(Date.parse(session.absoluteExpiresAt) - Date.now() <= 30 * 60_000 + 5_000, 'it lasts one round of the tests');
  });
});
