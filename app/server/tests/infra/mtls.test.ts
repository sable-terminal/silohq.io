// Service calls over mTLS with per-cell workload identities (spec 7.1). A throwaway CA
// issues each service a certificate naming spiffe://<cell>/service/<name>; the callee
// accepts a caller only if its certificate comes from the CA, names this cell, and names
// a service the contract lists. A global-tier service, outside every cell, accepts any
// cell the CA issued and tells the handler which one called. Health probes need no
// certificate.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:https';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { z } from 'zod';
import { loadConfig, type Config } from '../../src/config/index.config.ts';
import { defineContract } from '../../src/contracts/endpoint.contract.ts';
import { route } from '../../src/infra/http.infra.ts';
import { createLogger } from '../../src/infra/logger.infra.ts';
import { createServiceClient } from '../../src/infra/serviceClient.infra.ts';
import { defineService } from '../../src/infra/service.infra.ts';
import { runProcess, type RunningProcess } from '../../src/process.ts';

const dir = mkdtempSync(path.join(tmpdir(), 'silo-mtls-'));
const file = (name: string): string => path.join(dir, name);
const openssl = (...args: string[]): void => {
  execFileSync('openssl', args, { cwd: dir, stdio: 'ignore' });
};

// A certificate signed by the test CA, with these subject alternative names.
function issue(name: string, altNames: string): void {
  writeFileSync(file(`${name}.ext`), `subjectAltName=${altNames}\nextendedKeyUsage=serverAuth,clientAuth\n`);
  openssl('req', '-newkey', 'rsa:2048', '-nodes', '-keyout', `${name}.key`, '-out', `${name}.csr`, '-subj', `/CN=${name}`);
  openssl('x509', '-req', '-in', `${name}.csr`, '-CA', 'ca.crt', '-CAkey', 'ca.key', '-CAcreateserial', '-out', `${name}.crt`,
    '-days', '1', '-extfile', `${name}.ext`);
}

const whoCalled = defineContract({
  service: 'workspace', name: 'whoCalled', method: 'GET', path: '/v1/caller', callers: ['gateway', 'outbox-relay'],
  context: 'none', idempotency: 'none', response: z.object({ caller: z.string() }),
});

// A global-tier route: it answers with the caller's cell.
const whichCell = defineContract({
  service: 'status', name: 'whichCell', method: 'GET', path: '/v1/cell', callers: ['gateway'],
  context: 'none', idempotency: 'none', response: z.object({ caller: z.string(), cell: z.string() }),
});

const status = defineService({
  name: 'status',
  needs: {},
  create: () => ({ routes: [route(whichCell, { handle: async (_input, ctx) => ({ caller: ctx.caller, cell: ctx.callerCell }) })] }),
});

const workspace = defineService({
  name: 'workspace',
  needs: {},
  create: () => ({ routes: [route(whoCalled, { handle: async (_input, ctx) => ({ caller: ctx.caller }) })] }),
});

const logger = createLogger({ service: 'workspace', cell: 'uk-lon-1', release: 'test', level: 'error', write: () => undefined });

const tlsEnv = (name: string): Record<string, string> => ({
  SERVICE_TLS_CERT_FILE: file(`${name}.crt`), SERVICE_TLS_KEY_FILE: file(`${name}.key`), SERVICE_TLS_CA_FILE: file('ca.crt'),
});

const configFor = (service: string, cert: string, extra: Record<string, string> = {}): Config => loadConfig({
  SILO_ENV: 'test', SILO_SERVICE: service, SILO_CELL_ID: 'uk-lon-1', SILO_CELL_KIND: 'commercial', SILO_RESIDENCY: 'uk',
  SILO_HOSTING: 'gke', SILO_BUILD_TARGET: 'commercial', HTTP_HOST: '127.0.0.1', HTTP_PORT: '0', HTTP_DRAIN_SECONDS: '0',
  // The real workspace service's needs; the fake one here opens neither.
  PG_CONTROL_URL: 'postgres://unused@127.0.0.1:1/unused', REDIS_DATA_URL: 'redis://127.0.0.1:1/0',
  ...tlsEnv(cert), ...extra,
});

let server: RunningProcess;
let url: string;
let globalServer: RunningProcess;
let globalUrl: string;

before(async () => {
  openssl('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'ca.key', '-out', 'ca.crt', '-days', '1', '-subj', '/CN=silo-test-ca');
  issue('workspace', 'URI:spiffe://uk-lon-1/service/workspace,DNS:localhost,IP:127.0.0.1');
  issue('gateway', 'URI:spiffe://uk-lon-1/service/gateway');
  issue('ask', 'URI:spiffe://uk-lon-1/service/ask');
  issue('foreign', 'URI:spiffe://us-east-1/service/gateway');
  // A process hosting maintenance and outbox-relay carries both identities.
  issue('shared', 'URI:spiffe://uk-lon-1/service/maintenance,URI:spiffe://uk-lon-1/service/outbox-relay');
  server = await runProcess([workspace], configFor('workspace', 'workspace'), { logger });
  url = `https://localhost:${server.port}`;
  issue('status', 'URI:spiffe://global/service/status,DNS:localhost,IP:127.0.0.1');
  globalServer = await runProcess([status], loadConfig({
    SILO_ENV: 'test', SILO_SERVICE: 'status', SILO_CELL_ID: 'global', SILO_CELL_KIND: 'commercial', SILO_RESIDENCY: 'uk',
    SILO_HOSTING: 'gke', SILO_BUILD_TARGET: 'commercial', HTTP_HOST: '127.0.0.1', HTTP_PORT: '0', HTTP_DRAIN_SECONDS: '0',
    PG_DIRECTORY_URL: 'postgres://unused@127.0.0.1:1/unused', STATUS_PUBLISH_DIR: dir, ...tlsEnv('status'),
  }), { logger });
  globalUrl = `https://localhost:${globalServer.port}`;
});

after(async () => {
  await server?.stop('test');
  await globalServer?.stop('test');
  rmSync(dir, { recursive: true, force: true });
});

// A client needs only the HTTP section: its identity is the certificate it presents. The
// config is loaded as a service with no needs, so the client's own settings are not required.
const clientAs = (service: 'gateway' | 'ask' | 'outbox-relay', cert: string) => {
  const config = configFor('workspace', cert);
  return createServiceClient({ caller: service, http: { ...config.http, serviceUrls: { workspace: url } } });
};

// A request with the CA trusted and, optionally, no client certificate at all.
const plainGet = (pathname: string): Promise<number> => new Promise((resolve, reject) => {
  const req = request(`${url}${pathname}`, { ca: readFileSync(file('ca.crt')), minVersion: 'TLSv1.3' }, (res) => {
    res.resume();
    resolve(res.statusCode ?? 0);
  });
  req.on('error', reject);
  req.end();
});

describe('mTLS between services (spec 7.1)', () => {
  test('a listed service of this cell is accepted, by the identity in its certificate', async () => {
    const gateway = clientAs('gateway', 'gateway');
    assert.deepEqual(await gateway.call(whoCalled, {}), { caller: 'gateway' });
    gateway.close();
  });

  test('a process hosting several services calls as the one the contract lists', async () => {
    const relay = clientAs('outbox-relay', 'shared');
    assert.deepEqual(await relay.call(whoCalled, {}), { caller: 'outbox-relay' });
    relay.close();
  });

  test('a certificate from another cell, or naming an unlisted service, is refused', async () => {
    const foreign = clientAs('gateway', 'foreign');
    await assert.rejects(foreign.call(whoCalled, {}), { category: 'unauthenticated', code: 'caller.unknown_identity' });
    foreign.close();
    const askConfig = configFor('workspace', 'ask');
    const ask = createServiceClient({ caller: 'gateway', http: { ...askConfig.http, serviceUrls: { workspace: url } } });
    await assert.rejects(ask.call(whoCalled, {}), { category: 'forbidden', code: 'caller.not_listed' });
    ask.close();
  });

  test('a global-tier service accepts any cell the CA issued, and the handler sees which', async () => {
    for (const [cert, cell] of [['gateway', 'uk-lon-1'], ['foreign', 'us-east-1']] as const) {
      const config = configFor('workspace', cert);
      const client = createServiceClient({ caller: 'gateway', http: { ...config.http, serviceUrls: { status: globalUrl } } });
      assert.deepEqual(await client.call(whichCell, {}), { caller: 'gateway', cell });
      client.close();
    }
  });

  test('no client certificate: contract routes refuse, health probes answer', async () => {
    assert.equal(await plainGet('/v1/caller'), 401);
    assert.equal(await plainGet('/healthz'), 200);
    assert.equal(await plainGet('/readyz'), 200);
  });

  test('production refuses to run without TLS', () => {
    assert.throws(() => loadConfig({
      SILO_ENV: 'production', SILO_SERVICE: 'workspace', SILO_CELL_ID: 'uk-lon-1', SILO_CELL_KIND: 'commercial',
      SILO_RESIDENCY: 'uk', SILO_HOSTING: 'gke', SILO_BUILD_TARGET: 'commercial', SILO_RELEASE: 'r1', PG_SSL: 'verify-full',
    }), /SERVICE_TLS_CERT_FILE/);
  });
});
