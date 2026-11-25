// Plan gates (decision 2026-11-14 amending spec 71.2; D76). With no entitlement nothing is
// gated. On a self-serve entitlement: neither builder, the catalogue lists certified prebuilt
// connectors only, a connection beyond the limit is refused with the plan that would allow
// it, and the connection that already exists keeps working.

import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { browseCatalogue } from '../../src/contracts/catalogue/catalogue.contract.ts';
import { createConnection, getConnection } from '../../src/contracts/connect-registry/connection.contract.ts';
import { createConnector, createManifestVersion } from '../../src/contracts/connect-registry/connector.contract.ts';
import type { ServiceClient } from '../../src/infra/serviceClient.infra.ts';
import { service as catalogueService } from '../../src/routes/catalogue/index.route.ts';
import { upgradeForConnections } from '../../src/services/billing/planGates.service.ts';
import { PLAN_ENTITLEMENTS } from '../../src/services/billing/plans.service.ts';
import { isAppError } from '../../src/utils/errors.util.ts';
import { inTx, uuidv7 } from '../db/harness.helper.ts';
import { createConnectCell, restManifest, type ConnectCell, type Signed } from './connect.helper.ts';

let cell: ConnectCell;
let gateway: ServiceClient;
let root: Signed;
let connectorId = '';
let existing = '';
const dir = mkdtempSync(path.join(tmpdir(), 'silo-plangates-'));
const keyed = () => ({ ...cell.as(root), idempotencyKey: uuidv7() });

/** Replaces the open entitlement with a self-serve one (the subscription's plan and limit). */
async function entitle(plan: 'standard' | 'business', limit: number | null): Promise<void> {
  await inTx(cell.app, { orgId: cell.org }, async () => {
    const subscription = uuidv7();
    await cell.app.query(`update billing.subscriptions set status = 'cancelled', cancelled_at = now() where status <> 'cancelled'`);
    await cell.app.query(
      `insert into billing.subscriptions (id, organisation_id, plan, seat_count, term, discount_tier, stripe_customer_id, stripe_subscription_id,
         current_period_start, current_period_end, status)
       values ($1, $2, $3, 5, 'monthly', 'list', 'cus_p', $4, now() - interval '1 day', now() + interval '29 days', 'active')`,
      [subscription, cell.org, plan, `sub_${uuidv7().slice(-12)}`]);
    await cell.app.query(`update billing.entitlements set effective_to = now() where effective_to is null`);
    await cell.app.query(
      `insert into billing.entitlements (id, organisation_id, seats, tokens_per_seat_period, simulations_per_seat_period, daily_token_limit,
         storage_included_bytes, capabilities, source, subscription_id, connections_limit, effective_from)
       values ($1, $2, 5, 300, 0, 20, 0, '{}', 'subscription', $3, $4, now())`, [uuidv7(), cell.org, subscription, limit]);
  });
}

async function refusal(work: Promise<unknown>): Promise<{ code: string; details: Record<string, unknown> }> {
  try {
    await work;
  } catch (error) {
    assert.ok(isAppError(error), String(error));
    assert.equal(error.category, 'forbidden');
    return { code: error.code, details: error.details as Record<string, unknown> };
  }
  assert.fail('expected a refusal');
}

before(async () => {
  const keys = generateKeyPairSync('ed25519');
  writeFileSync(path.join(dir, 'catalogue.pub'), keys.publicKey.export({ type: 'spki', format: 'pem' }));
  cell = await createConnectCell();
  await cell.start(catalogueService, 'catalogue', 'test_app', {
    CATALOGUE_DATABASE_URL: cell.h.url('test_migrate'), CATALOGUE_RELEASE_PUBLIC_KEY_FILE: path.join(dir, 'catalogue.pub'),
  });
  gateway = cell.client('gateway');
  root = await cell.signIn('root@acme.example');
  // Before any entitlement (provisioned by hand): built and connected, ungated.
  const connector = await gateway.call(createConnector, { body: { slug: 'own-crm', name: 'Own CRM', provider: 'Example', sourceRoute: 'visual' } }, keyed());
  connectorId = connector.id;
  await gateway.call(createManifestVersion, { params: { connectorId }, body: { document: restManifest({ baseUrl: 'https://crm.example' }) as never } }, keyed());
  existing = (await gateway.call(createConnection, { body: { connectorId, name: 'CRM', owningScopeId: cell.scopes['engineering']! } }, keyed())).id;
});

after(async () => {
  await cell?.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('plan gates (D76)', () => {
  test('no entitlement: the catalogue lists the organisation\'s own connector', async () => {
    const { connectors } = await gateway.call(browseCatalogue, { query: { tier: 'private' } }, cell.as(root));
    assert.deepEqual(connectors.map((c) => c.id), [connectorId]);
  });

  test('self-serve: neither builder, with Enterprise named for the upgrade', async () => {
    await entitle('standard', 1);
    for (const sourceRoute of ['visual', 'ai'] as const) {
      const refused = await refusal(gateway.call(createConnector, { body: { slug: `x-${sourceRoute}`, name: 'X', provider: 'Example', sourceRoute } }, keyed()));
      assert.equal(refused.code, 'plan.builder_not_included');
      assert.equal(refused.details['upgrade'], 'enterprise');
      assert.equal(refused.details['capability'], sourceRoute === 'ai' ? 'ai_connector_builder' : 'nocode_connector_builder');
    }
  });

  test('self-serve: the catalogue lists certified prebuilt connectors only', async () => {
    assert.equal((await gateway.call(browseCatalogue, { query: { tier: 'private' } }, cell.as(root))).connectors.length, 0);
    const { connectors } = await gateway.call(browseCatalogue, { query: {} }, cell.as(root));
    assert.ok(connectors.every((c) => c.trustTier === 'certified' && !c.authoredHere));
  });

  test('a connection beyond the limit is refused; the existing one keeps working', async () => {
    const refused = await refusal(gateway.call(createConnection, { body: { connectorId, name: 'CRM 2', owningScopeId: cell.scopes['engineering']! } }, keyed()));
    assert.equal(refused.code, 'plan.connections_limit');
    assert.deepEqual([refused.details['limit'], refused.details['used'], refused.details['upgrade']], [1, 1, 'business']);
    const kept = await gateway.call(getConnection, { params: { connectionId: existing } }, cell.as(root));
    assert.notEqual(kept.status, 'revoked');
  });

  test('with room, a connector that is not certified is still refused on a self-serve plan', async () => {
    await entitle('business', 5);
    const refused = await refusal(gateway.call(createConnection, { body: { connectorId, name: 'CRM 3', owningScopeId: cell.scopes['engineering']! } }, keyed()));
    assert.equal(refused.code, 'plan.prebuilt_only');
  });

  test('the upgrade named is the next plan that holds more', () => {
    assert.equal(upgradeForConnections('standard', 5), 'business', 'Business holds 15');
    assert.equal(upgradeForConnections('standard', 20), 'enterprise', 'a Standard limit above Business\'s goes to Enterprise');
    assert.equal(upgradeForConnections('business', 15), 'enterprise');
    assert.deepEqual([PLAN_ENTITLEMENTS.standard.connectionsLimit, PLAN_ENTITLEMENTS.business.connectionsLimit], [5, 15]);
  });
});
