// Configuration: what loads, what is refused, and that a refusal never echoes a value.

import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';
import { ConfigError, loadConfig, type Env } from '../../src/config/index.config.ts';

const dir = mkdtempSync(path.join(tmpdir(), 'silo-config-'));
const file = (name: string, content: string): string => {
  const target = path.join(dir, name);
  writeFileSync(target, content);
  return target;
};
const KEY = Buffer.alloc(32, 1).toString('base64');

const base: Env = {
  SILO_ENV: 'development',
  SILO_SERVICE: 'credential',
  SILO_CELL_ID: 'uk-lon-1',
  SILO_CELL_KIND: 'commercial',
  SILO_RESIDENCY: 'uk',
  SILO_HOSTING: 'gke',
  SILO_BUILD_TARGET: 'commercial',
  PG_CONTROL_URL: 'postgres://svc_credential:pw@127.0.0.1:55432/silo_cell',
  KMS_PROVIDER: 'local',
  KMS_LOCAL_KEY: KEY,
};

const sovereign: Env = {
  ...base,
  SILO_SERVICE: 'executor',
  // The executor keeps result pages and its cache in redis-data.
  REDIS_DATA_URL: 'redis://redis-data:6379',
  SILO_CELL_ID: 'uk-sov-1',
  SILO_CELL_KIND: 'sovereign',
  SILO_HOSTING: 'conformant_kubernetes',
  SILO_BUILD_TARGET: 'sovereign',
  SILO_APPROVED_CAPABILITIES: '',
  KMS_PROVIDER: 'vault_transit',
  KMS_LOCAL_KEY: undefined,
  VAULT_ADDR: 'https://vault.vault.svc:8200',
  VAULT_TOKEN: 's.token',
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

describe('configuration', () => {
  test('loads a development cell with defaults and derived hostnames', () => {
    const config = loadConfig(base);
    assert.equal(config.cell.hosts.oauthCallbackUrl, 'https://oauth.uk-lon-1.silohq.io/callback');
    assert.equal(config.cell.hosts.agent, 'agent.uk-lon-1.silohq.io:443');
    assert.equal(config.postgres.poolMax, 10);
    assert.equal(config.security.argon2.memoryKiB, 65_536);
    assert.equal(config.security.argon2.parallelism, 1);
    assert.deepEqual(config.security.argon2Limits, { maxConcurrent: 4, maxQueued: 32 });
    assert.equal(config.security.sessionIdleMinutes, 30);
    assert.equal(config.security.sessionAbsoluteHours, 12);
    assert.equal(config.executorBounds.maxRowsPerSourceStep, 100_000);
    assert.equal(config.executorBounds.maxResultRows, 50_000);
    assert.equal(config.kms?.localKey?.length, 32);
    assert.ok(config.cell.capabilities.has('cloud_kms'));
    assert.ok(Object.isFrozen(config.postgres));
  });

  test('lists every problem, naming the variable and never its value', () => {
    const problems = problemsOf({ ...base, SILO_CELL_ID: 'UK LON', PG_CONTROL_URL: 'mysql://user:hunter2@db', PG_POOL_MAX: '0' });
    assert.ok(problems.some((p) => p.startsWith('SILO_CELL_ID:')));
    assert.ok(problems.some((p) => p.startsWith('PG_CONTROL_URL:')));
    assert.ok(problems.some((p) => p.startsWith('PG_POOL_MAX:')));
    assert.ok(!problems.join('\n').includes('hunter2'));
  });

  test('reads a secret from a file', () => {
    const config = loadConfig({ ...base, KMS_LOCAL_KEY: undefined, KMS_LOCAL_KEY_FILE: file('kek', `${KEY}\n`) });
    assert.equal(config.kms?.localKey?.length, 32);
    assert.ok(problemsOf({ ...base, KMS_LOCAL_KEY_FILE: file('kek2', KEY) }).some((p) => p.includes('not both')));
  });

  test('production refuses a local key, plain-text transport and a missing release', () => {
    const problems = problemsOf({
      ...base, SILO_ENV: 'production', REDIS_SESSION_URL: 'redis://redis-session:6379', NATS_LIVE_URL: 'nats://nats:4222',
    });
    for (const variable of ['KMS_PROVIDER', 'PG_SSL', 'REDIS_SESSION_URL', 'NATS_LIVE_URL', 'SERVICE_TLS_CERT_FILE', 'SILO_RELEASE']) {
      assert.ok(problems.some((p) => p.startsWith(`${variable}:`)), variable);
    }
  });

  test('production agents update through Fleet: the cell serving them has the release key and object-files (spec 10.7)', () => {
    const agents = {
      SILO_ENV: 'production', SILO_RELEASE: 'r1', PG_SSL: 'verify-full', SERVICE_TLS_CERT_FILE: file('cert', 'c'),
      SILO_SERVICE: 'connect-runtime', AGENT_CA_CERT_FILE: file('agent-ca', 'c'), AGENT_CA_KEY: 'k',
    };
    const updates = (env: Env): string[] => problemsOf(env).filter((p) => /^(FLEET_RELEASE_PUBLIC_KEY_FILE|OBJECT_BUCKET_FILES): production agents/.test(p))
      .map((p) => p.split(':')[0]!);
    assert.deepEqual(updates({ ...base, ...agents }), ['FLEET_RELEASE_PUBLIC_KEY_FILE', 'OBJECT_BUCKET_FILES']);
    assert.deepEqual(updates({ ...sovereign, ...agents }), [], 'the sovereign agent takes its updates as countersigned bundles');
  });

  test('production uses Cloud KMS or the UK HSM, never Vault, and never an emulator', () => {
    const production = { SILO_ENV: 'production', SILO_RELEASE: 'r1', PG_SSL: 'verify-full', SERVICE_TLS_CERT_FILE: file('cert', 'c') };
    const vault = problemsOf({ ...sovereign, ...production, DURABLE_BUS: 'jetstream', NATS_LIVE_URL: 'tls://nats:4222' });
    assert.ok(vault.some((p) => p.startsWith('KMS_PROVIDER: Vault is for development only')), vault.join('\n'));
    const cloudKmsInSovereign = problemsOf({ ...sovereign, ...production, KMS_PROVIDER: 'gcp_kms', VAULT_ADDR: undefined, VAULT_TOKEN: undefined });
    assert.ok(cloudKmsInSovereign.some((p) => p.startsWith('KMS_PROVIDER: the sovereign build uses the UK HSM')));
    const emulators = problemsOf({
      ...base, ...production, KMS_PROVIDER: 'gcp_kms', KMS_LOCAL_KEY: undefined,
      PUBSUB_EMULATOR_HOST: '127.0.0.1:8085', STORAGE_EMULATOR_HOST: 'http://127.0.0.1:4443',
      OBJECT_STORE: 'gcs', GCS_EMULATOR_ENDPOINT: 'http://127.0.0.1:4443',
    });
    assert.deepEqual(emulators.filter((p) => p.includes('emulator')).map((p) => p.split(':')[0]),
      ['PUBSUB_EMULATOR_HOST', 'STORAGE_EMULATOR_HOST', 'GCS_EMULATOR_ENDPOINT']);
    assert.ok(!emulators.some((p) => p.startsWith('KMS_PROVIDER')), 'Cloud KMS is right for a commercial cell');
    // Vault stays usable in development.
    assert.equal(loadConfig({ ...sovereign, DURABLE_BUS: 'jetstream', NATS_LIVE_URL: 'nats://nats:4222' }).kms?.provider, 'vault_transit');
  });

  test('the sovereign cell\'s HSM is a Thales Luna, its partition named by label (D206)', () => {
    const production = { SILO_ENV: 'production', SILO_RELEASE: 'r1', PG_SSL: 'verify-full', SERVICE_TLS_CERT_FILE: file('cert', 'c') };
    const hsm = { KMS_PROVIDER: 'pkcs11_hsm', VAULT_ADDR: undefined, VAULT_TOKEN: undefined, PKCS11_MODULE_PATH: '/usr/safenet/lunaclient/lib/libCryptoki2_64.so', PKCS11_PIN: 'pin' };
    const kmsProblems = (env: Env) => problemsOf({ ...sovereign, ...production, ...hsm, ...env }).filter((p) => p.startsWith('PKCS11_'));
    assert.deepEqual(kmsProblems({ PKCS11_SLOT: '0' }), ['PKCS11_PROFILE: the sovereign cell\'s HSM is a Thales Luna (luna)']);
    assert.deepEqual(kmsProblems({ PKCS11_PROFILE: 'luna', PKCS11_SLOT: '0' }), ['PKCS11_TOKEN_LABEL: a Luna partition is named by its label (PKCS11_PROFILE=luna)']);
    assert.deepEqual(kmsProblems({ PKCS11_PROFILE: 'luna', PKCS11_TOKEN_LABEL: 'silo-sov-ha' }), []);
    assert.deepEqual(kmsProblems({ PKCS11_PROFILE: 'luna', PKCS11_TOKEN_LABEL: 'silo-sov-ha', PKCS11_SLOT: '0' }),
      ['PKCS11_SLOT, PKCS11_TOKEN_LABEL: name the HSM\'s slot one way, by number or by token label']);
    assert.deepEqual(problemsOf({ ...base, PKCS11_PROFILE: 'luna' }).filter((p) => p.startsWith('PKCS11_')), ['PKCS11_PROFILE: only for KMS_PROVIDER=pkcs11_hsm']);
    // An on-premises install keeps its own HSM, whatever it is.
    const onPrem = problemsOf({ ...base, ...production, ...hsm, SILO_CELL_KIND: 'self_managed', KMS_LOCAL_KEY: undefined, PKCS11_SLOT: '1' });
    assert.ok(!onPrem.some((p) => p.startsWith('PKCS11_') || p.startsWith('KMS_PROVIDER')), onPrem.join('\n'));
  });

  test('a service never connects as a superuser or migration login', () => {
    const problems = problemsOf({ ...base, PG_CONTROL_URL: 'postgres://postgres:postgres@db/silo_cell' });
    assert.ok(problems.some((p) => p.startsWith('PG_CONTROL_URL:') && p.includes('migration')));
  });

  test('the credential service refuses to start without a KMS key (spec 61.1)', () => {
    const problems = problemsOf({ ...base, KMS_PROVIDER: undefined, KMS_LOCAL_KEY: undefined });
    assert.deepEqual(problems, ['KMS_PROVIDER: required by credential']);
  });

  test('the sovereign build loads with its own providers', () => {
    const config = loadConfig({ ...sovereign, DURABLE_BUS: 'jetstream', NATS_LIVE_URL: 'nats://nats:4222' });
    assert.equal(config.cell.capabilities.size, 0);
    assert.equal(config.bus.durableUrl, 'nats://nats:4222');
  });

  test('the sovereign build refuses what it compiles out (spec 6.5)', () => {
    const problems = problemsOf({
      ...sovereign,
      SILO_APPROVED_CAPABILITIES: 'siloes_capture,discovery',
      KMS_PROVIDER: 'gcp_kms',
      DURABLE_BUS: 'pubsub',
      PUBSUB_PROJECT_ID: 'silo-uk-sov-1',
      OBJECT_STORE: 'gcs',
      OTEL_EXPORTER_OTLP_ENDPOINT: 'https://collector.example.com:4318',
    });
    for (const expected of ['SILO_APPROVED_CAPABILITIES: discovery', 'KMS_PROVIDER: Cloud KMS', 'DURABLE_BUS:', 'OBJECT_STORE:',
      'OTEL_EXPORTER_OTLP_ENDPOINT:']) {
      assert.ok(problems.some((p) => p.startsWith(expected)), expected);
    }
    assert.ok(problemsOf({ ...sovereign, SILO_APPROVED_CAPABILITIES: undefined })
      .some((p) => p.startsWith('SILO_APPROVED_CAPABILITIES: required')));
    assert.ok(problemsOf({ ...sovereign, SILO_BUILD_TARGET: 'commercial' }).some((p) => p.startsWith('SILO_BUILD_TARGET:')));
  });

  test('model routes must be zero-retention and stay in the residency (spec 7.8, 62.7)', () => {
    const routes = file('routes.json', JSON.stringify([
      { role: 'compile', provider: 'vertex_ai', endpoint: 'https://europe-west2-aiplatform.googleapis.com', model: 'm', region: 'europe-west2', zeroRetention: true },
      { role: 'resolution', provider: 'vertex_ai', endpoint: 'https://us-east4-aiplatform.googleapis.com', model: 'm', region: 'us-east4', zeroRetention: true },
      { role: 'recognition', provider: 'vertex_ai', endpoint: 'https://europe-west2-aiplatform.googleapis.com', model: 'm', region: 'europe-west2', zeroRetention: false },
    ]));
    const problems = problemsOf({ ...base, SILO_SERVICE: 'model-gateway', MODEL_ROUTES_FILE: routes, REDIS_DATA_URL: 'redis://127.0.0.1:6379' });
    assert.deepEqual(problems, [
      'MODEL_ROUTES_FILE (resolution): region us-east4 is outside the uk residency (spec 7.8)',
      'MODEL_ROUTES_FILE (recognition): only zero-retention endpoints are permitted (spec 62.7)',
    ]);
    const sovereignRoutes = file('sov.json', JSON.stringify([
      { role: 'compile', provider: 'vertex_ai', endpoint: 'https://europe-west2-aiplatform.googleapis.com', model: 'm', region: 'europe-west2', zeroRetention: true },
    ]));
    assert.ok(problemsOf({ ...sovereign, MODEL_ROUTES_FILE: sovereignRoutes })
      .some((p) => p.includes('Vertex AI is not in this build')));
  });
});
