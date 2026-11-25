// Import boundaries, checked on every build:
// - layers depend downwards only: utils <- config <- infra <- repos <- services <-
//   middleware <- controllers <- routes, with models (types), schemas (Zod, typed by the
//   models) and contracts (service endpoints, built from schemas) beneath infra, and
//   workers beside controllers. The process (src/process.ts), the service registry
//   (src/app.ts) and the entry point sit above them all;
// - SQL and provider names: see sql.test.ts and providers.test.ts;
// - the single mediator (spec 61.3, 61.8, open decision 59): only the credential service
//   opens, seals or re-wraps a secret. "It is to become a lint rule and an import-boundary
//   check that fail the build." This is that check.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { all, imports, resolveImport } from './source.helper.ts';

// What each layer may import from inside src (by top-level folder); packages are free.
const ALLOWED: Record<string, string[]> = {
  utils: ['utils'],
  config: ['config', 'utils'],
  models: ['models'],
  schemas: ['schemas', 'models', 'utils'],
  contracts: ['contracts', 'schemas', 'models', 'utils', 'config'],
  infra: ['infra', 'config', 'utils', 'contracts'],
  repos: ['repos', 'models', 'infra', 'utils'],
  db: ['db', 'models', 'repos', 'infra', 'config', 'utils'],
  services: ['services', 'repos', 'infra', 'contracts', 'schemas', 'models', 'config', 'utils'],
  // The steps every request passes (src/middleware): no repos, so no request step reads
  // the database itself; a step that needs a decision asks a service.
  middleware: ['middleware', 'services', 'infra', 'contracts', 'schemas', 'models', 'config', 'utils'],
  controllers: ['controllers', 'middleware', 'services', 'repos', 'infra', 'contracts', 'schemas', 'models', 'config', 'utils'],
  workers: ['workers', 'middleware', 'services', 'repos', 'infra', 'contracts', 'schemas', 'models', 'config', 'utils'],
  routes: ['routes', 'controllers', 'workers', 'middleware', 'services', 'repos', 'infra', 'contracts', 'schemas', 'models', 'config', 'utils'],
  // Operational scripts outside a service process (src/scripts): a build step putting an artefact.
  scripts: ['scripts', 'services', 'infra', 'contracts', 'config', 'utils'],
};

test('layers import downwards only', () => {
  const violations: string[] = [];
  for (const { file, source } of all) {
    const layer = file.split('/')[0]!;
    const allowed = ALLOWED[layer];
    if (allowed === undefined) continue;
    for (const target of imports(source).filter((t) => t.startsWith('.'))) {
      const resolved = resolveImport(file, target);
      const targetLayer = resolved.split('/')[0]!;
      if (!allowed.includes(targetLayer)) violations.push(`${file} imports ${resolved}`);
    }
  }
  assert.deepEqual(violations, []);
});

// Services reach Postgres through a transaction-mode pooler (spec 8.2: "session-scoped
// features are forbidden in application code"). Each of these would outlive its
// transaction on a server connection that the next client inherits. Migration jobs and
// the database scripts (src/db) connect directly and are exempt.
const SESSION_FEATURES: [string, RegExp][] = [
  ['session SET (use set_config(..., true) in a transaction)', /['"`]\s*set\s+(?!local\b)(?:session\s+)?[a-z_.]+\s*(?:=|to\b)/i],
  ['SET ROLE', /['"`]\s*set\s+(?:session\s+)?role\b/i],
  ['set_config(..., false)', /set_config\([^)]*,\s*false\s*\)/i],
  ['session advisory lock (use pg_advisory_xact_lock)', /pg_(?:try_)?advisory_lock(?:_shared)?\s*\(/i],
  ['LISTEN', /['"`]\s*(?:un)?listen\s/i],
  ['temporary table', /create\s+(?:local\s+|global\s+)?temp(?:orary)?\s+table/i],
  ['cursor WITH HOLD', /\bwith\s+hold\b/i],
  ['named prepared statement', /\bname\s*:\s*['"`][^'"`]+['"`]\s*,\s*text\s*:/],
];

test('service code uses nothing that outlives a transaction (spec 8.2)', () => {
  const violations: string[] = [];
  for (const { file, source } of all) {
    if (file.startsWith('db/')) continue;
    for (const [feature, pattern] of SESSION_FEATURES) {
      if (pattern.test(source)) violations.push(`${file}: ${feature}`);
    }
  }
  assert.deepEqual(violations, []);
});

test('only the credential service opens, seals or re-wraps a secret (spec 61.3)', () => {
  const mediator = /^services[\\/]credential(?:[\\/][^\\/]+|[^\\/]*)\.service\.ts$/;
  const offenders = all
    .filter(({ file }) => file !== 'utils/envelope.util.ts' && !mediator.test(file))
    .filter(({ source }) => /\b(withOpened|seal|rewrap)\b/.test(
      imports(source).some((t) => t.endsWith('envelope.util.ts')) ? source.replace(/import[\s\S]*?;/g, '') : ''))
    .map(({ file }) => file);
  assert.deepEqual(offenders, []);
});
