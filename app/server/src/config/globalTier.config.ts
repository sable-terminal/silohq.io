// The global tier (spec 6.2, 11, 13.2): directory, status and fleet-control, outside every
// cell. The sovereign cell and a self-managed install run their own (spec 6.5, review D6).
//
// directory: which version of the directory hashing key KMS_DIRECTORY_KEY_URI is, the
// earlier versions a lookup still tries while cells re-register under a new key, and the
// public listener the login page calls to find a cell. Cells read keyVersion too: they
// hash the addresses they register with the same key (spec 6.2).
// status: where the public status document is written (static hosting apart from every
// cell), how often, how long a cell may stay silent before its components show unknown,
// and how long resolved notices stay on the page.
// fleet-control: the artefact store, the signing key and which role it signs as (the Silo
// release key, or the sovereign release key in the sovereign fleet-control), the release
// public key a sovereign fleet-control checks before countersigning, the internal test
// and canary cells of waves 0 and 1 (spec 11.2), and the grace after a wave's soak before
// a missing health signal halts the rollout.
//
// FLEET_ROLE: fleet-control is the global tier's (control, the default), or a cell's Fleet agent
// (cell_agent), which runs under the same name inside the cell, pulls the cell's agent channel
// every FLEET_AGENT_POLL_MINUTES, checks it with the Silo release key
// (FLEET_RELEASE_PUBLIC_KEY_FILE) and installs it for the cell's agents (spec 10.7, 11.1). That
// key is also what connect-runtime checks agent releases against before offering them.
// With FLEET_KUBERNETES set (in_cluster, or the API server's URL), the Fleet agent also
// applies the cell's own releases (spec 11.1 to 11.3): every FLEET_RELEASE_POLL_MINUTES it asks
// fleet-control which release of its channel (FLEET_CHANNEL; stable, or sovereign in a
// sovereign cell) the cell runs, checks it, runs its migrations as a Job holding the
// FLEET_MIGRATION_SECRET it never reads, and rolls the services' images by digest from
// FLEET_IMAGE_REPOSITORY, one service at a time, one zone first, each within
// FLEET_ROLL_TIMEOUT_MINUTES.
//
// Signing in the HSM (spec 11.1) waits on the HSM adapter, as KMS does (spec 6.5, open
// decision 5); until then production refuses a key file (index.config).

import { createPrivateKey, createPublicKey, type KeyObject } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { parseSection, read, readSecret, zList, zPositiveInt, type Env } from './env.config.ts';

const cellId = z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'must be a cell identifier such as uk-lon-1');
const keyEntry = /^([1-9][0-9]{0,4})=(\S+)$/;

const directorySchema = z.object({
  keyVersion: zPositiveInt(32_767).default(1),
  previousKeys: zList.pipe(z.array(z.string().regex(keyEntry, 'each entry is <version>=<key uri>'))).default([]),
  // Unset: no public listener (a process that only takes registrations).
  publicPort: z.coerce.number().int().min(0).max(65_535).optional(),
  publicHost: z.string().default('0.0.0.0'),
  publicOrigins: zList.pipe(z.array(z.url())).default([]),
  publicRequestsPerMinute: zPositiveInt(100_000).default(30),
});

const statusSchema = z.object({
  publishDir: z.string().min(1).optional(),
  publishIntervalSeconds: zPositiveInt(3_600).default(30),
  staleAfterSeconds: zPositiveInt(86_400).default(180),
  noticeRetentionDays: zPositiveInt(3_650).default(90),
});

const fleetSchema = z.object({
  role: z.enum(['control', 'cell_agent']).default('control'),
  agentPollMinutes: zPositiveInt(24 * 60).default(15),
  artefactDir: z.string().min(1).optional(),
  signingRole: z.enum(['release', 'sovereign']).default('release'),
  testCells: zList.pipe(z.array(cellId)).default([]),
  canaryCells: zList.pipe(z.array(cellId)).default([]),
  verdictGraceMinutes: zPositiveInt(24 * 60).default(30),
  advisoryUrl: z.string().regex(/^(https?|file):\/\/\S+$/, 'an https: or file: URL').optional(),
  advisorySyncHours: zPositiveInt(24 * 7).default(24),
  advisoryMaxAgeHours: zPositiveInt(24 * 30).default(48),
  advisoryEcosystems: zList.pipe(z.array(z.string().regex(/^[A-Za-z0-9._-]{1,64}$/))).default([]),
  changeNoticeHours: zPositiveInt(24 * 30).default(72),
  releasePollMinutes: zPositiveInt(24 * 60).default(5),
  channel: z.enum(['dev', 'canary', 'stable', 'sovereign']).optional(),
  kubernetes: z.union([z.enum(['none', 'in_cluster']), z.url({ protocol: /^https?$/ })]).default('none'),
  kubernetesTokenFile: z.string().min(1).optional(),
  kubernetesCaFile: z.string().min(1).optional(),
  kubernetesNamespace: z.string().regex(/^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/).optional(),
  imageRepository: z.string().regex(/^[a-z0-9.-]+(:[0-9]+)?(\/[a-z0-9._-]+)+$/, 'a registry path such as europe-west2-docker.pkg.dev/silo/cells').optional(),
  migrationSecret: z.string().regex(/^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/).default('silo-migrate'),
  rollTimeoutMinutes: zPositiveInt(24 * 60).default(15),
  gateWindowMinutes: zPositiveInt(24 * 60).default(15),
  syntheticPort: z.coerce.number().int().min(0).max(65_535).optional(),
  syntheticHost: z.string().default('0.0.0.0'),
  syntheticUrl: z.url({ protocol: /^https?$/ }).optional(),
  gatewayUrl: z.url({ protocol: /^https?$/ }).optional(),
  gatewayOrigin: z.url({ protocol: /^https?$/ }).optional(),
  syntheticMinutes: zPositiveInt(24 * 60).default(10),
  cellStatus: z.enum(['provisioning', 'active', 'closed_to_placement', 'draining', 'retired']).default('active'),
  reportSeconds: zPositiveInt(3_600).default(60),
});

/** OSV's public exports (spec 11.1): what the commercial fleet-control mirrors advisories from. */
export const OSV_EXPORTS = 'https://osv-vulnerabilities.storage.googleapis.com';

export interface DirectoryKey {
  version: number;
  keyUri: string;
}

export interface GlobalTierConfig {
  directory: {
    /** Which version of the directory key KMS_DIRECTORY_KEY_URI is; registrations use it. */
    keyVersion: number;
    /** Earlier versions, still tried by lookups. */
    previousKeys: DirectoryKey[];
    publicPort: number | undefined;
    publicHost: string;
    /** Origins of the login page allowed to call the public listener from a browser. */
    publicOrigins: string[];
    /** Per client address, per minute, per process. The load balancer limits first. */
    publicRequestsPerMinute: number;
  };
  status: {
    publishDir: string | undefined;
    publishIntervalSeconds: number;
    staleAfterSeconds: number;
    noticeRetentionDays: number;
  };
  fleet: {
    /** The global tier's fleet-control, or a cell's Fleet agent running under its name. */
    role: 'control' | 'cell_agent';
    /** How often a cell's Fleet agent pulls its agent channel. */
    agentPollMinutes: number;
    artefactDir: string | undefined;
    /** Ed25519 private key; a key file until the HSM adapter exists. */
    signingKey: KeyObject | undefined;
    signingRole: 'release' | 'sovereign';
    /**
     * The Silo release public key: what a sovereign fleet-control checks before it countersigns,
     * and what a cell checks agent releases against (its Fleet agent, then connect-runtime).
     */
    releasePublicKey: KeyObject | undefined;
    /** The sovereign release public key: what a sovereign cell checks its agent-sovereign heads against (D202). */
    sovereignPublicKey: KeyObject | undefined;
    testCells: string[];
    canaryCells: string[];
    verdictGraceMinutes: number;
    /**
     * Where advisories are mirrored from (FLEET_ADVISORY_URL): OSV's exports by default for the
     * release key's fleet-control; none for the sovereign one, which promotes nothing.
     */
    advisoryUrl: string | undefined;
    advisorySyncHours: number;
    advisoryMaxAgeHours: number;
    advisoryEcosystems: string[];
    /** How long ahead a dedicated cell's customer is told of a release, before it may start (spec 11.5). */
    changeNoticeHours: number;
    /** A cell's Fleet agent: how often it asks which release the cell runs. */
    releasePollMinutes: number;
    /** The channel the cell follows; unset: stable, or sovereign in a sovereign cell. */
    channel: 'dev' | 'canary' | 'stable' | 'sovereign' | undefined;
    /** Where the cell's Kubernetes API is: none (the agent applies no cell release), in_cluster, or its URL. */
    kubernetes: string;
    kubernetesTokenFile: string | undefined;
    kubernetesCaFile: string | undefined;
    kubernetesNamespace: string | undefined;
    /** The registry path a service's image is under: <repository>/<service>@sha256:<hex>. */
    imageRepository: string | undefined;
    /** The Secret holding the migration role's URL, mounted only by the migration Job. */
    migrationSecret: string;
    rollTimeoutMinutes: number;
    /** How long a release runs in the cell before its health gates judge it. */
    gateWindowMinutes: number;
    /** The synthetic tests (spec 11.2): where the agent serves the fixture source, its public URL behind the ingress. */
    syntheticPort: number | undefined;
    syntheticHost: string;
    syntheticUrl: string | undefined;
    /** The gateway's public listener the tests go through, and the public origin it expects. */
    gatewayUrl: string | undefined;
    gatewayOrigin: string | undefined;
    /** How often a round of the synthetic tests runs. */
    syntheticMinutes: number;
    /** What the agent registers the cell as in the directory: active, unless operations close, drain or retire it. */
    cellStatus: 'provisioning' | 'active' | 'closed_to_placement' | 'draining' | 'retired';
    /** How often the agent reports status and carries the change policy and Fleet's events. */
    reportSeconds: number;
  };
}

function ed25519Private(pem: string | undefined, variable: string, problems: string[]): KeyObject | undefined {
  if (pem === undefined) return undefined;
  try {
    const key = createPrivateKey(pem);
    if (key.asymmetricKeyType === 'ed25519') return key;
  } catch {
    // Reported below without echoing the value.
  }
  problems.push(`${variable}: must be an Ed25519 private key in PKCS#8 PEM`);
  return undefined;
}

function ed25519PublicFile(path: string | undefined, variable: string, problems: string[]): KeyObject | undefined {
  if (path === undefined) return undefined;
  try {
    const key = createPublicKey(readFileSync(path, 'utf8'));
    if (key.asymmetricKeyType === 'ed25519') return key;
  } catch {
    // Reported below.
  }
  problems.push(`${variable}: must name a file holding an Ed25519 public key in PEM`);
  return undefined;
}

export function loadGlobalTierConfig(env: Env, problems: string[]): GlobalTierConfig | undefined {
  const directory = parseSection(directorySchema, {
    keyVersion: read(env, 'DIRECTORY_KEY_VERSION'),
    previousKeys: read(env, 'DIRECTORY_PREVIOUS_KEYS'),
    publicPort: read(env, 'DIRECTORY_PUBLIC_PORT'),
    publicHost: read(env, 'DIRECTORY_PUBLIC_HOST'),
    publicOrigins: read(env, 'DIRECTORY_PUBLIC_ORIGINS'),
    publicRequestsPerMinute: read(env, 'DIRECTORY_PUBLIC_REQUESTS_PER_MINUTE'),
  }, {
    keyVersion: 'DIRECTORY_KEY_VERSION', previousKeys: 'DIRECTORY_PREVIOUS_KEYS', publicPort: 'DIRECTORY_PUBLIC_PORT',
    publicHost: 'DIRECTORY_PUBLIC_HOST', publicOrigins: 'DIRECTORY_PUBLIC_ORIGINS',
    publicRequestsPerMinute: 'DIRECTORY_PUBLIC_REQUESTS_PER_MINUTE',
  }, problems);
  const status = parseSection(statusSchema, {
    publishDir: read(env, 'STATUS_PUBLISH_DIR'),
    publishIntervalSeconds: read(env, 'STATUS_PUBLISH_INTERVAL_SECONDS'),
    staleAfterSeconds: read(env, 'STATUS_STALE_AFTER_SECONDS'),
    noticeRetentionDays: read(env, 'STATUS_NOTICE_RETENTION_DAYS'),
  }, {
    publishDir: 'STATUS_PUBLISH_DIR', publishIntervalSeconds: 'STATUS_PUBLISH_INTERVAL_SECONDS',
    staleAfterSeconds: 'STATUS_STALE_AFTER_SECONDS', noticeRetentionDays: 'STATUS_NOTICE_RETENTION_DAYS',
  }, problems);
  const fleet = parseSection(fleetSchema, {
    role: read(env, 'FLEET_ROLE'),
    agentPollMinutes: read(env, 'FLEET_AGENT_POLL_MINUTES'),
    artefactDir: read(env, 'FLEET_ARTEFACT_DIR'),
    signingRole: read(env, 'FLEET_SIGNING_ROLE'),
    testCells: read(env, 'FLEET_TEST_CELLS'),
    canaryCells: read(env, 'FLEET_CANARY_CELLS'),
    verdictGraceMinutes: read(env, 'FLEET_VERDICT_GRACE_MINUTES'),
    advisoryUrl: read(env, 'FLEET_ADVISORY_URL'),
    advisorySyncHours: read(env, 'FLEET_ADVISORY_SYNC_HOURS'),
    advisoryMaxAgeHours: read(env, 'FLEET_ADVISORY_MAX_AGE_HOURS'),
    advisoryEcosystems: read(env, 'FLEET_ADVISORY_ECOSYSTEMS'),
    changeNoticeHours: read(env, 'FLEET_CHANGE_NOTICE_HOURS'),
    releasePollMinutes: read(env, 'FLEET_RELEASE_POLL_MINUTES'),
    channel: read(env, 'FLEET_CHANNEL'),
    kubernetes: read(env, 'FLEET_KUBERNETES'),
    kubernetesTokenFile: read(env, 'FLEET_KUBERNETES_TOKEN_FILE'),
    kubernetesCaFile: read(env, 'FLEET_KUBERNETES_CA_FILE'),
    kubernetesNamespace: read(env, 'FLEET_KUBERNETES_NAMESPACE'),
    imageRepository: read(env, 'FLEET_IMAGE_REPOSITORY'),
    migrationSecret: read(env, 'FLEET_MIGRATION_SECRET'),
    rollTimeoutMinutes: read(env, 'FLEET_ROLL_TIMEOUT_MINUTES'),
    gateWindowMinutes: read(env, 'FLEET_GATE_WINDOW_MINUTES'),
    syntheticPort: read(env, 'FLEET_SYNTHETIC_PORT'),
    syntheticHost: read(env, 'FLEET_SYNTHETIC_HOST'),
    syntheticUrl: read(env, 'FLEET_SYNTHETIC_URL'),
    gatewayUrl: read(env, 'FLEET_GATEWAY_URL'),
    gatewayOrigin: read(env, 'FLEET_GATEWAY_ORIGIN'),
    syntheticMinutes: read(env, 'FLEET_SYNTHETIC_MINUTES'),
    cellStatus: read(env, 'FLEET_CELL_STATUS'),
    reportSeconds: read(env, 'FLEET_REPORT_SECONDS'),
  }, {
    role: 'FLEET_ROLE', agentPollMinutes: 'FLEET_AGENT_POLL_MINUTES',
    artefactDir: 'FLEET_ARTEFACT_DIR', signingRole: 'FLEET_SIGNING_ROLE', testCells: 'FLEET_TEST_CELLS',
    canaryCells: 'FLEET_CANARY_CELLS', verdictGraceMinutes: 'FLEET_VERDICT_GRACE_MINUTES', advisoryUrl: 'FLEET_ADVISORY_URL',
    advisorySyncHours: 'FLEET_ADVISORY_SYNC_HOURS', advisoryMaxAgeHours: 'FLEET_ADVISORY_MAX_AGE_HOURS',
    advisoryEcosystems: 'FLEET_ADVISORY_ECOSYSTEMS', changeNoticeHours: 'FLEET_CHANGE_NOTICE_HOURS',
    releasePollMinutes: 'FLEET_RELEASE_POLL_MINUTES', channel: 'FLEET_CHANNEL', kubernetes: 'FLEET_KUBERNETES',
    kubernetesTokenFile: 'FLEET_KUBERNETES_TOKEN_FILE', kubernetesCaFile: 'FLEET_KUBERNETES_CA_FILE',
    kubernetesNamespace: 'FLEET_KUBERNETES_NAMESPACE', imageRepository: 'FLEET_IMAGE_REPOSITORY',
    migrationSecret: 'FLEET_MIGRATION_SECRET', rollTimeoutMinutes: 'FLEET_ROLL_TIMEOUT_MINUTES', gateWindowMinutes: 'FLEET_GATE_WINDOW_MINUTES',
    syntheticPort: 'FLEET_SYNTHETIC_PORT', syntheticHost: 'FLEET_SYNTHETIC_HOST', syntheticUrl: 'FLEET_SYNTHETIC_URL', gatewayUrl: 'FLEET_GATEWAY_URL',
    gatewayOrigin: 'FLEET_GATEWAY_ORIGIN', syntheticMinutes: 'FLEET_SYNTHETIC_MINUTES', cellStatus: 'FLEET_CELL_STATUS',
    reportSeconds: 'FLEET_REPORT_SECONDS',
  }, problems);
  const signingKey = ed25519Private(readSecret(env, 'FLEET_SIGNING_KEY', problems), 'FLEET_SIGNING_KEY', problems);
  const releasePublicKey = ed25519PublicFile(read(env, 'FLEET_RELEASE_PUBLIC_KEY_FILE'), 'FLEET_RELEASE_PUBLIC_KEY_FILE', problems);
  const sovereignPublicKey = ed25519PublicFile(read(env, 'FLEET_SOVEREIGN_PUBLIC_KEY_FILE'), 'FLEET_SOVEREIGN_PUBLIC_KEY_FILE', problems);
  if (!directory || !status || !fleet) return undefined;

  const previousKeys = directory.previousKeys.map((entry) => {
    const [, version, keyUri] = keyEntry.exec(entry)!;
    return { version: Number(version), keyUri: keyUri! };
  });
  const versions = previousKeys.map((k) => k.version);
  if (versions.includes(directory.keyVersion) || new Set(versions).size !== versions.length) {
    problems.push('DIRECTORY_PREVIOUS_KEYS: each version once, and not the current DIRECTORY_KEY_VERSION');
  }
  if (fleet.signingRole === 'sovereign' && signingKey !== undefined && releasePublicKey === undefined) {
    problems.push('FLEET_RELEASE_PUBLIC_KEY_FILE: required to countersign, so the release signature is checked first (spec 11.4)');
  }
  const advisoryUrl = fleet.advisoryUrl ?? (fleet.signingRole === 'release' ? OSV_EXPORTS : undefined);
  if (fleet.signingRole === 'sovereign' && advisoryUrl !== undefined && /^https?:\/\/[^/]*(googleapis\.com|osv\.dev)(:|\/|$)/i.test(advisoryUrl)) {
    problems.push('FLEET_ADVISORY_URL: the sovereign tier depends on no US-owned provider (spec 6.5): a UK mirror, or a file: copy');
  }
  if (advisoryUrl?.startsWith('http:') && !/^http:\/\/(127\.0\.0\.1|localhost)(:|\/)/.test(advisoryUrl)) {
    problems.push('FLEET_ADVISORY_URL: https:, or file: for a copy brought in on media');
  }
  if (fleet.kubernetes.startsWith('http:') && !/^http:\/\/(127\.0\.0\.1|localhost)(:|\/)/.test(fleet.kubernetes)) {
    problems.push('FLEET_KUBERNETES: in_cluster, or the API server\'s https: URL');
  }
  if ((fleet.syntheticPort === undefined) !== (fleet.syntheticUrl === undefined) || (fleet.syntheticPort !== undefined && fleet.gatewayUrl === undefined)) {
    problems.push('FLEET_SYNTHETIC_PORT, FLEET_SYNTHETIC_URL and FLEET_GATEWAY_URL: set together, for the synthetic tests (spec 11.2)');
  }
  if (fleet.role === 'cell_agent' && fleet.kubernetes !== 'none' && fleet.imageRepository === undefined) {
    problems.push('FLEET_IMAGE_REPOSITORY: required for the Fleet agent to roll the cell\'s images by digest');
  }
  return {
    directory: { ...directory, publicPort: directory.publicPort, previousKeys },
    status: { ...status, publishDir: status.publishDir },
    fleet: {
      ...fleet, artefactDir: fleet.artefactDir, signingKey, releasePublicKey, sovereignPublicKey, advisoryUrl, channel: fleet.channel, kubernetesTokenFile: fleet.kubernetesTokenFile,
      kubernetesCaFile: fleet.kubernetesCaFile, kubernetesNamespace: fleet.kubernetesNamespace, imageRepository: fleet.imageRepository,
      syntheticPort: fleet.syntheticPort, syntheticUrl: fleet.syntheticUrl, gatewayUrl: fleet.gatewayUrl,
      gatewayOrigin: fleet.gatewayOrigin ?? (fleet.gatewayUrl === undefined ? undefined : new URL(fleet.gatewayUrl).origin),
    },
  };
}
