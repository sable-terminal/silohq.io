// Silo Agent updates through Fleet (spec 10.7, 11.4; contracts/connect-runtime/agentEndpoint.contract.ts
// and agentRelease.contract.ts).
//
// - Releases: the cell's Fleet agent installs each release of the cell's agent channel. Before
//   any agent is offered it, it is checked again here: the channel head and the manifest, as
//   signed, by the Silo release key; the head naming this manifest on this cell's channel; the
//   build target; and every platform's binary, in object-files by digest, hashed whole.
// - Rollouts (11.4): the newest release rolls through the agents of automatic pools in waves:
//   Silo's own organisations, then a stable 5% of agents, 25%, all, each soaking 24 hours (a
//   wave with no agents passes at once). Every minute the gates are read over the agents it
//   reached: one that took the release and has not come back on it within 30 minutes, or that
//   came back and stopped heartbeating within its first hour, fails the heartbeat gate; one
//   failing more than 5% of at least 20 pieces of work and twice its rate before fails the
//   error-rate gate; an agent refusing the release, or undoing it because it would not start,
//   fails it too. A failed gate halts the rollout, and every agent it updated is told to go
//   back to the version it ran before. A newer release supersedes a running rollout.
// - Offers (10.7): an agent asks hourly. A pinned pool takes its pinned version, an approval
//   pool the version approved, an automatic pool the rolling release once the agent's wave has
//   started (the last release fully rolled out before then); a pin or an approval overrides
//   the waves. Only a later version than the agent runs is offered, and a pool's agents update
//   one at a time: the next is offered it once the one before came back on it, or after 30 minutes.
// - Versions (10.7): an agent older than the last three minor releases the cell has received
//   is outdated, and refused 90 days later. A refused agent is given no work, but may update.
//
// What an agent did is audited: agent_updated when it reports another version, and
// agent_update_refused when it refuses or undoes one (spec 10.9).

import { createHash } from 'node:crypto';
import type { BuildTarget } from '../../config/cell.config.ts';
import {
  RELEASE_FAULTS, type AgentUpdateOffer, type AgentUpdateReport,
} from '../../contracts/connect-runtime/agentEndpoint.contract.ts';
import type { SignatureRecord } from '../../contracts/fleet-control/release.contract.ts';
import type { Logger } from '../../infra/logger.infra.ts';
import { objectKey, type ObjectStore } from '../../infra/objectStorage.infra.ts';
import { inTransaction, type Databases, type Queryable } from '../../infra/postgres.infra.ts';
import type { AgentRelease } from '../../models/connect/agentRelease.model.ts';
import type { AgentRollout } from '../../models/connect/agentRollout.model.ts';
import { agentPoolRepo, agentReleaseRepo, agentRepo, agentRolloutRepo } from '../../repos/connect/index.repo.ts';
import { AppError, fromDatabaseError } from '../../utils/errors.util.ts';
import { uuidv7 } from '../../utils/id.util.ts';
import { isNewer, outdatedFloor, REFUSED_AFTER_DAYS, versionParts } from '../connect-registry/agentVersions.service.ts';
import { recordConnectEvent } from '../connect-registry/connectEvents.service.ts';
import { agentChannelFor, checkAgentRelease, type SignedText } from '../fleet-control/agentRelease.service.ts';
import type { TrustedKey } from '../fleet-control/signing.service.ts';

export interface UpdateDeps {
  databases: Databases;
  logger: Logger;
  /** object-files, where the cell's Fleet agent puts the binaries; without it, nothing is installed or offered. */
  objects: ObjectStore | undefined;
  /** The Silo release key; without it, nothing is installed. */
  trusted: readonly TrustedKey[];
  target: BuildTarget;
  /** Silo's own organisations in this cell: the first wave. */
  firstOrganisations: readonly string[];
  soakHours?: number;
  now?: () => number;
}

export interface Binary {
  platform: string;
  version: string;
  digest: string;
  bytes: number;
}

/** How long an agent has to come back on a release it took. */
export const RETURN_MINUTES = 30;
/** The error-rate gate: at least this much work, failing more than this share and twice the rate before. */
export const GATE_MIN_WORK = 20;
export const GATE_MAX_FAILED_SHARE = 0.05;
const READ_PART_BYTES = 4 * 1024 * 1024;
const LAST_WAVE = 3;

const hexOf = (digest: string): string => digest.slice('sha256:'.length);
const binariesOf = (release: AgentRelease): Binary[] => release.binaries as unknown as Binary[];
const signaturesOf = (value: unknown): SignatureRecord[] => value as SignatureRecord[];

export function createAgentUpdates(deps: UpdateDeps) {
  const control = deps.databases.pool('control');
  const now = deps.now ?? Date.now;
  const soakMs = (deps.soakHours ?? 24) * 3_600_000;
  const channel = agentChannelFor(deps.target);
  const at = (): string => new Date(now()).toISOString();

  /** The SHA-256 of an object, read in parts, and its size. */
  async function hashObject(hex: string): Promise<{ hex: string; bytes: number } | undefined> {
    const key = objectKey.agentBinary(hex);
    const head = await deps.objects!.head('files', key);
    if (head === undefined) return undefined;
    const hash = createHash('sha256');
    for (let start = 0; start < head.bytes; start += READ_PART_BYTES) {
      hash.update(await deps.objects!.getRange('files', key, start, Math.min(head.bytes, start + READ_PART_BYTES) - 1));
    }
    return { hex: hash.digest('hex'), bytes: head.bytes };
  }

  /** The agent holding this certificate, as its organisation sees it. */
  async function agentOf(fingerprint: Buffer) {
    const found = await inTransaction(control, {}, (db) => agentRepo.resolve(db, fingerprint), { readOnly: true });
    if (found === undefined) throw new AppError('unauthenticated', 'no agent holds this certificate', { code: 'agent.unknown' });
    if (found.status === 'revoked') throw new AppError('forbidden', 'the agent is revoked', { code: 'agent.revoked' });
    return found;
  }

  /** The release an automatic pool's agent may take now: the rolling one once its wave started, else the last rolled out. */
  async function rollingFor(db: Queryable, organisationId: string, agentId: string): Promise<string | undefined> {
    const rollouts = await agentRolloutRepo.list(db, 20);
    const running = rollouts.find((r) => r.status === 'running');
    if (running !== undefined && await agentRepo.wave(db, organisationId, agentId, deps.firstOrganisations) <= running.wave) return running.version;
    return rollouts.find((r) => r.status === 'completed')?.version;
  }

  async function halt(db: Queryable, rollout: AgentRollout, reason: NonNullable<AgentRollout['haltReason']>, detail: Record<string, number | string>): Promise<void> {
    await agentRolloutRepo.update(db, rollout.id, { status: 'halted', haltReason: reason, haltDetail: detail, endedAt: at() });
    deps.logger.warn('an agent rollout failed its gates: halted, and the agents it updated go back', {
      event: 'agent.rollout_halted', resourceType: 'agent_rollout', resourceId: rollout.id, reason, outcome: rollout.version,
    });
  }

  return {
    channel,

    /** A release the cell's Fleet agent carried in: checked, then kept for the agents (installAgentRelease). */
    async install(signed: { head: SignedText; release: SignedText }): Promise<{ releaseId: string; version: string; installed: boolean }> {
      if (deps.objects === undefined || deps.trusted.length === 0) {
        throw new AppError('configuration', 'this cell has no Silo release key or object storage for agent releases', { code: 'agent.updates_unavailable' });
      }
      const checked = checkAgentRelease(signed, deps.trusted, { channel, target: deps.target });
      const { manifest } = checked;
      const version = manifest.agentBinaries[0]!.version;
      const known = await inTransaction(control, {}, async (db) => ({
        byId: await agentReleaseRepo.findByReleaseId(db, manifest.releaseId),
        byVersion: await agentReleaseRepo.findByVersion(db, version),
      }), { readOnly: true });
      if (known.byId !== undefined) return { releaseId: manifest.releaseId, version, installed: false };
      if (known.byVersion !== undefined) {
        // The same agent binaries in a later release: nothing new for the agents.
        const same = (binariesOf(known.byVersion)).every((b) => manifest.agentBinaries.some((m) => m.platform === b.platform && m.digest === b.digest))
          && manifest.agentBinaries.length === binariesOf(known.byVersion).length;
        if (same) return { releaseId: known.byVersion.releaseId, version, installed: false };
        throw new AppError('conflict', 'a release already installed carries other binaries under this agent version', { code: 'agent.release_version_reused' });
      }
      const binaries: Binary[] = [];
      for (const binary of manifest.agentBinaries) {
        const held = await hashObject(hexOf(binary.digest));
        if (held === undefined) throw new AppError('conflict', `the ${binary.platform} binary is not in the cell's storage`, { code: 'agent.binary_missing' });
        if (held.hex !== hexOf(binary.digest)) {
          throw new AppError('integrity', `the ${binary.platform} binary in storage does not match its digest`, {
            code: 'agent.binary_mismatch', details: { platform: binary.platform },
          });
        }
        binaries.push({ platform: binary.platform, version: binary.version, digest: binary.digest, bytes: held.bytes });
      }
      try {
        await inTransaction(control, {}, (db) => agentReleaseRepo.insert(db, {
          releaseId: manifest.releaseId, version, target: manifest.target, channel, channelSequence: checked.head.sequence,
          manifest: signed.release.text, manifestDigest: checked.manifestDigest, signatures: signed.release.signatures as never,
          head: signed.head.text, headSignatures: signed.head.signatures as never, binaries: binaries as never,
        }));
      } catch (error) {
        // Another replica installed it first.
        if (fromDatabaseError(error).category === 'conflict') return { releaseId: manifest.releaseId, version, installed: false };
        throw error;
      }
      deps.logger.info('agent release installed', { event: 'agent.release_installed', resourceType: 'agent_release', outcome: version, count: binaries.length });
      return { releaseId: manifest.releaseId, version, installed: true };
    },

    /** What the agent should do now (GET /v1/update). */
    async offer(fingerprint: Buffer): Promise<AgentUpdateOffer> {
      const found = await agentOf(fingerprint);
      if (deps.objects === undefined) return { action: 'none' };
      return inTransaction(control, { organisationId: found.organisationId }, async (db): Promise<AgentUpdateOffer> => {
        const agent = (await agentRepo.findById(db, found.id))!;
        // Locked: of the pool's agents, one at a time takes an update.
        const pool = (await agentPoolRepo.lock(db, agent.poolId))!;
        if (pool.updatePolicy === 'automatic' && agent.previousVersion !== null) {
          const [latest] = await agentRolloutRepo.list(db, 1);
          if (latest?.status === 'halted' && latest.version === agent.version && Date.parse(agent.versionSince) >= Date.parse(latest.startedAt)) {
            return { action: 'rollback', version: agent.previousVersion };
          }
        }
        const wanted = pool.updatePolicy === 'pinned' ? pool.pinnedVersion
          : pool.updatePolicy === 'approval' ? pool.approvedVersion
            : await rollingFor(db, agent.organisationId, agent.id);
        if (wanted === null || wanted === undefined || !isNewer(wanted, agent.version)) return { action: 'none' };
        const release = await agentReleaseRepo.findByVersion(db, wanted);
        const binary = release === undefined ? undefined : binariesOf(release).find((b) => b.platform === agent.platform);
        if (release === undefined || binary === undefined) return { action: 'none' };
        const recent = new Date(now() - RETURN_MINUTES * 60_000);
        const taking = agent.updatingTo === wanted && agent.updateStartedAt !== null && Date.parse(agent.updateStartedAt) > recent.getTime();
        if (!taking) {
          if (await agentRepo.updatingInPool(db, agent.poolId, agent.id, recent)) return { action: 'none' };
          await agentRepo.update(db, agent.id, { updatingTo: wanted, updateStartedAt: at() });
          deps.logger.info('agent offered an update', {
            event: 'agent.update_offered', organisationId: agent.organisationId, resourceId: agent.id, outcome: wanted, reason: pool.updatePolicy,
          });
        }
        return {
          action: 'update', version: wanted, platform: binary.platform as never, digest: binary.digest, bytes: binary.bytes,
          head: { text: release.head, signatures: signaturesOf(release.headSignatures) },
          release: { text: release.manifest, signatures: signaturesOf(release.signatures) },
        };
      });
    },

    /** A binary of a release the cell holds, for the agent's own platform (GET /v1/update/binary/:sha256). */
    async binary(fingerprint: Buffer, hex: string): Promise<{ bytes: number; read(start: number, end: number): Promise<Buffer> }> {
      const found = await agentOf(fingerprint);
      const objects = deps.objects;
      if (objects === undefined) throw new AppError('not_found', 'no such binary', { code: 'agent.binary_unknown' });
      const held = await inTransaction(control, { organisationId: found.organisationId }, async (db) => {
        const agent = (await agentRepo.findById(db, found.id))!;
        const releases = await agentReleaseRepo.list(db);
        return releases.flatMap(binariesOf).find((b) => b.digest === `sha256:${hex}` && b.platform === agent.platform);
      }, { readOnly: true });
      if (held === undefined) throw new AppError('not_found', 'no such binary for this agent', { code: 'agent.binary_unknown' });
      const key = objectKey.agentBinary(hex);
      return { bytes: held.bytes, read: (start, end) => objects.getRange('files', key, start, end) };
    },

    /** The agent refused an update, or undid one (POST /v1/update/report). */
    async report(fingerprint: Buffer, report: AgentUpdateReport, correlationId: string): Promise<void> {
      const found = await agentOf(fingerprint);
      await inTransaction(control, { organisationId: found.organisationId }, async (db) => {
        const agent = (await agentRepo.findById(db, found.id))!;
        if (agent.updatingTo === report.version) await agentRepo.update(db, agent.id, { updatingTo: null, updateStartedAt: null });
        await recordConnectEvent(db, {
          organisationId: agent.organisationId, correlationId, event: 'agent_update_refused', service: 'connect-runtime',
          resourceType: 'agent', resourceId: agent.id,
          detail: { pool_id: agent.poolId, version: report.version, outcome: report.outcome, reason: report.reason, running: agent.version },
        });
        const pool = await agentPoolRepo.findById(db, agent.poolId);
        if (pool?.updatePolicy === 'automatic' && RELEASE_FAULTS.includes(report.reason)) {
          const running = await agentRolloutRepo.lockRunning(db);
          if (running?.version === report.version) await halt(db, running, 'refused', { reason: report.reason });
        }
      });
      deps.logger.warn('an agent refused an update', {
        event: 'agent.update_refused', organisationId: found.organisationId, resourceId: found.id, reason: report.reason, outcome: report.version,
      });
    },

    /**
     * Every minute, from every replica (one at a time, by the rollout's lock): a newer release
     * starts its rollout; the running one is gated, and moves on when its wave has soaked or has
     * no one in it; agents are judged against the last three minor releases.
     */
    async tick(): Promise<void> {
      await inTransaction(control, {}, async (db) => {
        const releases = await agentReleaseRepo.list(db);
        const newest = releases[0];
        if (newest === undefined) return;
        let running = await agentRolloutRepo.lockRunning(db);
        if (running?.releaseId !== newest.releaseId && await agentRolloutRepo.findByReleaseId(db, newest.releaseId) === undefined) {
          if (running !== undefined) await agentRolloutRepo.update(db, running.id, { status: 'superseded', endedAt: at() });
          running = await agentRolloutRepo.insert(db, { id: uuidv7(now()), releaseId: newest.releaseId, version: newest.version, waveStartedAt: at(), startedAt: at() });
          deps.logger.info('agent rollout started', { event: 'agent.rollout_started', resourceType: 'agent_rollout', resourceId: running.id, outcome: running.version });
        }
        if (running !== undefined) {
          const health = await agentRolloutRepo.health(db, {
            version: running.version, since: running.startedAt, at: at(), returnMinutes: RETURN_MINUTES, minWork: GATE_MIN_WORK, maxFailedShare: GATE_MAX_FAILED_SHARE,
          });
          if (health.stalled > 0 || health.silent > 0) {
            await halt(db, running, 'heartbeat', health);
          } else if (health.failing > 0) {
            await halt(db, running, 'error_rate', health);
          } else {
            let { wave, waveStartedAt } = running;
            const reach = { version: running.version, ...versionParts(running.version), since: running.startedAt };
            const passed = async (): Promise<boolean> => now() - Date.parse(waveStartedAt) >= soakMs
              || await agentRolloutRepo.waveSize(db, wave, reach, deps.firstOrganisations) === 0;
            let completed = false;
            while (await passed()) {
              if (wave >= LAST_WAVE) {
                completed = true;
                break;
              }
              wave += 1;
              waveStartedAt = at();
            }
            if (completed) {
              await agentRolloutRepo.update(db, running.id, { status: 'completed', endedAt: at(), wave, waveStartedAt });
              deps.logger.info('agent rollout completed', { event: 'agent.rollout_completed', resourceType: 'agent_rollout', resourceId: running.id, outcome: running.version });
            } else if (wave !== running.wave) {
              await agentRolloutRepo.update(db, running.id, { wave, waveStartedAt });
              deps.logger.info('agent wave started', { event: 'agent.wave_started', resourceType: 'agent_rollout', resourceId: running.id, count: wave });
            }
          }
        }
        const floor = outdatedFloor(releases.map((r) => r.version));
        if (floor !== undefined) {
          for (const changed of await agentRepo.flagOutdated(db, floor, at(), REFUSED_AFTER_DAYS)) {
            const fields = { event: `agent.version_${changed.versionState}`, organisationId: changed.organisationId, resourceId: changed.agentId, outcome: changed.version };
            if (changed.versionState === 'current') deps.logger.info('an agent is current again', fields);
            else deps.logger.warn(changed.versionState === 'refused' ? 'an outdated agent is refused work until it updates' : 'an agent is outdated', fields);
          }
        }
      });
    },
  };
}

export type AgentUpdates = ReturnType<typeof createAgentUpdates>;
