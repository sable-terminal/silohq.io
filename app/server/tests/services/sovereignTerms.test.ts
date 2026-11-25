// A sovereign customer's entitlement terms (D204; decision 2026-11-19): the contract is in Silo's
// commercial billing; in the sovereign cell, with billing compiled out, one UK cleared operator
// enters the terms it grants by its reference and another approves them, which opens the
// entitlement (source sovereign_terms) and brings the seats to their count. Only a sovereign cell
// takes them; whoever entered terms never decides them.

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { loadConfig } from '../../src/config/index.config.ts';
import { createLogger } from '../../src/infra/logger.infra.ts';
import { openDatabases, type Databases } from '../../src/infra/postgres.infra.ts';
import type { StaffContext } from '../../src/services/admin-portal/deps.service.ts';
import { createSovereignTerms } from '../../src/services/admin-portal/sovereignTerms.service.ts';
import { inTx } from '../db/harness.helper.ts';
import { createConnectCell, type ConnectCell } from './connect.helper.ts';

const quiet = createLogger({ service: 'admin-portal', cell: 'test', release: 'test', level: 'error', write: () => undefined });

let cell: ConnectCell;
let databases: Databases;
const operators = { a: randomUUID(), b: randomUUID() };
const as = (id: string): StaffContext => ({ staff: { operator: { id } } as never, correlationId: randomUUID() });
const terms = (seats: number) => ({
  commercialContractRef: 'SILO-C-2026-0042', seats, tokensPerSeatPeriod: 50_000, simulationsPerSeatPeriod: 20, dailyTokenLimit: 1_000_000,
  storageIncludedBytes: 10_000_000_000, liveObjectsLimit: null, capabilities: ['sso' as const], termStart: '2026-12-01', termEnd: '2027-11-30',
});

before(async () => {
  cell = await createConnectCell();
  for (const [name, id] of Object.entries(operators)) {
    await cell.migrate.query(`insert into platform.operators (id, idp_subject, display_name, clearance, uk_resident, sovereign_access_listed) values ($1, $2, $3, 'sc', true, true)`,
      [id, `idp|${name}`, `Cleared ${name}`]);
  }
  const config = loadConfig({
    SILO_ENV: 'test', SILO_SERVICE: 'ontology', SILO_CELL_ID: 'uk-sov-1', SILO_CELL_KIND: 'commercial', SILO_RESIDENCY: 'uk', SILO_HOSTING: 'gke',
    SILO_BUILD_TARGET: 'commercial', HTTP_HOST: '127.0.0.1', HTTP_PORT: '0', HTTP_DRAIN_SECONDS: '0', PG_CONTROL_URL: cell.h.url('test_app'), REDIS_DATA_URL: 'redis://127.0.0.1:1/0',
  });
  databases = openDatabases(config.postgres, 'admin-portal', ['control']);
});

after(async () => {
  await databases?.close(1_000);
  await cell?.close();
});

const entitlement = async () => (await inTx(cell.app, { orgId: cell.org }, () => cell.app.query(
  `select seats, source, capabilities, sovereign_terms_id from billing.entitlements where organisation_id = $1 and effective_to is null`, [cell.org]))).rows[0];
const seats = async () => (await inTx(cell.app, { orgId: cell.org }, () => cell.app.query(
  `select status from billing.seats where organisation_id = $1 and status <> 'released'`, [cell.org]))).rows.length;

describe('sovereign entitlement terms (D204)', () => {
  test('only a sovereign cell takes them: elsewhere a contract in billing grants entitlements', async () => {
    const commercial = createSovereignTerms({ databases, logger: quiet, cell: { id: 'uk-lon-1', sovereign: false } });
    await assert.rejects(commercial.enter(as(operators.a), cell.org, terms(3)), { code: 'sovereign_terms.not_sovereign_cell' });
  });

  test('entered by one cleared operator, approved by another: the entitlement and the seats follow; never the same person', async () => {
    const service = createSovereignTerms({ databases, logger: quiet, cell: { id: 'uk-sov-1', sovereign: true } });
    const entered = await service.enter(as(operators.a), cell.org, terms(3));
    assert.deepEqual([entered.status, entered.commercialContractRef, entered.capabilities.sort()], ['pending', 'SILO-C-2026-0042', ['sovereign', 'sso']]);
    await assert.rejects(service.decide(as(operators.a), cell.org, entered.id, 'approve'), { code: 'sovereign_terms.two_person' });
    const approved = await service.decide(as(operators.b), cell.org, entered.id, 'approve');
    assert.deepEqual([approved.status, approved.decidedBy], ['approved', operators.b]);
    const open = await entitlement();
    assert.deepEqual([open.seats, open.source, open.sovereign_terms_id, open.capabilities.includes('sovereign')], [3, 'sovereign_terms', entered.id, true]);
    assert.equal(await seats(), 3);
    await assert.rejects(service.decide(as(operators.a), cell.org, entered.id, 'reject'), { code: 'sovereign_terms.decided' });
    const { rows } = await cell.migrate.query(
      `select payload->>'event' as event from platform.outbox where organisation_id = $1 and payload->>'event' like 'sovereign_terms_%' order by created_at`, [cell.org]);
    assert.deepEqual(rows.map((r) => r.event), ['sovereign_terms_entered', 'sovereign_terms_approved']);
  });

  test('new terms replace the entitlement and release unassigned seats; rejected terms change nothing', async () => {
    const service = createSovereignTerms({ databases, logger: quiet, cell: { id: 'uk-sov-1', sovereign: true } });
    const fewer = await service.enter(as(operators.b), cell.org, terms(1));
    await service.decide(as(operators.a), cell.org, fewer.id, 'approve');
    assert.deepEqual([(await entitlement()).seats, await seats()], [1, 1]);
    const refused = await service.enter(as(operators.a), cell.org, terms(9));
    await service.decide(as(operators.b), cell.org, refused.id, 'reject');
    assert.deepEqual([(await entitlement()).seats, await seats()], [1, 1], 'rejected terms grant nothing');
    const { terms: listed } = await service.list(cell.org);
    assert.deepEqual(listed.map((t) => t.status), ['rejected', 'approved', 'approved']);
  });
});
