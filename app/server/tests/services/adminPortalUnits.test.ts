// The admin portal's rules that need no database (spec 11.6, 13.3, 13.4): the route table
// is complete and names real capabilities; the staff identity always comes from the
// session, never the request; an expedited promotion needs the security officer; sovereign
// work needs the sovereign access list; and the sovereign portal will not start without
// the managed-device claims.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { ConfigError, loadConfig, type Env } from '../../src/config/index.config.ts';
import { STAFF_CAPABILITIES, type StaffCapability } from '../../src/contracts/admin-portal/capability.contract.ts';
import * as s from '../../src/contracts/admin-portal/staffApi.contract.ts';
import { staffHandlers } from '../../src/controllers/admin-portal/staffHandlers.controller.ts';
import type { ServiceClient } from '../../src/infra/serviceClient.infra.ts';
import type { Operator } from '../../src/models/platform/operator.model.ts';
import type { AdminPortalDeps, StaffContext } from '../../src/services/admin-portal/deps.service.ts';
import { createOperations } from '../../src/services/admin-portal/operations.service.ts';
import { capabilitiesOf } from '../../src/services/admin-portal/staffAuth.service.ts';
import { uuidv7 } from '../db/harness.helper.ts';

const operator = (facts: Partial<Operator> = {}): Operator => ({
  id: uuidv7(), idpSubject: 'sub', displayName: 'Staff', clearance: 'sc', ukResident: true, sovereignAccessListed: false, status: 'active',
  lastReviewedAt: null, lastReviewedBy: null, removedAt: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), version: 1,
  ...facts,
});
const ctxOf = (capabilities: StaffCapability[], facts: Partial<Operator> = {}): StaffContext => ({
  staff: { operator: operator(facts), capabilities: new Set(capabilities), sessionKey: 'k', absoluteExpiresAt: new Date().toISOString() },
  correlationId: uuidv7(),
});

/** A service client that records each call and answers from `replies`. */
function stubServices(replies: Record<string, (input: any) => unknown> = {}) {
  const calls: { name: string; input: any }[] = [];
  const services = {
    async call(contract: { name: string }, input: unknown) {
      calls.push({ name: contract.name, input });
      return replies[contract.name]?.(input) ?? {};
    },
    close() { /* nothing open */ },
  } as unknown as ServiceClient;
  return { services, calls };
}

const operations = (services: ServiceClient) =>
  createOperations({ services } as AdminPortalDeps, {} as never);

describe('admin portal rules', () => {
  test('every staff route has a handler and names capabilities that exist', () => {
    const handlers = staffHandlers({ auth: {} as never, operators: {} as never, breakGlass: {} as never, operations: {} as never, sovereignTerms: {} as never, supportTickets: {} as never });
    for (const route of s.STAFF_ROUTES) {
      assert.ok(handlers[route.name as keyof typeof handlers], `${route.name} has a handler`);
      if (route.access.kind === 'capability') for (const c of route.access.anyOf) assert.ok(STAFF_CAPABILITIES.includes(c), `${route.name}: ${c}`);
    }
    assert.equal(Object.keys(handlers).length, s.STAFF_ROUTES.length);
    const access = s.signOrganisationMigration.access;
    assert.equal(access.kind, 'capability_of_input');
    if (access.kind === 'capability_of_input') {
      for (const role of ['security_officer', 'sovereign_security_officer', 'contract']) {
        assert.ok(STAFF_CAPABILITIES.includes(access.of({ params: {}, query: {}, body: { role } })));
      }
    }
  });

  test('a request never names the member of staff: the body refuses it, and the session supplies it', async () => {
    assert.equal(s.approveFleetPromotion.body.safeParse({ approvedBy: uuidv7() }).success, false);
    const { services, calls } = stubServices();
    const ctx = ctxOf(['oauth.clients', 'status.publish', 'fleet.rollout.halt']);
    const ops = operations(services);
    await ops.addOAuthClient(ctx, { params: {}, query: {}, body: { provider: 'example' } } as never);
    await ops.putNotice(ctx, { params: { noticeId: uuidv7() }, query: {}, body: { kind: 'incident', severity: 'sev2', title: 'Slow', cellIds: ['uk-lon-1'], components: [] } } as never);
    await ops.haltRollout(ctx, { params: { rolloutId: uuidv7() }, query: {}, body: undefined } as never);
    assert.deepEqual(calls.map((c) => [c.name, c.input.body.operatorId ?? c.input.body.postedBy ?? c.input.body.haltedBy]), [
      ['registerSiloOAuthClient', ctx.staff.operator.id], ['putNotice', ctx.staff.operator.id], ['haltRollout', ctx.staff.operator.id],
    ]);
  });

  test('an expedited promotion is approved only by the security officer (fleet.release.expedite)', async () => {
    const promotionId = uuidv7();
    const { services, calls } = stubServices({ readPromotion: () => ({ promotionId, expedite: true }) });
    const ops = operations(services);
    const input = { params: { promotionId }, query: {}, body: undefined } as never;
    await assert.rejects(ops.approvePromotion(ctxOf(['fleet.release.promote']), input), { code: 'staff.not_permitted' });
    assert.deepEqual(calls.map((c) => c.name), ['readPromotion']);
    const officer = ctxOf(['fleet.release.promote', 'fleet.release.expedite']);
    await ops.approvePromotion(officer, input);
    assert.deepEqual(calls.at(-1), { name: 'approvePromotion', input: { params: { promotionId }, body: { approvedBy: officer.staff.operator.id } } });
  });

  test('sovereign work needs the sovereign access list', async () => {
    const { services, calls } = stubServices();
    const ops = operations(services);
    const bundle = { params: { bundleId: uuidv7() }, query: {}, body: { bundle: {}, signatures: [] } } as never;
    await assert.rejects(ops.countersignBundle(ctxOf(['fleet.sovereign.countersign']), bundle), { code: 'staff.not_sovereign_listed' });
    const sign = (role: string) => ({ params: { organisationId: uuidv7(), migrationId: uuidv7() }, query: {}, body: { role } }) as never;
    await assert.rejects(ops.signMigration(ctxOf(['tenancy.sovereign_security_officer']), sign('sovereign_security_officer')),
      { code: 'staff.not_sovereign_listed' });
    assert.equal(calls.length, 0);
    const listed = ctxOf(['tenancy.sovereign_security_officer'], { sovereignAccessListed: true, clearance: 'dv' });
    await ops.signMigration(listed, sign('sovereign_security_officer'));
    assert.deepEqual([calls[0]!.name, calls[0]!.input.body.operatorId, calls[0]!.input.body.role],
      ['signTenantMigration', listed.staff.operator.id, 'sovereign_security_officer']);
  });

  test('capabilities come from the provider\'s groups by the configured map; unknown groups grant nothing', () => {
    const map = { support: ['access.request'], release: ['fleet.release.promote', 'operations.view'] } as Record<string, StaffCapability[]>;
    assert.deepEqual(capabilitiesOf(['support', 'release', 'other'], map), ['access.request', 'fleet.release.promote', 'operations.view']);
    assert.deepEqual(capabilitiesOf('support', map), ['access.request']);
    assert.deepEqual(capabilitiesOf(undefined, map), []);
    assert.deepEqual(capabilitiesOf([1, null], map), []);
  });

  test('configuration: the map names only capabilities; the sovereign portal requires the managed-device claims', () => {
    const base: Env = {
      SILO_ENV: 'test', SILO_SERVICE: 'admin-portal', SILO_CELL_ID: 'uk-lon-1', SILO_CELL_KIND: 'commercial', SILO_RESIDENCY: 'uk',
      SILO_HOSTING: 'gke', SILO_BUILD_TARGET: 'commercial', PG_CONTROL_URL: 'postgres://a@127.0.0.1:1/x', REDIS_SESSION_URL: 'redis://r:1/0',
      REDIS_DATA_URL: 'redis://r:1/1', IDENTIFIER_HASH_KEY: Buffer.alloc(32, 1).toString('base64'),
      ADMIN_PORTAL_PUBLIC_ORIGIN: 'https://staff.silo.test', ADMIN_PORTAL_IDP_ISSUER: 'https://idp.silo.test', ADMIN_PORTAL_IDP_CLIENT_ID: 'portal',
      ADMIN_PORTAL_IDP_CLIENT_SECRET: 'secret',
    };
    const problemsOf = (env: Env): string[] => {
      try {
        loadConfig(env);
        return [];
      } catch (error) {
        assert.ok(error instanceof ConfigError, String(error));
        return [...error.problems];
      }
    };
    assert.deepEqual(problemsOf(base), []);
    assert.ok(problemsOf({ ...base, ADMIN_PORTAL_GROUP_CAPABILITIES: JSON.stringify({ g: ['mutation.approve'] }) })
      .some((p) => p.startsWith('ADMIN_PORTAL_GROUP_CAPABILITIES')));
    assert.ok(problemsOf({ ...base, ADMIN_PORTAL_IDP_ISSUER: undefined }).some((p) => p.includes('ADMIN_PORTAL_IDP_ISSUER')));
    const sovereign: Env = {
      ...base, SILO_CELL_ID: 'uk-sov-1', SILO_CELL_KIND: 'sovereign', SILO_HOSTING: 'conformant_kubernetes', SILO_BUILD_TARGET: 'sovereign',
      SILO_APPROVED_CAPABILITIES: '',
    };
    assert.ok(problemsOf(sovereign).some((p) => p.startsWith('ADMIN_PORTAL_DEVICE_CLAIMS')));
    assert.deepEqual(problemsOf({ ...sovereign, ADMIN_PORTAL_DEVICE_CLAIMS: JSON.stringify({ device_managed: true, device_country: 'GB' }) }), []);
  });
});
