// Governance end to end (spec 57.3 to 57.7, 58, 60.4 to 60.6): credential, auth and policy
// as real processes, with the schema this fork proposes applied (policy.helper.ts).
// Connections are reached only through live grants passed on within a subtree; markings
// close the mandatory gate until a clearance or a purpose session satisfies them; field
// policies narrow fields before any plan exists; a service principal executes within its
// own grants and its owner's, never authorising.

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { createRole, createScope, createScopeType, grantRole, reinstateMember, removeMember, suspendMember } from '../../src/contracts/policy/admin.contract.ts';
import { authorise, declassificationDecision, resolveAccess } from '../../src/contracts/policy/decision.contract.ts';
import {
  applyMarking, approvePurposeDefinition, approvePurposeSession, createFieldPolicy, createMarking, createPurposeDefinition, createServicePrincipal, declarePurpose,
  endPurposeSession, grantClearance, grantConnection, grantPrincipalRole, grantPurposeEligibility, listConnectionGrants, listPurposeEligibility, listMarkings,
  revokeClearance, revokeConnectionGrant, revokeServicePrincipal, setPurposeDefinitionStatus,
} from '../../src/contracts/policy/governance.contract.ts';
import type { CallInput } from '../../src/contracts/endpoint.contract.ts';
import { inTx, uuidv7 } from '../db/harness.helper.ts';
import { startPolicyCell, type PolicyCell, type Signed } from './policy.helper.ts';

let cell: PolicyCell;
let root: Signed;
let ann: Signed;
let eve: Signed;
let olly: Signed;
let max: Signed;
let sam: Signed;
const scopes: Record<string, string> = {};
const connections: Record<string, string> = {};
let objectType: string;

const access = (who: Signed, body: NonNullable<CallInput<typeof resolveAccess>['body']>) => cell.call(resolveAccess, { body }, who);
const accessTo = async (who: Signed, connectionId: string, purposeSessionIds?: string[]) =>
  (await access(who, { connections: [connectionId], ...(purposeSessionIds ? { purposeSessionIds } : {}) })).connections[0]!.access;

async function connection(name: string, owner: Signed, scopeId: string): Promise<string> {
  const [connector, manifest, id] = [uuidv7(), uuidv7(), uuidv7()];
  await inTx(cell.app, { orgId: cell.org }, async () => {
    await cell.app.query(`insert into connect.connectors (id, organisation_id, kind, slug, name, provider, trust_tier, source_route,
      author_organisation_id, created_by_membership_id) values ($1, $2, 'private', $3, $4, 'example', 'private', 'ai', $2, $5)`,
    [connector, cell.org, `c-${id.slice(-8)}`, name, owner.membershipId]);
    await cell.app.query(`insert into connect.connector_manifests (id, organisation_id, connector_id, version, document, document_hash,
      schema_version, source_route, created_by_membership_id) values ($1, $2, $3, '1.0.0', '{}', $4, '1', 'ai', $5)`,
    [manifest, cell.org, connector, Buffer.alloc(32), owner.membershipId]);
    await cell.app.query(`insert into connect.connections (id, organisation_id, connector_id, manifest_id, name, provider, trust_tier,
      owning_scope_id, owning_membership_id, created_by) values ($1, $2, $3, $4, $5, 'example', 'private', $6, $7, $7)`,
    [id, cell.org, connector, manifest, name, scopeId, owner.membershipId]);
  });
  return id;
}

before(async () => {
  cell = await startPolicyCell();
  root = await cell.signIn('root@acme.example');
  const type = (await cell.call(createScopeType, { body: { name: 'Department' } }, root)).id;
  for (const [name, parent] of [['engineering', undefined], ['sales', undefined], ['platform', 'engineering']] as const) {
    scopes[name] = (await cell.call(createScope, { body: { name, scopeTypeId: type, ...(parent ? { parentScopeId: scopes[parent] } : {}) } }, root)).id;
  }
  ann = await cell.join(root, 'ann@acme.example', 'Super admin');
  eve = await cell.join(root, 'eve@acme.example', 'Admin', scopes['engineering']);
  olly = await cell.join(root, 'olly@acme.example', 'Member', scopes['engineering']);
  max = await cell.join(root, 'max@acme.example', 'Member', scopes['platform']);
  sam = await cell.join(root, 'sam@acme.example', 'Member', scopes['sales']);
  connections['crm'] = await connection('CRM', olly, scopes['engineering']!);
  connections['ledger'] = await connection('Ledger', sam, scopes['sales']!);
  objectType = uuidv7();
  await inTx(cell.app, { orgId: cell.org }, () => cell.app.query(
    `insert into ontology.object_types (id, organisation_id, api_name, created_by_membership_id) values ($1, $2, 'employee', $3)`,
    [objectType, cell.org, olly.membershipId]));
});

after(async () => {
  await cell?.close();
});

describe('connection grants (spec 57.3, 56.7 rule 6, 56.8)', () => {
  test('default deny: nobody but its owner reaches a connection until it is granted', async () => {
    assert.equal(await accessTo(max, connections['crm']!), 'none');
    assert.equal(await accessTo(olly, connections['crm']!), 'write');
    const fields = await access(max, { fields: [{ connectionId: connections['crm']!, path: 'email' }] });
    assert.equal(fields.fields[0]!.effect, 'deny', 'a field of an unreachable connection is denied with it');
  });

  test('the owner passes it on within the owning scope; a grantee outside it is refused by the database rule', async () => {
    const grant = await cell.call(grantConnection, { body: { connectionId: connections['crm']!, grantee: { kind: 'scope', id: scopes['platform']! }, access: 'read' } }, olly);
    assert.equal(grant.grantedAtScopeId, scopes['engineering']);
    assert.equal(await accessTo(max, connections['crm']!), 'read');
    const again = await cell.call(grantConnection, { body: { connectionId: connections['crm']!, grantee: { kind: 'scope', id: scopes['platform']! }, access: 'read' } }, olly);
    assert.equal(again.id, grant.id, 'the same grant again changes nothing');
    await assert.rejects(cell.call(grantConnection, { body: { connectionId: connections['crm']!, grantee: { kind: 'membership', id: sam.membershipId }, access: 'read' } }, olly),
      { category: 'forbidden', code: 'connection_grant.refused' });
    assert.ok((await cell.events('connection_granted')).some((e) => e.resource?.id === connections['crm'] && e.detail['grantee_kind'] === 'scope'));
  });

  test('an admin passes on only connections they hold there; a role grant is a super admin\'s', async () => {
    await assert.rejects(cell.call(grantConnection, { body: { connectionId: connections['ledger']!, grantee: { kind: 'scope', id: scopes['platform']! }, access: 'read' } }, eve),
      (error: { code?: string; message?: string }) => error.code === 'connection_grant.refused' && /does not hold/.test(error.message ?? ''));
    await assert.rejects(cell.call(grantConnection, { body: { connectionId: connections['crm']!, grantee: { kind: 'role', id: cell.roles['Member']! }, access: 'read' } }, eve),
      { code: 'connection_grant.refused' });
    const roleGrant = await cell.call(grantConnection, { body: { connectionId: connections['ledger']!, grantee: { kind: 'role', id: cell.roles['Member']! }, access: 'read' } }, root);
    assert.equal(roleGrant.grantedAtScopeId, null);
    assert.equal(await accessTo(max, connections['ledger']!), 'read', 'every holder of the role');
    await cell.call(revokeConnectionGrant, { params: { grantId: roleGrant.id } }, root);
    assert.equal(await accessTo(max, connections['ledger']!), 'none', 'the next request sees the revocation');
  });

  test('a grant without descendants reaches that node only', async () => {
    await cell.call(grantConnection, { body: { connectionId: connections['crm']!, grantee: { kind: 'scope', id: scopes['engineering']! }, access: 'write',
      includeDescendants: false } }, olly);
    assert.equal(await accessTo(eve, connections['crm']!), 'write', 'eve sits in Engineering itself');
    assert.equal(await accessTo(max, connections['crm']!), 'read', 'max, in Platform beneath it, keeps only the read grant');
  });

  test('revocation by the issuer, an admin over where it was issued, or a super admin', async () => {
    const grant = await cell.call(grantConnection, { body: { connectionId: connections['crm']!, grantee: { kind: 'membership', id: max.membershipId }, access: 'write' } }, olly);
    await assert.rejects(cell.call(revokeConnectionGrant, { params: { grantId: grant.id } }, sam), { code: 'connection_grant.revoke_refused' });
    assert.ok((await cell.call(revokeConnectionGrant, { params: { grantId: grant.id } }, eve)).revokedAt);
    const listed = await cell.call(listConnectionGrants, { query: { connectionId: connections['crm']! } }, olly);
    assert.ok(listed.grants.every((g) => g.revokedAt === null));
    await assert.rejects(cell.call(listConnectionGrants, { query: { connectionId: connections['crm']! } }, sam), { code: 'policy.not_permitted' });
  });
});

describe('markings and clearances: the mandatory gate (spec 57.5, 57.7, 58.2 to 58.4)', () => {
  let hr: string;

  test('a marking on a connection closes it to everyone uncleared, whatever their grants', async () => {
    hr = (await cell.call(createMarking, { body: { name: 'HR-Confidential', kind: 'classification', rank: 2 } }, root)).id;
    await assert.rejects(cell.call(createMarking, { body: { name: 'Mine', kind: 'compartment' } }, eve), { code: 'policy.not_permitted' });
    assert.equal(await accessTo(max, connections['crm']!), 'read');
    const applied = await cell.call(applyMarking, { body: { markingId: hr, resource: { type: 'connection', id: connections['crm']! } } }, root);
    assert.equal(applied.applied, true);
    assert.equal(await accessTo(max, connections['crm']!), 'none');
    assert.equal(await accessTo(olly, connections['crm']!), 'none', 'even its owner');
    const decision = await cell.call(authorise, { body: { permission: 'ontology.view', resource: { type: 'connection', id: connections['crm']! } } }, max);
    assert.deepEqual(decision, { decision: 'deny', reason: 'marking_unsatisfied' });
  });

  test('a clearance satisfies it on the next request; revoking it closes it again', async () => {
    await assert.rejects(cell.call(grantClearance, { body: { markingId: hr, holder: { kind: 'membership', id: max.membershipId } } }, eve),
      { code: 'policy.not_permitted' }, 'clearance.grant is a super admin\'s, never delegable');
    const clearance = await cell.call(grantClearance, { body: { markingId: hr, holder: { kind: 'membership', id: max.membershipId } } }, root);
    assert.equal(await accessTo(max, connections['crm']!), 'read');
    assert.deepEqual((await cell.call(listMarkings, { query: {} }, max)).markings.map((m) => m.name), ['HR-Confidential'], 'a holder sees it');
    assert.deepEqual((await cell.call(listMarkings, { query: {} }, sam)).markings, [], 'others do not');
    await cell.call(revokeClearance, { params: { clearanceId: clearance.id } }, root);
    assert.equal(await accessTo(max, connections['crm']!), 'none');
    await cell.call(grantClearance, { body: { markingId: hr, holder: { kind: 'membership', id: max.membershipId } } }, root);
  });

  test('object types are markable: an unsatisfied marking hides the type (spec 57.7)', async () => {
    const programme = (await cell.call(createMarking, { body: { name: 'Falcon', kind: 'compartment' } }, root)).id;
    assert.equal((await access(max, { objectTypes: [objectType] })).objectTypes[0]!.visible, true);
    await cell.call(applyMarking, { body: { markingId: programme, resource: { type: 'object_type', id: objectType } } }, root);
    assert.equal((await access(max, { objectTypes: [objectType] })).objectTypes[0]!.visible, false);
    assert.equal((await cell.call(authorise, { body: { permission: 'ontology.view', resource: { type: 'object_type', id: objectType } } }, max)).reason,
      'marking_unsatisfied');
    assert.ok((await cell.events('object_type_marking_changed')).some((e) => e.resource?.id === objectType));
  });

  test('an admin applies only markings they hold, only within their subtree', async () => {
    // The seeded Admin role carries no marking.manage; an organisation gives it to its stewards.
    const stewards = await cell.call(createRole, { body: { name: 'Stewards', permissions: ['marking.manage'] } }, root);
    await cell.call(grantRole, { body: { membershipId: eve.membershipId, roleId: stewards.id, scopeId: scopes['engineering']! } }, root);
    const other = (await cell.call(createMarking, { body: { name: 'Board', kind: 'compartment' } }, root)).id;
    await assert.rejects(cell.call(applyMarking, { body: { markingId: other, resource: { type: 'connection', id: connections['crm']! } } }, eve),
      { code: 'marking.not_held' });
    await assert.rejects(cell.call(applyMarking, { body: { markingId: other, resource: { type: 'connection', id: connections['ledger']! } } }, eve),
      { code: 'policy.not_permitted' });
  });
});

describe('purposes (spec 58.5)', () => {
  let payroll: string;
  let definition: { id: string; version: number };

  test('a removed member\'s purpose definitions transfer to a super admin, recorded (spec 55.7, 55.8)', async () => {
    const pam = await cell.join(root, 'pam@acme.example', 'Super admin');
    const marking = (await cell.call(createMarking, { body: { name: 'Pam incident', kind: 'purpose' } }, pam)).id;
    const theirs = await cell.call(createPurposeDefinition, { body: { markingId: marking, name: 'Incident response', description: 'Major incidents',
      maxSessionMinutes: 60 } }, pam);
    await cell.call(removeMember, { params: { membershipId: pam.membershipId } }, root);
    const { rows: [row] } = await cell.migrate.query('select owner_membership_id, created_by from gov.purpose_definitions where id = $1', [theirs.id]);
    assert.ok([root.membershipId, ann.membershipId].includes(row.owner_membership_id), 'a super admin answers for it now');
    assert.equal(row.created_by, pam.membershipId, 'who created it stays recorded');
    const moved = (await cell.events('object_ownership_transferred')).filter((e) => e.resource?.id === theirs.id);
    assert.deepEqual(moved.map((e) => [e.detail['object_kind'], e.detail['from_membership_id'], e.detail['to_membership_id']]),
      [['purpose_definition', pam.membershipId, row.owner_membership_id]]);
  });

  test('a purpose is approved by someone other than its author', async () => {
    payroll = (await cell.call(createMarking, { body: { name: 'Payroll', kind: 'purpose' } }, root)).id;
    const created = await cell.call(createPurposeDefinition, { body: { markingId: payroll, name: 'Payroll run', description: 'Monthly payroll',
      maxSessionMinutes: 30 } }, root);
    await assert.rejects(cell.call(approvePurposeDefinition, { params: { purposeDefinitionId: created.id }, body: { version: created.version } }, root),
      { code: 'purpose.self_approval' });
    const approved = await cell.call(approvePurposeDefinition, { params: { purposeDefinitionId: created.id }, body: { version: created.version } }, ann);
    definition = { id: approved.id, version: approved.version };
    assert.equal(approved.status, 'approved');
    await assert.rejects(cell.call(grantClearance, { body: { markingId: payroll, holder: { kind: 'membership', id: max.membershipId } } }, root),
      { code: 'clearance.purpose_marking' });
  });

  test('purpose-marked data is reachable only within a declared session the request names', async () => {
    await cell.call(applyMarking, { body: { markingId: payroll, resource: { type: 'connection', id: connections['crm']! } } }, root);
    assert.equal(await accessTo(max, connections['crm']!), 'none', 'cleared for HR, but no purpose declared');
    await assert.rejects(cell.call(declarePurpose, { body: { purposeDefinitionId: definition.id, justification: 'March run' } }, max),
      { code: 'purpose.not_eligible' });
    const eligible = await cell.call(grantPurposeEligibility, { body: { purposeDefinitionId: definition.id, grantee: { kind: 'scope', id: scopes['engineering']! } } }, root);
    const listed = await cell.call(listPurposeEligibility, { params: { purposeDefinitionId: definition.id } }, root);
    assert.deepEqual(listed.eligibility.map((e) => [e.id, e.granteeScopeId, e.grantedBy]), [[eligible.id, scopes['engineering']!, root.membershipId]]);
    await assert.rejects(cell.call(listPurposeEligibility, { params: { purposeDefinitionId: definition.id } }, max), { code: 'policy.not_permitted' });
    await assert.rejects(cell.call(declarePurpose, { body: { purposeDefinitionId: definition.id } }, max), { code: 'purpose.justification_required' });
    const session = await cell.call(declarePurpose, { body: { purposeDefinitionId: definition.id, justification: 'March run', minutes: 10 } }, max);
    assert.ok(Date.parse(session.expiresAt) - Date.parse(session.declaredAt) <= 10 * 60_000);
    assert.equal(await accessTo(max, connections['crm']!, [session.id]), 'read');
    assert.equal(await accessTo(max, connections['crm']!), 'none', 'not without naming it');
    const otherSession = await cell.signIn('max@acme.example');
    assert.equal(await accessTo(otherSession, connections['crm']!, [session.id]), 'none', 'bound to the session it was declared in');
    assert.equal(await accessTo(sam, connections['crm']!, [session.id]), 'none', 'and to its declarer');
    await assert.rejects(cell.call(declarePurpose, { body: { purposeDefinitionId: definition.id, justification: 'x' } }, sam), { code: 'purpose.not_eligible' });
    assert.ok((await cell.events('purpose_session_declared')).some((e) => e.resource?.id === session.id && e.detail['justified'] === true));
    const ended = await cell.call(endPurposeSession, { params: { purposeSessionId: session.id } }, max);
    assert.equal(ended.endedReason, 'ended_by_user');
    assert.equal(await accessTo(max, connections['crm']!, [session.id]), 'none');
  });

  test('suspending the definition ends its open sessions in the same transaction', async () => {
    const session = await cell.call(declarePurpose, { body: { purposeDefinitionId: definition.id, justification: 'April run' } }, max);
    assert.equal(await accessTo(max, connections['crm']!, [session.id]), 'read');
    const suspended = await cell.call(setPurposeDefinitionStatus, { params: { purposeDefinitionId: definition.id },
      body: { version: definition.version, status: 'suspended' } }, root);
    assert.equal(suspended.status, 'suspended');
    assert.equal(await accessTo(max, connections['crm']!, [session.id]), 'none');
    const { rows } = await cell.migrate.query('select ended_reason from gov.purpose_sessions where id = $1', [session.id]);
    assert.equal(rows[0].ended_reason, 'definition_suspended');
  });

  test('an export purpose waits for a second person to approve each declaration (decision 2026-11-14)', async () => {
    const exporting = (await cell.call(createMarking, { body: { name: 'Payroll export', kind: 'purpose' } }, root)).id;
    const created = await cell.call(createPurposeDefinition, { body: { markingId: exporting, name: 'Payroll export', description: 'Export to the bureau',
      maxSessionMinutes: 30, use: 'export' } }, root);
    assert.deepEqual([created.use, created.requiresApproval], ['export', true]);
    await cell.call(approvePurposeDefinition, { params: { purposeDefinitionId: created.id }, body: { version: created.version } }, ann);
    await cell.call(grantPurposeEligibility, { body: { purposeDefinitionId: created.id, grantee: { kind: 'scope', id: scopes['engineering']! } } }, root);
    const session = await cell.call(declarePurpose, { body: { purposeDefinitionId: created.id, justification: 'April bureau run' } }, max);
    assert.deepEqual([session.requiresApproval, session.approvedAt], [true, null]);
    const satisfied = async () => (await access(max, { markings: [exporting], purposeSessionIds: [session.id] })).markings[0]!.satisfied;
    assert.equal(await satisfied(), false, 'not before it is approved');
    const approved = await cell.call(approvePurposeSession, { params: { purposeSessionId: session.id } }, root);
    assert.equal(approved.approvedBy, root.membershipId);
    assert.equal(await satisfied(), true);
    assert.ok((await cell.events('purpose_session_approved')).some((e) => e.resource?.id === session.id));
    await assert.rejects(cell.call(approvePurposeSession, { params: { purposeSessionId: session.id } }, ann), { code: 'purpose_session.not_awaiting_approval' });
  });
});

describe('field policies (spec 57.4)', () => {
  test('resolved before any plan: the strictest applicable effect, for its audience only', async () => {
    const plain = await connection('Directory', olly, scopes['engineering']!);
    await cell.call(grantConnection, { body: { connectionId: plain, grantee: { kind: 'scope', id: scopes['engineering']! }, access: 'read' } }, olly);
    const hr = (await cell.call(listMarkings, { query: {} }, root)).markings.find((m) => m.name === 'HR-Confidential')!.id;
    // Salary is redacted for anyone not cleared for HR; Member holders see email masked.
    await cell.call(createFieldPolicy, { body: { target: { connectionId: plain, fieldPath: 'salary' }, effect: 'redact', appliesTo: { markingId: hr } } }, root);
    await cell.call(createFieldPolicy, { body: { target: { connectionId: plain, fieldPath: 'email' }, effect: 'mask',
      appliesTo: { roleId: cell.roles['Member']! } } }, root);
    await cell.call(createFieldPolicy, { body: { target: { connectionId: plain, fieldPath: 'email' }, effect: 'deny',
      appliesTo: { scopeId: scopes['sales']! } } }, root);
    const fields = [{ connectionId: plain, path: 'salary' }, { connectionId: plain, path: 'email' }, { connectionId: plain, path: 'name' }];
    const forMax = await access(max, { fields });
    assert.deepEqual(forMax.fields.map((f) => f.effect), ['allow', 'mask', 'allow'], 'max is cleared for HR and holds Member');
    const forOlly = await access(olly, { fields });
    assert.deepEqual(forOlly.fields.map((f) => f.effect), ['redact', 'mask', 'allow']);
    const forEve = await access(eve, { fields });
    assert.deepEqual(forEve.fields.map((f) => f.effect), ['redact', 'allow', 'allow'], 'eve holds Admin, not Member');
    await assert.rejects(cell.call(createFieldPolicy, { body: { target: { connectionId: plain, fieldPath: 'x' }, effect: 'deny', appliesTo: {} } }, max),
      { code: 'policy.not_permitted' });
  });
});

describe('organisation-wide decisions and declassification (spec 57.6, 58.9)', () => {
  test('organisation-wide: only a grant held across the organisation counts', async () => {
    const orgWide = (who: Signed) => cell.call(authorise, { body: { permission: 'audit.read', organisationWide: true } }, who);
    assert.equal((await orgWide(root)).decision, 'allow');
    assert.equal((await orgWide(eve)).decision, 'deny');
    assert.equal((await cell.call(authorise, { body: { permission: 'audit.read', scopeId: scopes['engineering']! } }, eve)).decision, 'allow');
  });

  test('a declassification is requested by a cleared super admin and approved by another cleared member', async () => {
    const hr = (await cell.call(listMarkings, { query: {} }, root)).markings.find((m) => m.name === 'HR-Confidential')!.id;
    const ask = (who: Signed, step: 'request' | 'approve', requestedBy?: string) =>
      cell.call(declassificationDecision, { body: { markingId: hr, step, ...(requestedBy ? { requestedBy } : {}) } }, who);
    assert.equal((await ask(root, 'request')).reason, 'marking_unsatisfied', 'the requester must satisfy the marking');
    await cell.call(grantClearance, { body: { markingId: hr, holder: { kind: 'membership', id: root.membershipId } } }, root);
    assert.equal((await ask(root, 'request')).decision, 'allow');
    assert.equal((await ask(max, 'request')).reason, 'not_granted');
    assert.equal((await ask(root, 'approve', root.membershipId)).reason, 'self_approval');
    assert.equal((await ask(ann, 'approve', root.membershipId)).reason, 'marking_unsatisfied');
    assert.equal((await ask(max, 'approve', root.membershipId)).decision, 'allow');
  });
});

describe('service principals: execute, never authorise (spec 60.4 to 60.6)', () => {
  test('a principal acts within its roles and its owner\'s authority; an authorising role is refused and audited', async () => {
    const principal = await cell.call(createServicePrincipal, { body: { kind: 'automation', name: 'Nightly sync', scopeId: scopes['engineering']!,
      ownerMembershipId: eve.membershipId } }, root);
    await cell.call(grantPrincipalRole, { params: { servicePrincipalId: principal.id }, body: { roleId: cell.roles['Member']! } }, root);
    await assert.rejects(cell.call(grantPrincipalRole, { params: { servicePrincipalId: principal.id }, body: { roleId: cell.roles['Admin']! } }, root),
      { code: 'service_principal.authorising_refused' });
    assert.ok((await cell.events('principal_authorising_permission_refused')).some((e) => e.resource?.id === principal.id));

    const asPrincipal = { request: { organisationId: cell.org, servicePrincipalId: principal.id } };
    const decide = (permission: string, scope?: string) => cell.gateway.call(authorise,
      { body: { permission, ...(scope ? { scopeId: scopes[scope] } : {}) } }, asPrincipal);
    assert.equal((await decide('query.compile', 'platform')).decision, 'allow');
    assert.equal((await decide('query.compile', 'sales')).reason, 'not_granted', 'bounded to its subtree');
    assert.equal((await decide('mutation.approve')).reason, 'principal_never_authorises');
    await cell.call(grantConnection, { body: { connectionId: connections['ledger']!, grantee: { kind: 'service_principal', id: principal.id }, access: 'write' } }, root);
    const reached = await cell.gateway.call(resolveAccess, { body: { connections: [connections['ledger']!] } }, asPrincipal);
    assert.equal(reached.connections[0]!.access, 'none', 'its owner eve does not hold the Ledger, so neither does it');

    await cell.call(suspendMember, { params: { membershipId: eve.membershipId } }, root);
    assert.equal((await decide('query.compile', 'platform')).reason, 'principal_inactive', 'its owner is suspended');
    await cell.call(reinstateMember, { params: { membershipId: eve.membershipId } }, root);
    assert.equal((await decide('query.compile', 'platform')).decision, 'allow');
    await cell.call(revokeServicePrincipal, { params: { servicePrincipalId: principal.id } }, root);
    assert.equal((await decide('query.compile', 'platform')).reason, 'principal_inactive');
  });

  test('an API client\'s secret is shown once and stored as its hash', async () => {
    const client = await cell.call(createServicePrincipal, { body: { kind: 'api_client', name: 'Reporting', scopeId: scopes['sales']!,
      expiresAt: new Date(Date.now() + 86_400_000).toISOString() } }, root);
    assert.match(client.secret!, /^silo_api_/);
    const { rows } = await cell.migrate.query('select secret_hash from iam.service_principals where id = $1', [client.id]);
    assert.equal((rows[0].secret_hash as Buffer).length, 32);
  });
});
