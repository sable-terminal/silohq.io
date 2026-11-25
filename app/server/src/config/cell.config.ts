// The cell this process runs in (spec 6): identity, kind, residency, hostnames, and the
// capability set of its build.
//
// A cell keeps its identifier and hostnames wherever it is recovered (spec 12.3), so
// both are configuration, never derived from the region.

import { z } from 'zod';
import { parseSection, read, zBool, zList, type Env } from './env.config.ts';

// Values match platform.cells (design, D4 and D6).
export const CELL_KINDS = ['commercial', 'sovereign', 'dedicated', 'self_managed'] as const;
export const RESIDENCIES = ['uk', 'eu', 'us'] as const;
export const HOSTINGS = ['gke', 'conformant_kubernetes', 'customer_cloud', 'customer_premises'] as const;
export const BUILD_TARGETS = ['commercial', 'sovereign'] as const;
export type BuildTarget = (typeof BUILD_TARGETS)[number];

// Capabilities a build can carry. The sovereign build compiles some out (spec 6.5); a
// capability absent from the approved set is unreachable: infra refuses to construct
// its adapter.
export const CAPABILITIES = [
  'discovery', 'siloes_capture', 'siloes_import', 'object_index', 'warehouse',
  'bigquery', 'gcs', 'vertex_ai', 'cloud_kms', 'stripe', 'telemetry_export', 'email_fallback',
] as const;
export type Capability = (typeof CAPABILITIES)[number];

// What each build target may carry. Sovereign: agent discovery, BigQuery, GCS, Warehouse,
// Vertex AI, Cloud KMS, Stripe and telemetry export are compiled out; Siloes and the
// email fallback only where a UK-resident store or mail relay is configured.
export const BUILD_CAPABILITIES: Record<(typeof BUILD_TARGETS)[number], readonly Capability[]> = {
  commercial: CAPABILITIES,
  sovereign: ['siloes_capture', 'siloes_import', 'object_index', 'email_fallback'],
};

const schema = z.object({
  id: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'must be a cell identifier such as uk-lon-1'),
  kind: z.enum(CELL_KINDS),
  residency: z.enum(RESIDENCIES),
  hosting: z.enum(HOSTINGS),
  buildTarget: z.enum(BUILD_TARGETS),
  domain: z.string().regex(/^[a-z0-9-]+(\.[a-z0-9-]+)+$/, 'must be a DNS domain').default('silohq.io'),
  airGapped: zBool.default(false),
  approvedCapabilities: zList.pipe(z.array(z.enum(CAPABILITIES))).optional(),
});

export interface CellConfig {
  id: string;
  kind: (typeof CELL_KINDS)[number];
  residency: (typeof RESIDENCIES)[number];
  hosting: (typeof HOSTINGS)[number];
  buildTarget: (typeof BUILD_TARGETS)[number];
  airGapped: boolean;
  capabilities: ReadonlySet<Capability>;
  /** Spec 5.3, 6.1: every cell has its own entry, OAuth callback, webhook and agent hosts. */
  hosts: { app: string; oauthCallbackUrl: string; hooks: string; agent: string };
}

export function loadCellConfig(env: Env, problems: string[]): CellConfig | undefined {
  const parsed = parseSection(schema, {
    id: read(env, 'SILO_CELL_ID'),
    kind: read(env, 'SILO_CELL_KIND'),
    residency: read(env, 'SILO_RESIDENCY'),
    hosting: read(env, 'SILO_HOSTING'),
    buildTarget: read(env, 'SILO_BUILD_TARGET'),
    domain: read(env, 'SILO_DOMAIN'),
    airGapped: read(env, 'SILO_AIR_GAPPED'),
    // Empty is meaningful here: no optional capability approved.
    approvedCapabilities: env['SILO_APPROVED_CAPABILITIES'],
  }, {
    id: 'SILO_CELL_ID', kind: 'SILO_CELL_KIND', residency: 'SILO_RESIDENCY', hosting: 'SILO_HOSTING',
    buildTarget: 'SILO_BUILD_TARGET', domain: 'SILO_DOMAIN', airGapped: 'SILO_AIR_GAPPED',
    approvedCapabilities: 'SILO_APPROVED_CAPABILITIES',
  }, problems);
  if (!parsed) return undefined;

  if (parsed.kind === 'sovereign' && parsed.buildTarget !== 'sovereign') {
    problems.push('SILO_BUILD_TARGET: a sovereign cell runs the sovereign build (spec 6.5)');
  }
  if (parsed.kind === 'sovereign' && parsed.residency !== 'uk') {
    problems.push('SILO_RESIDENCY: the sovereign cell is UK only (spec 6.1)');
  }
  if (parsed.airGapped && parsed.kind !== 'self_managed') {
    problems.push('SILO_AIR_GAPPED: only a self-managed install can be air-gapped');
  }

  // The image carries its build target's capabilities; the approved set may narrow them,
  // never widen them. A sovereign cell must state its approved set, and refuses to start
  // when it names a capability the build compiles out (spec 6.5).
  const allowed = new Set(BUILD_CAPABILITIES[parsed.buildTarget]);
  const approved = parsed.approvedCapabilities;
  if (parsed.buildTarget === 'sovereign' && approved === undefined) {
    problems.push('SILO_APPROVED_CAPABILITIES: required for the sovereign build (may be empty)');
  }
  for (const capability of approved ?? []) {
    if (!allowed.has(capability)) {
      problems.push(`SILO_APPROVED_CAPABILITIES: ${capability} is not in the ${parsed.buildTarget} build`);
    }
  }
  const capabilities = new Set<Capability>(approved ?? (parsed.buildTarget === 'sovereign' ? [] : BUILD_CAPABILITIES.commercial));

  const base = `${parsed.id}.${parsed.domain}`;
  return {
    id: parsed.id,
    kind: parsed.kind,
    residency: parsed.residency,
    hosting: parsed.hosting,
    buildTarget: parsed.buildTarget,
    airGapped: parsed.airGapped,
    capabilities,
    hosts: {
      app: `app.${base}`,
      oauthCallbackUrl: `https://oauth.${base}/callback`,
      hooks: `hooks.${base}`,
      agent: `agent.${base}:443`,
    },
  };
}
