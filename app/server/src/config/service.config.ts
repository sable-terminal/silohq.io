// Which service this process is, in which environment, from which release.

import { z } from 'zod';
import { parseSection, read, type Env } from './env.config.ts';

// The service catalogue (docs/siloServiceCatalogue.doc.md, which replaces the table in
// spec chapter 7). "A service not in this catalogue does not exist." silo-agent is a
// static binary, not one of these.
export const SERVICES = [
  // Global tier
  'directory', 'fleet-control', 'status',
  // Entry and identity
  'gateway', 'auth', 'policy', 'admin-portal',
  // Connect: source layer, building and running connectors, catalogue
  'connect-registry', 'connect-runtime', 'oauth', 'credential', 'discovery', 'change-stream',
  'connector-builder', 'visual-builder', 'schema-inference', 'conformance', 'connector-maintenance',
  'pushdown-compiler', 'expression-evaluator', 'catalogue',
  // Ontology and query
  'ontology', 'resolution', 'compile', 'planner', 'executor', 'search', 'lineage',
  // Clones and the operational layer
  'state-plane', 'workspace', 'ask', 'studio', 'canvas-layout', 'recognition', 'simulation', 'scheduler',
  // Write-back
  'actions', 'approvals', 'revert',
  // Storage
  'siloes-capture', 'siloes-import', 'files', 'render',
  // BigQuery
  'warehouse-provisioner', 'warehouse-schema', 'warehouse-sync', 'warehouse-reconcile', 'import-loader', 'index-builder',
  'bigquery-metering', 'warehouse-access',
  // AI
  'model-gateway', 'fde-orchestrator',
  // Commercial
  'metering', 'billing',
  // Platform and operations
  'audit', 'notify', 'outbox-relay', 'maintenance', 'tenant-migrations', 'org-export',
] as const;

export type ServiceName = (typeof SERVICES)[number];

/**
 * The global tier runs outside every cell (spec 5, 6), so every registered cell calls it:
 * its routes accept a service certificate from any cell the tier's CA issued, and tell the
 * handler which cell called. Every other service accepts its own cell only.
 */
export const GLOBAL_SERVICES: readonly ServiceName[] = ['directory', 'fleet-control', 'status'];
export const isGlobalService = (name: ServiceName): boolean => GLOBAL_SERVICES.includes(name);

export const ENVIRONMENTS = ['development', 'test', 'production'] as const;
export type Environment = (typeof ENVIRONMENTS)[number];

const serviceName = z.enum(SERVICES, { message: 'must name a service in the catalogue (spec 7)' });

const schema = z.object({
  environment: z.enum(ENVIRONMENTS),
  service: serviceName,
  // Services sharing this process (docs/siloServiceCatalogue.doc.md: maintenance,
  // outbox-relay and tenant-migrations run together at first). Names stay separate, so
  // each can move to its own process without changing an interface.
  hosted: z.array(serviceName).min(1).optional(),
  release: z.string().regex(/^[A-Za-z0-9._+-]{1,128}$/, 'must be the Fleet release identifier').default('dev'),
});

export interface ServiceConfig {
  environment: Environment;
  /** This process's identity: logs, metrics, the database application name. */
  service: ServiceName;
  /** Every service this process runs, the identity first. */
  hosted: ServiceName[];
  release: string;
}

export function loadServiceConfig(env: Env, problems: string[]): ServiceConfig | undefined {
  const services = read(env, 'SILO_SERVICES');
  const parsed = parseSection(schema, {
    environment: read(env, 'SILO_ENV'),
    service: read(env, 'SILO_SERVICE'),
    hosted: services === undefined ? undefined : services.split(',').map((s) => s.trim()).filter(Boolean),
    release: read(env, 'SILO_RELEASE'),
  }, { environment: 'SILO_ENV', service: 'SILO_SERVICE', hosted: 'SILO_SERVICES', release: 'SILO_RELEASE' }, problems);
  // Fleet records which release configured a cell (spec 11.1); production has no default.
  if (parsed?.environment === 'production' && read(env, 'SILO_RELEASE') === undefined) {
    problems.push('SILO_RELEASE: required in production');
  }
  if (!parsed) return undefined;
  const hosted = [parsed.service, ...(parsed.hosted ?? []).filter((s) => s !== parsed.service)];
  if (new Set(parsed.hosted ?? []).size !== (parsed.hosted ?? []).length) problems.push('SILO_SERVICES: names a service twice');
  return { environment: parsed.environment, service: parsed.service, hosted, release: parsed.release };
}
