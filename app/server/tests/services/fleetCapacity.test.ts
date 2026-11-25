// Cells and their limits (spec 6.3; D203): provisioning is needed when no shared cell of a
// residency is open below 75% of either limit and none is coming; a cell whose tenants have grown
// past 110% needs rebalancing; each recorded once a day while it lasts. A new cell registers as
// provisioning, with its live connections, and opens placement only once its synthetic tenant
// has passed every lifecycle, remembered across a restart.

import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID, type KeyObject } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { loadConfig } from '../../src/config/index.config.ts';
import type { AnyContract } from '../../src/contracts/endpoint.contract.ts';
import { createLogger } from '../../src/infra/logger.infra.ts';
import { openDatabases, type Databases } from '../../src/infra/postgres.infra.ts';
import type { ServiceClient } from '../../src/infra/serviceClient.infra.ts';
import { createCellReports } from '../../src/services/fleet-control/cellReports.service.ts';
import { createSignalStore } from '../../src/services/fleet-control/cellSignals.service.ts';
import { openFleetControl } from '../../src/services/fleet-control/control.service.ts';
import type { Fleet } from '../../src/services/fleet-control/fleet.service.ts';
import { createHarness, type Harness } from '../db/harness.helper.ts';

const quiet = createLogger({ service: 'fleet-control', cell: 'test', release: 'test', level: 'error', write: () => undefined });
const pem = (key: KeyObject): string => key.export({ type: 'pkcs8', format: 'pem' }).toString();
const hosts = { app: 'uk-lon-3.silohq.io', oauthCallbackUrl: 'https://uk-lon-3.silohq.io/oauth', hooks: 'hooks.uk-lon-3.silohq.io', agent: 'agent.uk-lon-3.silohq.io' };

let h: Harness;
let databases: Databases;
let fleet: Fleet;
let root: string;
let writer: Awaited<ReturnType<Harness['connect']>>;

async function cell(id: string, residency: 'uk' | 'eu' | 'us', status: string, organisations: number, connections: number): Promise<void> {
  await writer.query(`insert into directory.cells (id, kind, residency, hostname, status, connection_count, counts_at) values ($1, 'commercial', $2, $3, $4, $5, now())`,
    [id, residency, `${id}.silohq.io`, status, connections]);
  for (let i = 0; i < organisations; i++) {
    await writer.query(`insert into directory.organisation_directory (organisation_slug, cell_id, status) values ($1, $2, 'active')`, [`${id}-org-${i}`, id]);
  }
}

before(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'silo-capacity-'));
  h = await createHarness();
  writer = await h.connect('test_dir_writer', 'directory');
  const config = loadConfig({
    SILO_ENV: 'test', SILO_SERVICE: 'fleet-control', SILO_CELL_ID: 'global-uk', SILO_CELL_KIND: 'commercial', SILO_RESIDENCY: 'uk',
    SILO_HOSTING: 'gke', SILO_BUILD_TARGET: 'commercial', HTTP_HOST: '127.0.0.1', HTTP_PORT: '0', HTTP_DRAIN_SECONDS: '0',
    PG_DIRECTORY_URL: h.url('test_fleet', 'directory'), FLEET_ARTEFACT_DIR: path.join(root, 'artefacts'),
    FLEET_SIGNING_KEY: pem(generateKeyPairSync('ed25519').privateKey),
  });
  databases = openDatabases(config.postgres, 'fleet-control', ['directory']);
  fleet = (await openFleetControl(config, databases, quiet)).fleet;
});

after(async () => {
  await databases?.close(1_000);
  await h?.close();
  if (root) await rm(root, { recursive: true, force: true });
});

describe('cells and their limits (spec 6.3)', () => {
  test('provisioning is needed once no open shared cell of a residency is below 75% and none is coming; rebalancing past 110%; each once a day', async () => {
    // The UK: one cell at 80% of its organisations, another at 76% of its connections; the EU: room.
    await cell('uk-lon-1', 'uk', 'active', 0, 40_000);
    await cell('uk-lon-2', 'uk', 'active', 0, 38_000);
    await cell('eu-fra-1', 'eu', 'active', 0, 1_000);
    await cell('uk-old-1', 'uk', 'closed_to_placement', 0, 56_000);
    const first = await fleet.checkCapacity();
    assert.deepEqual(first, { provisioning: ['uk'], rebalancing: ['uk-old-1'] });
    assert.deepEqual(await fleet.checkCapacity(), { provisioning: [], rebalancing: [] }, 'once a day while it lasts');
    const { events } = await fleet.listEvents({ after: 0, limit: 100 });
    const needed = events.find((e) => e.event === 'cell_provisioning_needed')!;
    assert.deepEqual([needed.detail['residency'], needed.detail['open_cells'], needed.detail['fullest']], ['uk', 2, 112]);
    assert.equal(events.find((e) => e.event === 'cell_rebalancing_needed')!.cellId, 'uk-old-1');
    // Each cell recorded once as created (6.7); placement closed where a cell is not open (its status) — none opened yet was closed by a limit.
    assert.deepEqual(events.filter((e) => e.event === 'cell_created').map((e) => e.cellId).sort(), ['eu-fra-1', 'uk-lon-1', 'uk-lon-2', 'uk-old-1']);
    assert.deepEqual(events.filter((e) => e.event === 'cell_placement_closed').map((e) => e.cellId), [], 'never open, so never closed');
  });

  test('placement is open to an active cell below both limits; closing is recorded once, with why', async () => {
    await cell('uk-lon-9', 'uk', 'active', 0, 10_000);
    await fleet.checkCapacity();
    const open = async () => (await h.connect('test_dir_writer', 'directory')).query(`select placement_open from directory.cells where id = 'uk-lon-9'`);
    assert.equal((await open()).rows[0].placement_open, true);
    await writer.query(`update directory.cells set connection_count = 50_000 where id = 'uk-lon-9'`);
    await fleet.checkCapacity();
    await fleet.checkCapacity();
    assert.equal((await open()).rows[0].placement_open, false);
    const closed = (await fleet.listEvents({ after: 0, limit: 200 })).events.filter((e) => e.event === 'cell_placement_closed' && e.cellId === 'uk-lon-9');
    assert.deepEqual(closed.map((e) => [e.detail['reason'], e.detail['connections']]), [['limit', 50_000]], 'once, at the limit');
  });

  test('a cell being provisioned in the residency is the answer: nothing more is asked', async () => {
    await cell('us-va-1', 'us', 'active', 0, 45_000);
    await cell('us-va-2', 'us', 'provisioning', 0, 0);
    const out = await fleet.checkCapacity();
    assert.ok(!out.provisioning.includes('us'), 'us-va-2 is coming');
  });
});

describe('a provisioning cell opens placement after its synthetic tenant passes (spec 6.3)', () => {
  test('registered as provisioning with its connections; opened once every lifecycle passed, and kept open across a restart', async () => {
    const calls: { id: string; input: any }[] = [];
    const client: ServiceClient = {
      async call<C extends AnyContract>(contract: C, input: unknown) {
        calls.push({ id: contract.id, input });
        return (contract.id === 'connect-registry.cellConnectionCount' ? { connections: 1_234 } : {}) as never;
      },
      close() {},
    };
    let remembered: { openedAt: string } | undefined;
    const placement = { read: async () => remembered, write: async (v: { openedAt: string }) => { remembered = v; } };
    const make = () => createCellReports({
      services: client, logger: quiet, signals: createSignalStore(), cell: { id: 'uk-lon-3', kind: 'commercial', residency: 'uk', hosts }, status: 'provisioning', placement,
    });
    const reports = make();
    await reports.register(randomUUID());
    const registrations = () => calls.filter((c) => c.id === 'directory.registerCell').map((c) => c.input.body);
    assert.deepEqual([registrations()[0].status, registrations()[0].connectionCount], ['provisioning', 1_234]);
    assert.equal(await reports.openPlacement(randomUUID()), true);
    assert.equal(registrations().at(-1).status, 'active', 'placement opened');
    assert.ok(remembered);
    assert.equal(await reports.openPlacement(randomUUID()), false, 'opened once');
    const restarted = make();
    await restarted.register(randomUUID());
    assert.equal(registrations().at(-1).status, 'active', 'a restart keeps it open');
  });
});
