// Change windows and freezes in the customer's cell (spec 11.5, 11.6): on a dedicated cell a
// super admin sets the windows, the change authority and freezes (org.change_window.manage);
// only the named change authority approves a security fix during a freeze, in writing; each is
// audited as change_freeze_set; the cell's Fleet agent reads every organisation's policy in
// fleet-control's own shape. A shared cell has none.

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import {
  approveFreezeException, endChangeFreeze, getChangePolicy, listChangePoliciesForFleet, setChangeFreeze, setChangePolicy,
} from '../../src/contracts/policy/changePolicy.contract.ts';
import { cellChangePolicy } from '../../src/contracts/fleet-control/rollout.contract.ts';
import { uuidv7 } from '../db/harness.helper.ts';
import { startPolicyCell, type PolicyCell, type Signed } from './policy.helper.ts';

const HOUR = 3_600_000;
const later = (hours: number): string => new Date(Date.now() + hours * HOUR).toISOString();

describe('change windows and freezes on a dedicated cell (spec 11.5)', () => {
  let cell: PolicyCell;
  let root: Signed;
  let authority: Signed;
  let other: Signed;

  before(async () => {
    cell = await startPolicyCell({ cellKind: 'dedicated' });
    root = await cell.signIn('root@acme.example');
    authority = await cell.join(root, 'cab@acme.example', 'Member');
    other = await cell.join(root, 'dev@acme.example', 'Member');
  });
  after(async () => cell?.close());

  test('a super admin sets the windows and names the change authority; a member reads them and may not set them', async () => {
    const empty = await cell.call(getChangePolicy, {}, other);
    assert.deepEqual([empty.applies, empty.windows, empty.changeAuthorityMembershipId, empty.updatedAt], [true, [], null, null]);
    const body = { timeZone: 'Europe/London', windows: [{ day: 6, start: '02:00', end: '06:00' }], changeAuthorityMembershipId: authority.membershipId };
    await assert.rejects(cell.call(setChangePolicy, { body }, other), { code: 'policy.not_permitted' });
    await assert.rejects(cell.call(setChangePolicy, { body: { ...body, changeAuthorityMembershipId: uuidv7() } }, root), { code: 'policy.change_authority_unknown' });
    await assert.rejects(cell.call(setChangePolicy, { body: { ...body, timeZone: 'Mars/Olympus' } }, root), { code: 'contract.request_invalid' });
    const set = await cell.call(setChangePolicy, { body }, root);
    assert.deepEqual([set.windows, set.changeAuthorityMembershipId], [body.windows, authority.membershipId]);
    assert.ok(set.updatedAt !== null);
  });

  test('a freeze is set and audited; only the named change authority approves a fix in it; the agent reads it all in fleet-control\'s shape', async () => {
    const freezeId = uuidv7();
    const body = { startsAt: later(-1), endsAt: later(24 * 30), reason: 'quarter end' };
    const freeze = await cell.call(setChangeFreeze, { params: { freezeId }, body }, root);
    assert.deepEqual(freeze.freezes.map((f) => f.id), [freezeId]);
    assert.equal((await cell.call(setChangeFreeze, { params: { freezeId }, body }, root)).freezes.length, 1, 'the same freeze again changes nothing');
    await assert.rejects(cell.call(setChangeFreeze, { params: { freezeId }, body: { ...body, reason: 'other' } }, root), { code: 'policy.freeze_exists' });
    const audited = await cell.events('change_freeze_set');
    assert.deepEqual([audited.at(-1)!.detail['action'], audited.at(-1)!.resource], ['set', { type: 'change_freeze', id: freezeId }]);
    await assert.rejects(cell.call(setChangeFreeze, { params: { freezeId: uuidv7() }, body: { startsAt: later(-48), endsAt: later(-24), reason: 'past' } }, root),
      { code: 'policy.freeze_over' });

    const approval = { freezeId, releaseId: 'r2026.11.16', statement: 'Approved by the change advisory board: CVE-2026-0002 fix.' };
    await assert.rejects(cell.call(approveFreezeException, { body: approval }, other), { code: 'policy.not_change_authority' });
    await assert.rejects(cell.call(approveFreezeException, { body: approval }, root), { code: 'policy.not_change_authority' },
      'not even a super admin: the named authority alone');
    const approved = await cell.call(approveFreezeException, { body: approval }, authority);
    assert.deepEqual(approved.exceptions.map((e) => [e.releaseId, e.approvedBy]), [['r2026.11.16', authority.membershipId]]);
    assert.equal((await cell.call(approveFreezeException, { body: approval }, authority)).exceptions.length, 1, 'the same approval again changes nothing');
    assert.equal((await cell.events('change_freeze_set')).at(-1)!.detail['action'], 'exception_approved');

    const { policies } = await cell.policyAs('fleet-control').call(listChangePoliciesForFleet, {});
    assert.equal(policies.length, 1);
    const carried = cellChangePolicy.parse(policies[0]);
    assert.deepEqual([carried.organisationId, carried.changeAuthorityMembershipId, carried.windows], [cell.org, authority.membershipId,
      [{ day: 6, start: '02:00', end: '06:00' }]]);
    assert.deepEqual(carried.freezes.map((f) => [f.id, f.reason]), [[freezeId, 'quarter end']]);
    assert.deepEqual(carried.exceptions.map((e) => [e.freezeId, e.releaseId, e.approvedBy]), [[freezeId, 'r2026.11.16', authority.membershipId]]);

    const ended = await cell.call(endChangeFreeze, { params: { freezeId } }, root);
    assert.deepEqual([ended.freezes, ended.exceptions], [[], []], 'an ended freeze is over, with its approvals');
    assert.equal((await cell.events('change_freeze_set')).at(-1)!.detail['action'], 'ended');
    assert.deepEqual(cellChangePolicy.parse((await cell.policyAs('fleet-control').call(listChangePoliciesForFleet, {})).policies[0]).freezes, []);
    await assert.rejects(cell.call(approveFreezeException, { body: approval }, authority), { code: 'policy.freeze_over' });
  });
});

describe('a shared cell has no change policy', () => {
  let cell: PolicyCell;
  let root: Signed;
  before(async () => {
    cell = await startPolicyCell();
    root = await cell.signIn('root@acme.example');
  });
  after(async () => cell?.close());

  test('it reads as not applying, and the setters refuse', async () => {
    assert.equal((await cell.call(getChangePolicy, {}, root)).applies, false);
    await assert.rejects(cell.call(setChangePolicy, { body: { timeZone: 'Europe/London', windows: [], changeAuthorityMembershipId: null } }, root),
      { code: 'policy.change_windows_not_applicable' });
  });
});
