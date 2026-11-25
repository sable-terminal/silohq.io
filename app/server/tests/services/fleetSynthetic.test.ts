// The synthetic tests of a release's health gates (spec 11.2; decision 2026-11-18), end to end:
// a cell behind its public gateway, and its Fleet agent serving the fixture source and driving
// the cell through the public API as the synthetic organisation's two members, the setup
// (conformance, writes, the change stream, the ontology by two people, an Action type) and a
// round of the four tests: a question, a live subscription carrying the Action's delta, the
// Action proposed and approved by two people, and its revert.

import assert from 'node:assert/strict';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { createActionsService } from '../../src/routes/actions/index.route.ts';
import { service as approvalsService } from '../../src/routes/approvals/index.route.ts';
import { createChangeStreamService } from '../../src/routes/change-stream/index.route.ts';
import { service as compileService } from '../../src/routes/compile/index.route.ts';
import { service as conformanceService } from '../../src/routes/conformance/index.route.ts';
import { createConnectRuntimeService } from '../../src/routes/connect-runtime/index.route.ts';
import { service as executorService } from '../../src/routes/executor/index.route.ts';
import { createFleetService } from '../../src/routes/fleet-control/index.route.ts';
import { createGatewayService } from '../../src/routes/gateway/index.route.ts';
import { service as ontologyService } from '../../src/routes/ontology/index.route.ts';
import { service as plannerService } from '../../src/routes/planner/index.route.ts';
import { service as pushdownService } from '../../src/routes/pushdown-compiler/index.route.ts';
import { service as resolutionService } from '../../src/routes/resolution/index.route.ts';
import { service as revertService } from '../../src/routes/revert/index.route.ts';
import { createStatePlaneService } from '../../src/routes/state-plane/index.route.ts';
import type { SyntheticFixture } from '../../src/services/fleet-control/syntheticFixture.service.ts';
import type { SyntheticTests } from '../../src/services/fleet-control/syntheticTests.service.ts';
import { uuidv7 } from '../db/harness.helper.ts';
import { LOCAL } from '../infra/services.helper.ts';
import { createConnectCell, type ConnectCell } from './connect.helper.ts';
import { startFakeKubernetes, type FakeKubernetes } from './fakeKubernetes.helper.ts';
import { createMemoryStore } from './memoryStore.helper.ts';
import { freePort } from './writeback.helper.ts';

const ORIGIN = 'https://app.synthetic.test';

let cell: ConnectCell;
let dir: string;
let kube: FakeKubernetes;
let tests: SyntheticTests;
let fixture: SyntheticFixture;

before(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'silo-synthetic-'));
  const keyFile = path.join(dir, 'release.pub.pem');
  await writeFile(keyFile, generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }).toString());
  kube = await startFakeKubernetes([]);
  cell = await createConnectCell();
  const live = { REDIS_STATE_URL: `${LOCAL.redisUrl}/2`, NATS_LIVE_URL: LOCAL.natsUrl };
  const [actionsPort, approvalsPort] = [await freePort(), await freePort()];
  await cell.start(ontologyService, 'ontology', 'test_app');
  await cell.start(createConnectRuntimeService(), 'connect-runtime', 'test_app');
  await cell.start(pushdownService, 'pushdown-compiler', 'test_app');
  await cell.start(resolutionService, 'resolution', 'test_app');
  // Callees before their callers: conformance opens change-stream's probes.
  await cell.start(createChangeStreamService({ tickMs: 150 }), 'change-stream', 'test_app', live);
  await cell.start(conformanceService, 'conformance', 'test_app');
  await cell.start(createStatePlaneService({ watchMs: 300 }), 'state-plane', 'test_app', live);
  await cell.start(plannerService, 'planner', 'test_app');
  await cell.start(executorService, 'executor', 'test_app');
  await cell.start(compileService, 'compile', 'test_app');
  await cell.start(createActionsService({ sweep: false }), 'actions', 'test_app', { HTTP_PORT: String(actionsPort), SERVICE_URL_APPROVALS: `http://127.0.0.1:${approvalsPort}` });
  await cell.start(approvalsService, 'approvals', 'test_app', { HTTP_PORT: String(approvalsPort) });
  await cell.start(revertService, 'revert', 'test_app');
  let edge = 0;
  await cell.start(createGatewayService({ coalesceMs: 0, onListening: (p) => { edge = p; } }), 'gateway', 'test_app', {
    ...live, GATEWAY_PUBLIC_ORIGIN: ORIGIN, GATEWAY_PUBLIC_HOST: '127.0.0.1', GATEWAY_PUBLIC_PORT: '0', TRUST_PROXY_HOPS: '1',
    IDENTIFIER_HASH_KEY: randomBytes(32).toString('base64'), GATEWAY_HEARTBEAT_SECONDS: '1',
  });
  // The cell's Fleet agent: the fixture on a port of its own, the tests through the public listener.
  const fixturePort = await freePort();
  await cell.start(createFleetService({
    objects: createMemoryStore(), syntheticWaitMs: 30_000,
    onSynthetic: (t, f) => { tests = t; fixture = f; },
  }), 'fleet-control', 'test_app', {
    FLEET_ROLE: 'cell_agent', FLEET_RELEASE_PUBLIC_KEY_FILE: keyFile, FLEET_AGENT_POLL_MINUTES: '600', FLEET_RELEASE_POLL_MINUTES: '600',
    FLEET_KUBERNETES: kube.url, FLEET_KUBERNETES_NAMESPACE: 'silo', FLEET_IMAGE_REPOSITORY: 'registry.example/silo/cells', FLEET_CHANNEL: 'dev',
    FLEET_SYNTHETIC_PORT: String(fixturePort), FLEET_SYNTHETIC_HOST: '127.0.0.1', FLEET_SYNTHETIC_URL: `http://127.0.0.1:${fixturePort}`,
    FLEET_GATEWAY_URL: `http://127.0.0.1:${edge}`, FLEET_GATEWAY_ORIGIN: ORIGIN, FLEET_SYNTHETIC_MINUTES: '600',
    SERVICE_URL_FLEET_CONTROL: 'http://127.0.0.1:1',
    OBJECT_STORE: 's3', OBJECT_BUCKET_FILES: 'silo-test-files', S3_ENDPOINT: 'http://127.0.0.1:1', S3_REGION: 'eu-west-2', S3_FORCE_PATH_STYLE: 'true',
  });
});

after(async () => {
  await cell?.close();
  await kube?.close();
  if (dir) await rm(dir, { recursive: true, force: true });
});

describe('the synthetic tests (spec 11.2)', () => {
  test('setup through the public API as two people, then a round: question, subscription, Action and revert all pass', async () => {
    const results = await tests.run('r-synthetic', uuidv7());
    assert.deepEqual(results, { synthetic_question: true, synthetic_subscription: true, synthetic_action: true, synthetic_revert: true });
    assert.deepEqual(tests.resultsFor('r-synthetic'), results);
    assert.ok(kube.configMaps.get('silo-fleet-synthetic'), 'the setup is recorded for a restart to resume');
    assert.equal(fixture.probes.get('p1')!.properties.score, 10, 'the revert put the score back');
  });

  test('a second round reuses the setup', async () => {
    const before = kube.calls.length;
    const results = await tests.run('r-synthetic-2', uuidv7());
    assert.equal(Object.values(results).every(Boolean), true, JSON.stringify(results));
    assert.ok(kube.calls.length - before < 10, 'setup is not made again');
  });
});
