// The cell's Fleet agent applying the cell's own releases (spec 11.1 to 11.3): "A Fleet agent
// in each cell pulls its channel, applies releases, runs migrations, evaluates health gates
// and reports verdicts."
//
// Each pull asks fleet-control which release of the cell's channel the cell runs now
// (desiredRelease: the head once its wave has started, else the release before; after a gate
// failure or a halt, the release before). A release the cell does not run yet is checked first
// (the Silo release key's signature over the manifest, its digest, the cell's build target,
// only capabilities the cell's build approves), then applied:
//
// - Migrations (11.3), going forward only: a Job under the migration role, from one of the
//   release's own images, whose files must be exactly the release's migrations (the migrate
//   script refuses otherwise); the Secret holding the role's URL is mounted by the Job alone,
//   never read by the agent. Each cell migration is then reported applied. Going back to the
//   release before changes no schema: expand and contract keeps every release compatible.
// - The release's configuration, flags and model routing, each fetched by its digest, checked,
//   and kept in a ConfigMap the services mount, so a rollback brings them back too.
// - The images, by digest: the Deployments of each service (label silo.io/service), one
//   service at a time and one zone first (label topology.kubernetes.io/zone), each rolled
//   until every replica runs the new image and is available, within FLEET_ROLL_TIMEOUT_MINUTES.
//   fleet-control's own Deployment, which this agent runs in, goes last.
// - The connector catalogue's release, where the release carries one (D200), going forward
//   only: fetched by its digest, checked, and installed by catalogue, which checks its signature
//   with its own release key and installs nothing it has already.
//
// What the cell runs is kept in the ConfigMap silo-fleet-state, so an agent that restarts
// mid-apply, or rolled itself, carries on: every step is idempotent. A failed apply (the Job,
// a roll, a document) is recorded there and reported as a failing verdict, which halts the
// rollout and brings the cell, and every cell it reached, back to the release before; it is
// never retried. Applying a release is all-or-nothing from fleet-control's view: only a
// cell recorded as running it reports it healthy.
//
// Health gates (11.2): once a release applied in a started wave has run FLEET_GATE_WINDOW_MINUTES,
// each pull judges it (cellSignals.service.ts: error rate, latency, refusal rate against the
// release before, crash loops, the audit outbox backlog; and the synthetic question,
// subscription, Action and revert tests) and reports the verdict, the latest standing: one gate
// failing reports a failing verdict, which halts the rollout and brings the cell back; a
// passing verdict needs every gate, so it waits for the synthetic tests to have run.

import { createHash } from 'node:crypto';
import type { BuildTarget, Capability } from '../../config/cell.config.ts';
import { readReleaseDocument, type ReleaseDocument } from '../../contracts/fleet-control/releaseDocument.contract.ts';
import { installCatalogueRelease } from '../../contracts/catalogue/catalogue.contract.ts';
import { reportMigrationApplied } from '../../contracts/fleet-control/events.contract.ts';
import type { ReleaseManifest, SignatureRecord } from '../../contracts/fleet-control/release.contract.ts';
import { desiredRelease, reportVerdict } from '../../contracts/fleet-control/rollout.contract.ts';
import type { KubernetesClient } from '../../infra/kubernetes.infra.ts';
import type { Logger } from '../../infra/logger.infra.ts';
import type { ServiceClient } from '../../infra/serviceClient.infra.ts';
import { AppError, isAppError } from '../../utils/errors.util.ts';
import { sleep } from '../../utils/time.util.ts';
import { documentDigest, verifyDocument, type TrustedKey } from './signing.service.ts';
import { judgeGates, type GateSettings, type PodView, type SignalStore } from './cellSignals.service.ts';

export const SYNTHETIC_GATES = ['synthetic_question', 'synthetic_subscription', 'synthetic_action', 'synthetic_revert'] as const;
export type SyntheticGate = (typeof SYNTHETIC_GATES)[number];
export type JudgeOutcome = 'not_due' | 'passed' | 'failed' | 'waiting';

export type CellChannel = 'dev' | 'canary' | 'stable' | 'sovereign';

export interface CellReleaseDeps {
  services: ServiceClient;
  kube: KubernetesClient;
  logger: Logger;
  /** The Silo release key. */
  trusted: readonly TrustedKey[];
  cell: { id: string; buildTarget: BuildTarget; capabilities: ReadonlySet<Capability> };
  channel: CellChannel;
  /** What the cell's processes report, and the gates over it. */
  signals: SignalStore;
  gates: GateSettings;
  /** The synthetic tests' latest results for this release; undefined, or a gate missing, while they have not run. */
  synthetic?: (releaseId: string) => Promise<Partial<Record<SyntheticGate, boolean>> | undefined>;
  settings: {
    /** <repository>/<service>@sha256:<hex>. */
    imageRepository: string;
    migrationSecret: string;
    rollTimeoutMs: number;
    /** How often a roll or the Job is looked at; 5 seconds by default. */
    checkEveryMs?: number;
  };
}

/** What the cell runs, kept in the ConfigMap silo-fleet-state. */
export interface CellReleaseState {
  releaseId: string;
  manifestDigest: string;
  previousReleaseId: string | null;
  rolloutId: string | null;
  phase: 'applied' | 'failed';
  failure: string | null;
  at: string;
}

export type ApplyOutcome = 'none' | 'unchanged' | 'applied' | 'rolled_back' | 'failed';

const STATE = 'silo-fleet-state';
const SELF = 'fleet-control';
const DOCUMENT_MAPS: Record<ReleaseDocument, string> = {
  configuration: 'silo-release-configuration', flags: 'silo-release-flags', modelRouting: 'silo-release-model-routing',
};

interface Deployment {
  metadata: { name: string; generation?: number; labels?: Record<string, string> };
  spec: { replicas?: number; template: { spec: { containers: { name: string; image: string }[] } } };
  status?: {
    observedGeneration?: number; replicas?: number; updatedReplicas?: number; availableReplicas?: number; unavailableReplicas?: number;
    conditions?: { type: string; status: string; reason?: string }[];
  };
}

interface Job {
  status?: { succeeded?: number; failed?: number; conditions?: { type: string; status: string }[] };
}

interface ConfigMap {
  metadata: { name: string; resourceVersion?: string; annotations?: Record<string, string> };
  data?: Record<string, string>;
  binaryData?: Record<string, string>;
}

const failed = (code: string, message: string): AppError => new AppError('conflict', message, { code });

export function createCellReleases(deps: CellReleaseDeps) {
  const { kube } = deps;
  const ns = kube.namespace;
  const checkEvery = deps.settings.checkEveryMs ?? 5_000;
  const maps = `/api/v1/namespaces/${ns}/configmaps`;
  const deployments = `/apis/apps/v1/namespaces/${ns}/deployments`;
  const jobs = `/apis/batch/v1/namespaces/${ns}/jobs`;
  const image = (service: string, digest: string): string => `${deps.settings.imageRepository}/${service}@${digest}`;

  async function readState(): Promise<CellReleaseState | undefined> {
    const map = await kube.get<ConfigMap>(`${maps}/${STATE}`);
    const text = map?.data?.['state'];
    return text === undefined ? undefined : JSON.parse(text) as CellReleaseState;
  }

  async function writeState(state: CellReleaseState): Promise<void> {
    await putConfigMap({ metadata: { name: STATE }, data: { state: JSON.stringify(state) } });
  }

  async function putConfigMap(map: ConfigMap): Promise<void> {
    const created = await kube.create<ConfigMap>(maps, { apiVersion: 'v1', kind: 'ConfigMap', ...map });
    if (created !== 'exists') return;
    await kube.patch(`${maps}/${map.metadata.name}`, map);
  }

  /** The release as fleet-control signed it, for this cell; refused whole otherwise. */
  function check(release: { manifest: ReleaseManifest; manifestDigest: string; signatures: SignatureRecord[] }, releaseId: string): ReleaseManifest {
    const manifest = release.manifest;
    verifyDocument('release', manifest, release.signatures, deps.trusted, manifest.target === 'sovereign' ? ['release', 'sovereign'] : ['release']);
    if (documentDigest(manifest) !== release.manifestDigest || manifest.releaseId !== releaseId) {
      throw new AppError('integrity', 'the release is not the one fleet-control named', { code: 'fleet.release_mismatch' });
    }
    if (manifest.target !== deps.cell.buildTarget) {
      throw new AppError('integrity', `the release is a ${manifest.target} build; this cell runs ${deps.cell.buildTarget}`, { code: 'fleet.release_target' });
    }
    const unapproved = manifest.capabilities.find((c) => !deps.cell.capabilities.has(c));
    if (unapproved !== undefined) {
      throw new AppError('integrity', `the release needs ${unapproved}, which this cell's build does not approve`, { code: 'fleet.release_capability' });
    }
    return manifest;
  }

  /** The migration Job (11.3): from the release's own image, the role's URL from the Secret it alone mounts. */
  async function migrate(manifest: ReleaseManifest, manifestDigest: string, correlationId: string): Promise<void> {
    const cellMigrations = manifest.migrations.filter((m) => m.database === 'cell');
    if (cellMigrations.length === 0) return;
    const runner = manifest.images.find((i) => i.service === SELF) ?? manifest.images[0];
    if (runner === undefined) throw failed('fleet.migration_no_image', 'the release has no image to run its migrations from');
    const name = `silo-migrate-${manifestDigest.slice('sha256:'.length, 'sha256:'.length + 16)}`;
    await kube.create(jobs, {
      apiVersion: 'batch/v1', kind: 'Job',
      metadata: { name, labels: { 'silo.io/job': 'migrate' }, annotations: { 'silo.io/release': manifest.releaseId } },
      spec: {
        backoffLimit: 0, activeDeadlineSeconds: Math.ceil(deps.settings.rollTimeoutMs / 1000), ttlSecondsAfterFinished: 7 * 86_400,
        template: {
          metadata: { labels: { 'silo.io/job': 'migrate' } },
          spec: {
            restartPolicy: 'Never', automountServiceAccountToken: false,
            containers: [{
              name: 'migrate', image: image(runner.service, runner.digest), command: ['node', 'src/db/scripts/migrate.script.ts', 'cell'],
              env: [
                { name: 'CELL_MIGRATE_URL', valueFrom: { secretKeyRef: { name: deps.settings.migrationSecret, key: 'url' } } },
                { name: 'SILO_EXPECTED_MIGRATIONS', value: JSON.stringify(cellMigrations.map((m) => ({ version: m.version, name: m.name, digest: m.digest }))) },
              ],
            }],
          },
        },
      },
    });
    const deadline = Date.now() + deps.settings.rollTimeoutMs;
    for (;;) {
      const job = await kube.get<Job>(`${jobs}/${name}`);
      if (job === undefined) throw failed('fleet.migration_job_gone', 'the migration Job went before it finished');
      if ((job.status?.succeeded ?? 0) > 0) break;
      if ((job.status?.failed ?? 0) > 0 || job.status?.conditions?.some((c) => c.type === 'Failed' && c.status === 'True')) {
        throw failed('fleet.migration_failed', 'the migration Job failed: its log says why');
      }
      if (Date.now() > deadline) throw failed('fleet.migration_timeout', 'the migration Job did not finish in time');
      await sleep(checkEvery);
    }
    const appliedAt = new Date().toISOString();
    for (const m of cellMigrations) {
      await deps.services.call(reportMigrationApplied, {
        params: { cellId: deps.cell.id, releaseId: manifest.releaseId, database: 'cell', version: m.version }, body: { name: m.name, digest: m.digest, appliedAt },
      }, { correlationId });
    }
  }

  /** Each document, by its digest, into the ConfigMap the services mount. */
  async function documents(manifest: ReleaseManifest, correlationId: string): Promise<void> {
    const digests: Record<ReleaseDocument, string> = {
      configuration: manifest.configurationDigest, flags: manifest.flagsDigest, modelRouting: manifest.modelRoutingDigest,
    };
    for (const [kind, digest] of Object.entries(digests) as [ReleaseDocument, string][]) {
      const current = await kube.get<ConfigMap>(`${maps}/${DOCUMENT_MAPS[kind]}`);
      if (current?.metadata.annotations?.['silo.io/digest'] === digest) continue;
      const hex = digest.slice('sha256:'.length);
      const document = await deps.services.call(readReleaseDocument, { params: { sha256: hex } }, { correlationId });
      const bytes = Buffer.from(document.data, 'base64');
      if (createHash('sha256').update(bytes).digest('hex') !== hex) {
        throw new AppError('integrity', `the release's ${kind} document does not match its digest`, { code: 'fleet.release_document_mismatch' });
      }
      await putConfigMap({
        metadata: { name: DOCUMENT_MAPS[kind], annotations: { 'silo.io/digest': digest, 'silo.io/release': manifest.releaseId } },
        binaryData: { document: bytes.toString('base64') },
      });
    }
  }

  /** The catalogue's release the release carries: by its digest, checked, installed by catalogue. */
  async function catalogue(manifest: ReleaseManifest, correlationId: string): Promise<void> {
    if (manifest.catalogueDigest === undefined) return;
    const hex = manifest.catalogueDigest.slice('sha256:'.length);
    const document = await deps.services.call(readReleaseDocument, { params: { sha256: hex } }, { correlationId });
    const bytes = Buffer.from(document.data, 'base64');
    if (createHash('sha256').update(bytes).digest('hex') !== hex) {
      throw new AppError('integrity', 'the release\'s catalogue document does not match its digest', { code: 'fleet.release_document_mismatch' });
    }
    const signed = installCatalogueRelease.body.safeParse(JSON.parse(bytes.toString('utf8')));
    if (!signed.success) throw new AppError('integrity', 'the release\'s catalogue document is not a signed catalogue release', { code: 'fleet.catalogue_document_invalid' });
    await deps.services.call(installCatalogueRelease, { body: signed.data }, { correlationId, timeoutMs: 120_000 });
  }

  const rolled = (d: Deployment): boolean => {
    const want = d.spec.replicas ?? 1;
    const s = d.status ?? {};
    return (s.observedGeneration ?? 0) >= (d.metadata.generation ?? 0) && (s.updatedReplicas ?? 0) === want && (s.availableReplicas ?? 0) === want
      && (s.replicas ?? 0) === want && (s.unavailableReplicas ?? 0) === 0;
  };

  /** One service's Deployments onto its image: one zone first, each until every replica runs it and is available. */
  async function roll(service: string, digest: string, releaseId: string): Promise<number> {
    const list = await kube.get<{ items: Deployment[] }>(`${deployments}?labelSelector=${encodeURIComponent(`silo.io/service=${service}`)}`);
    const zone = (d: Deployment): string => d.metadata.labels?.['topology.kubernetes.io/zone'] ?? '';
    const items = (list?.items ?? []).sort((a, b) => zone(a).localeCompare(zone(b)) || a.metadata.name.localeCompare(b.metadata.name));
    const wanted = image(service, digest);
    let changed = 0;
    for (const item of items) {
      const container = item.spec.template.spec.containers.find((c) => c.name === service);
      if (container === undefined) throw failed('fleet.roll_container', `the ${item.metadata.name} Deployment has no ${service} container`);
      const path = `${deployments}/${item.metadata.name}`;
      if (container.image !== wanted) {
        await kube.patch(path, {
          metadata: { annotations: { 'silo.io/release': releaseId } },
          // SILO_RELEASE: the release the process reports its health signals under.
          spec: { template: { metadata: { annotations: { 'silo.io/release': releaseId } }, spec: { containers: [{ name: service, image: wanted, env: [{ name: 'SILO_RELEASE', value: releaseId }] }] } } },
        });
        changed += 1;
      }
      const deadline = Date.now() + deps.settings.rollTimeoutMs;
      for (;;) {
        const now = await kube.get<Deployment>(path);
        if (now === undefined) throw failed('fleet.roll_gone', `the ${item.metadata.name} Deployment went while it rolled`);
        if (rolled(now)) break;
        if (now.status?.conditions?.some((c) => c.type === 'Progressing' && c.reason === 'ProgressDeadlineExceeded')) {
          throw failed('fleet.roll_stalled', `the ${item.metadata.name} Deployment stopped progressing`);
        }
        if (Date.now() > deadline) throw failed('fleet.roll_timeout', `the ${item.metadata.name} Deployment did not roll in time`);
        await sleep(checkEvery);
      }
    }
    return changed;
  }

  async function failVerdict(rolloutId: string | null, releaseId: string, correlationId: string): Promise<void> {
    if (rolloutId === null) return;
    // A verdict missing any gate is a failure (11.2): the rollout halts and brings the cell back.
    await deps.services.call(reportVerdict, {
      params: { rolloutId, cellId: deps.cell.id }, body: { releaseId, gates: [{ gate: 'crash_loops', passed: false }] },
    }, { correlationId }).catch((error: unknown) => {
      deps.logger.failure('a failed release could not be reported', error, { event: 'fleet.verdict_unreported', resourceType: 'release', resourceId: releaseId });
    });
  }

  /** A release the cell runs, in a started wave, judged once it has run the window; the verdict reported. */
  async function judge(state: CellReleaseState, rolloutId: string, correlationId: string): Promise<JudgeOutcome> {
    if (Date.now() - Date.parse(state.at) < deps.gates.windowMs) return 'not_due';
    const fresh = deps.gates.freshMs;
    const pods = await kube.get<{ items: PodView[] }>(`/api/v1/namespaces/${ns}/pods?labelSelector=${encodeURIComponent('silo.io/service')}`);
    const judged = judgeGates({
      releaseId: state.releaseId, current: deps.signals.on(state.releaseId, fresh),
      previous: state.previousReleaseId === null ? [] : deps.signals.on(state.previousReleaseId),
      outboxOldest: deps.signals.gauge('audit_outbox_oldest_seconds', fresh), pods: pods?.items ?? [],
    }, deps.gates);
    const synthetic = (await deps.synthetic?.(state.releaseId)) ?? {};
    const gates = [...judged, ...SYNTHETIC_GATES.flatMap((gate) => (synthetic[gate] === undefined ? [] : [{ gate, passed: synthetic[gate]! }]))];
    const failing = gates.some((g) => !g.passed);
    // A passing verdict carries every gate; until the synthetic tests have run, only a failure is reported.
    if (!failing && gates.length < judged.length + SYNTHETIC_GATES.length) return 'waiting';
    await deps.services.call(reportVerdict, { params: { rolloutId, cellId: deps.cell.id }, body: { releaseId: state.releaseId, gates } }, { correlationId });
    if (failing) {
      deps.logger.warn('a release failed its health gates', {
        event: 'fleet.gates_failed', resourceType: 'release', resourceId: state.releaseId, count: gates.filter((g) => !g.passed).length,
        reason: gates.filter((g) => !g.passed).map((g) => g.gate).join(','),
      });
    }
    return failing ? 'failed' : 'passed';
  }

  return {
    channel: deps.channel,
    readState,

    /** Judges the release the cell runs now, if its wave has started and the window has passed. */
    async judge(correlationId: string): Promise<JudgeOutcome> {
      const desired = await deps.services.call(desiredRelease, { params: { cellId: deps.cell.id }, query: { channel: deps.channel } }, { correlationId });
      const state = await readState();
      if (state?.phase !== 'applied' || desired.reason !== 'wave_started' || desired.rolloutId === null || state.releaseId !== desired.releaseId) return 'not_due';
      return judge(state, desired.rolloutId, correlationId);
    },

    /** One pull: apply what fleet-control says the cell runs, if it does not run it yet. */
    async apply(correlationId: string): Promise<ApplyOutcome> {
      const desired = await deps.services.call(desiredRelease, { params: { cellId: deps.cell.id }, query: { channel: deps.channel } }, { correlationId });
      if (desired.releaseId === null || desired.release === null) return 'none';
      const state = await readState();
      if (state?.releaseId === desired.releaseId && state.manifestDigest === desired.release.manifestDigest) {
        if (state.phase === 'failed' && desired.reason === 'wave_started') await failVerdict(desired.rolloutId, desired.releaseId, correlationId);
        if (state.phase === 'applied' && desired.reason === 'wave_started' && desired.rolloutId !== null) await judge(state, desired.rolloutId, correlationId);
        return state.phase === 'failed' ? 'failed' : 'unchanged';
      }
      const forward = desired.reason === 'wave_started' || desired.reason === 'current';
      const manifest = check(desired.release, desired.releaseId);
      const record = (phase: CellReleaseState['phase'], failure: string | null): CellReleaseState => ({
        releaseId: manifest.releaseId, manifestDigest: desired.release!.manifestDigest,
        previousReleaseId: state?.phase === 'applied' ? state.releaseId : state?.previousReleaseId ?? null, rolloutId: desired.rolloutId, phase, failure,
        at: new Date().toISOString(),
      });
      try {
        if (forward) await migrate(manifest, desired.release.manifestDigest, correlationId);
        await documents(manifest, correlationId);
        if (forward) await catalogue(manifest, correlationId);
        let changed = 0;
        const order = [...manifest.images].sort((a, b) => Number(a.service === SELF) - Number(b.service === SELF));
        for (const { service, digest } of order) {
          // Its own Deployment last: the state is written first, so the agent that comes up on it finds the release applied.
          if (service === SELF) await writeState(record('applied', null));
          changed += await roll(service, digest, manifest.releaseId);
        }
        await writeState(record('applied', null));
        deps.logger.info('cell release applied', {
          event: 'fleet.cell_release_applied', resourceType: 'release', resourceId: manifest.releaseId, outcome: desired.reason, count: changed,
        });
        return forward ? 'applied' : 'rolled_back';
      } catch (error) {
        const code = isAppError(error) ? error.code : 'fleet.apply_failed';
        await writeState(record('failed', code)).catch(() => undefined);
        deps.logger.failure('a cell release could not be applied', error, { event: 'fleet.cell_release_failed', resourceType: 'release', resourceId: manifest.releaseId });
        if (desired.reason === 'wave_started') await failVerdict(desired.rolloutId, manifest.releaseId, correlationId);
        return 'failed';
      }
    },
  };
}

export type CellReleases = ReturnType<typeof createCellReleases>;

/** A JSON document the agent keeps in a ConfigMap of its own (the synthetic tenant's setup). */
export function configMapStore<T>(kube: KubernetesClient, name: string) {
  const path = `/api/v1/namespaces/${kube.namespace}/configmaps`;
  return {
    async read(): Promise<T | undefined> {
      const map = await kube.get<ConfigMap>(`${path}/${name}`);
      const text = map?.data?.['document'];
      return text === undefined ? undefined : JSON.parse(text) as T;
    },
    async write(value: T): Promise<void> {
      const body = { metadata: { name }, data: { document: JSON.stringify(value) } };
      if (await kube.create(path, { apiVersion: 'v1', kind: 'ConfigMap', ...body }) === 'exists') await kube.patch(`${path}/${name}`, body);
    },
  };
}
