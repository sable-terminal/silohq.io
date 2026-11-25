// fleet-control (spec 11): the release registry, channels, promotion, rollouts and
// bundle signing.
//
// Promotion rules (spec 11.2), checked when a promotion is asked for and again when it is
// approved, since time and rollouts move in between:
// - dev: any commercial release; one person.
// - canary: its dev rollout completed ("releases passing internal test cells").
// - stable: its canary rollout completed and it entered canary 48 hours ago; or, for a
//   security fix the approver expedites, it is on canary and not halted.
// - sovereign: a sovereign build whose commercial release entered stable 14 days ago and
//   was not halted there. Sovereign review happens in the sovereign fleet-control, which
//   countersigns the bundle.
// - agent-stable and agent-sovereign follow stable and sovereign for agent binaries.
// Every promotion but dev needs a second release engineer. A channel takes one rollout at
// a time, except that an expedited fix supersedes the running one.
//
// State is in the fleet tables of the global database (design: directory database, fleet),
// so every replica agrees: each change runs in one transaction under fleet-control's lock
// (fleetLockRepo), reads take none. Signed documents are kept exactly as signed; the
// artefact store gets the published copies. Times come from fleet-control's clock, so
// soaks are measured on one clock whichever replica acts.
//
// Air-gapped bundles (spec 11.4; D201): in an install's own fleet-control, loadBundle checks a
// bundle brought in on media (verifyBundle: the Silo release signature, and the sovereign
// countersignature where this fleet-control holds the sovereign key; every file's size and hash;
// nothing unlisted) before loading anything, and refuses the whole bundle on any mismatch
// (bundle_refused, with why). It then loads artefacts/release.json, the release exactly as Silo
// signed it (never signed again here), with every agent binary and release document it names
// from artefacts/agent-binaries/ and artefacts/release-documents/, records bundle_verified, and
// makes the release the head of the install's channel: "outside the waves", by the customer's own
// procedure for the media, and by two people, as any promotion beyond dev is (one loads it,
// another approves the load). The install's Fleet agent applies it as any cell's does and copies
// both events into the customer's audit log. Images, SBOMs and model weights travel in the
// bundle too, checked with everything else; the operator's tooling loads the images into the
// install's registry.
//
// Capacity (spec 6.3; D203), looked at hourly with the rollouts: "Provisioning starts when a cell
// in the residency reaches 75% of either limit" (2,000 organisations, 50,000 connections): when
// no shared cell of a residency is open below 75% of both and none is being provisioned there,
// cell_provisioning_needed is recorded for the residency, once a day while it lasts, for the
// cell template to be applied. A cell whose tenants have grown past 110% of either limit records
// cell_rebalancing_needed, once a day, for a rebalancing migration.
//
// Dedicated cells (spec 11.2 wave 5, 11.5): once stable's head has passed its shared waves,
// the tick gives each dedicated cell a rollout of its own: one wave of that cell, noticed now
// with the SBOM difference from the release it runs, started only when changeWindows.service
// says the customer's notice, window and freezes allow. A newer head replaces one still
// waiting; one under way finishes first. A failing verdict rolls that cell back alone.

import type { Channel, ReleaseManifest, SignatureRecord } from '../../contracts/fleet-control/release.contract.ts';
import { releaseManifest, signatureRecord } from '../../contracts/fleet-control/release.contract.ts';
import {
  channelHead, promotionView, rolloutView, type cellChangePolicy, type changeNotice, type ChannelHead, type RolloutView,
} from '../../contracts/fleet-control/rollout.contract.ts';
import { bundleManifest, signedBundle, type BundleManifest } from '../../contracts/fleet-control/bundle.contract.ts';
import { AGENT_BINARY_PART_BYTES, agentBinaryKey } from '../../contracts/fleet-control/agentBinary.contract.ts';
import { releaseDocumentKey } from '../../contracts/fleet-control/releaseDocument.contract.ts';
import { CELL_LIMITS } from '../../contracts/directory/registration.contract.ts';
import type { Logger } from '../../infra/logger.infra.ts';
import { inTransaction, type Databases, type Queryable } from '../../infra/postgres.infra.ts';
import type { Promotion as PromotionRow } from '../../models/fleet/promotion.model.ts';
import type { Release } from '../../models/fleet/release.model.ts';
import type { JsonValue } from '../../models/table.model.ts';
import { cellRepo } from '../../repos/directory/index.repo.ts';
import {
  bundleRepo, cellChangePolicyRepo, channelHeadRepo, conceptTemplateRepo, eventRepo, fleetLockRepo, promotionRepo, releaseComponentRepo, releaseRepo, releaseSbomRepo,
  rolloutRepo, rolloutWaveRepo, verdictRepo,
} from '../../repos/fleet/index.repo.ts';
import { canonicalJson } from '../../utils/canonicalJson.util.ts';
import { AppError, fromDatabaseError } from '../../utils/errors.util.ts';
import { uuidv7 } from '../../utils/id.util.ts';
import type { ConceptTemplate } from '../../models/fleet/conceptTemplate.model.ts';
import type { ConceptTemplateSet, ConceptTemplateView } from '../../contracts/fleet-control/conceptTemplates.contract.ts';
import { z } from 'zod';
import type { ArtefactStore } from './artefactStore.service.ts';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { ARTEFACTS_DIR, verifyBundle } from './bundle.service.ts';
import { isAppError } from '../../utils/errors.util.ts';
import { validateManifest } from './manifest.service.ts';
import { documentDigest, signDocument, verifyDocument, type Signer, type TrustedKey } from './signing.service.ts';
import { holdOf, sbomDifference, type ChangePolicy, type Hold } from './changeWindows.service.ts';
import { chainBreak, eventHash, type FleetEvent, type FleetEventBody } from './events.service.ts';
import {
  advanceRollout, dedicatedCells, desiredFor, haltRolloutState, planWaves, SOAK_HOURS, verdictOf, type RolloutEvent, type WavePlan,
} from './waves.service.ts';

const HOUR = 3_600_000;
const CANARY_SOAK_MS = 48 * HOUR;
const SOVEREIGN_STABLE_MS = 14 * 24 * HOUR;
/** How long a dedicated cell's customer is told in advance of a release, unless FLEET_CHANGE_NOTICE_HOURS says otherwise. */
const NOTICE_HOURS = 72;
const CELL_CHANNELS: readonly Channel[] = ['dev', 'canary', 'stable', 'sovereign'];

type SignedRelease = { manifest: ReleaseManifest; manifestDigest: string; signatures: SignatureRecord[] };
type StoredRelease = SignedRelease & { registeredAt: string };
type Promotion = z.infer<typeof promotionView>;
type SignedBundle = z.infer<typeof signedBundle>;
type History = Awaited<ReturnType<typeof channelHeadRepo.historyOf>>;

const signatures = z.array(signatureRecord);
/** Times as the API has always given them: ISO 8601, UTC, milliseconds. */
const iso = (value: string): string => new Date(Date.parse(value)).toISOString();
const isoOrNull = (value: string | null): string | null => (value === null ? null : iso(value));
const asJson = (value: unknown): JsonValue => value as JsonValue;

const releaseView = (row: Release): StoredRelease => ({
  manifest: releaseManifest.parse(row.manifest), manifestDigest: row.manifestDigest, signatures: signatures.parse(row.signatures),
  registeredAt: iso(row.registeredAt),
});

const promotionOf = (row: PromotionRow): Promotion => ({
  promotionId: row.id, releaseId: row.releaseId, channel: row.channel, expedite: row.expedite, state: row.state,
  requestedBy: row.requestedBy, requestedAt: iso(row.requestedAt), approvedBy: row.approvedBy, appliedAt: isoOrNull(row.appliedAt),
  sequence: row.sequence, rolloutId: row.rolloutId,
});

export interface FleetDeps {
  databases: Databases;
  store: ArtefactStore;
  signer: Signer;
  /** Keys signatures are checked against: the release key, and the sovereign key where held. */
  trusted: readonly TrustedKey[];
  plan: WavePlan;
  verdictGraceMinutes: number;
  logger: Logger;
  now?: () => number;
  /** The SBOM gate on stable, sovereign and their agent channels (vulnerabilities.service.ts); absent where nothing is promoted. */
  sbomGate?: (db: Queryable, manifest: ReleaseManifest, channel: Channel) => Promise<void>;
  /** How long ahead a dedicated cell's customer is told of a release (spec 11.5). */
  noticeHours?: number;
}

type ChangeNotice = z.infer<typeof changeNotice>;
export interface FleetEventView extends FleetEventBody { seq: number; hash: string }
type CellChangePolicyInput = z.infer<typeof cellChangePolicy>;

export interface PromotionInput {
  releaseId: string;
  channel: Channel;
  expedite: boolean;
  requestedBy: string;
}

export interface DesiredRelease {
  channel: Channel;
  releaseId: string | null;
  reason: 'current' | 'wave_started' | 'wave_pending' | 'rolled_back' | 'none';
  rolloutId: string | null;
  release: SignedRelease | null;
  notice: ChangeNotice | null;
}

const templateViewOf = (t: ConceptTemplate): ConceptTemplateView => ({
  id: t.id, name: t.name, fieldNames: t.fieldNames, revision: t.revision, status: t.status, authoredBy: t.authoredBy,
  reviewedBy: t.reviewedBy, reviewedAt: t.reviewedAt === null ? null : new Date(t.reviewedAt).toISOString(),
  withdrawnAt: t.withdrawnAt === null ? null : new Date(t.withdrawnAt).toISOString(),
});

export interface Fleet {
  registerRelease(releaseId: string, manifest: ReleaseManifest, operatorId: string): Promise<StoredRelease>;
  readRelease(releaseId: string): Promise<SignedRelease>;
  requestPromotion(promotionId: string, input: PromotionInput): Promise<Promotion>;
  approvePromotion(promotionId: string, approvedBy: string): Promise<Promotion>;
  readPromotion(promotionId: string): Promise<Promotion>;
  readChannel(channel: Channel): Promise<{ channel: Channel; head: { document: ChannelHead; signatures: SignatureRecord[] } | null; rolloutId: string | null }>;
  desiredRelease(cellId: string, channel: Channel): Promise<DesiredRelease>;
  reportVerdict(rolloutId: string, cellId: string, releaseId: string, gates: { gate: string; passed: boolean }[]): Promise<RolloutView>;
  haltRollout(rolloutId: string, haltedBy: string): Promise<RolloutView>;
  readRollout(rolloutId: string): Promise<RolloutView>;
  signBundle(bundleId: string, input: { releaseId: string; fromReleaseId: string | null; files: BundleManifest['files'] }): Promise<SignedBundle>;
  countersignBundle(bundleId: string, bundle: BundleManifest, signatures: SignatureRecord[]): Promise<SignedBundle>;
  /** Fleet's own events (spec 11.6), oldest first, after a sequence; for a release or a cell when named. */
  listEvents(filter: { after: number; releaseId?: string | undefined; cellId?: string | undefined; limit: number }): Promise<{ events: FleetEventView[]; next: number | null }>;
  /** The whole event chain checked. */
  verifyEvents(): Promise<{ events: number; intact: boolean; brokenAt: number | null; headHash: string | null }>;
  /** A migration of the release a cell runs, applied there (spec 11.3), from its Fleet agent: recorded once. */
  reportMigrationApplied(cellId: string, releaseId: string, migration: { database: 'cell' | 'directory'; version: string; name: string; digest: string; appliedAt: string })
    : Promise<{ recorded: boolean }>;
  /** A dedicated cell's change policy as its customer set it, from the cell's Fleet agent (spec 11.5). */
  putCellChangePolicy(cellId: string, policy: CellChangePolicyInput): Promise<{ cellId: string; reportedAt: string; freezesSet: number }>;
  /** Advances every running rollout: starts waves whose turn has come, halts on a missing signal. */
  tick(): Promise<number>;
  /** A part of an agent binary a release names, for a cell's Fleet agent to copy (spec 10.7). */
  readAgentBinary(hex: string, offset: number): Promise<{ bytes: number; offset: number; data: string }>;
  readReleaseDocument(hex: string): Promise<{ bytes: number; data: string }>;
  /** The cells' capacity against their limits (spec 6.3): the events it recorded. */
  checkCapacity(): Promise<{ provisioning: string[]; rebalancing: string[] }>;
  /** An air-gapped bundle on media (spec 11.4): checked whole, then loaded and made the head of the install's channel. */
  /** Concept templates (22.7; D210): authored by Silo staff, readable once a second person reviews them, withdrawn never deleted. */
  authorTemplate(input: { name: string; fieldNames: string[]; operatorId: string }): Promise<ConceptTemplateView>;
  reviewTemplate(templateId: string, reviewerId: string): Promise<ConceptTemplateView>;
  withdrawTemplate(templateId: string, operatorId: string): Promise<ConceptTemplateView>;
  listTemplates(): Promise<ConceptTemplateView[]>;
  /** Every reviewed and withdrawn template, signed for the cells. */
  templateSet(): Promise<{ set: ConceptTemplateSet; signatures: SignatureRecord[]; digest: string }>;
  loadBundle(dir: string, input: { operatorId: string; approverId: string; channel: Channel; cellId: string })
    : Promise<{ bundleId: string; releaseId: string; files: number; bytes: number; promotionId: string }>;
}

const json = (value: unknown): Buffer => Buffer.from(`${JSON.stringify(value)}\n`, 'utf8');

export async function createFleet(deps: FleetDeps): Promise<Fleet> {
  const { store, signer, logger } = deps;
  const now = deps.now ?? Date.now;
  const at = (): string => new Date(now()).toISOString();
  const pool = deps.databases.pool('directory');

  let capacityCheckedAt = 0;

  /** Spec 6.3: a residency that needs a cell provisioned, and cells whose tenants need rebalancing; each recorded once a day while it lasts. */
  const checkCapacity = async (db: Queryable): Promise<{ provisioning: string[]; rebalancing: string[] }> => {
    const cells = await cellRepo.capacity(db);
    const share = (c: (typeof cells)[number]) => Math.max(c.organisations / CELL_LIMITS.organisations, c.connectionCount / CELL_LIMITS.connections);
    const due = async (event: FleetEvent, about: string) => {
      const last = await eventRepo.lastAbout(db, event, about);
      return last === undefined || now() - Date.parse(last) >= 24 * 3_600_000;
    };
    const out = { provisioning: [] as string[], rebalancing: [] as string[] };
    for (const cell of cells) {
      // cell_created (6.7): once, the first time a cell is seen in service.
      if (await eventRepo.lastAbout(db, 'cell_created', cell.id) === undefined) {
        await recordEvent(db, 'cell_created', { cellId: cell.id, detail: { kind: cell.kind, residency: cell.residency, status: cell.status } });
      }
      // Placement is open to an active cell below both limits; closed by its status or a limit (6.3), recorded when it closes.
      const open = cell.status === 'active' && cell.organisations < CELL_LIMITS.organisations && cell.connectionCount < CELL_LIMITS.connections;
      if (await cellRepo.setPlacementOpen(db, cell.id, open) && !open) {
        await recordEvent(db, 'cell_placement_closed', { cellId: cell.id, detail: {
          reason: cell.status !== 'active' ? cell.status : 'limit', organisations: cell.organisations, connections: cell.connectionCount,
        } });
      }
    }
    const shared = cells.filter((c) => c.kind === 'commercial');
    for (const residency of [...new Set(shared.map((c) => c.residency))].sort()) {
      const here = shared.filter((c) => c.residency === residency);
      const roomy = here.some((c) => c.status === 'active' && share(c) < 0.75);
      const coming = here.some((c) => c.status === 'provisioning');
      if (!roomy && !coming && await due('cell_provisioning_needed', residency)) {
        await recordEvent(db, 'cell_provisioning_needed', { detail: {
          residency, open_cells: here.filter((c) => c.status === 'active').length,
          fullest: Math.round(Math.max(...here.map(share)) * 100),
        } });
        out.provisioning.push(residency);
      }
    }
    for (const cell of cells) {
      if (share(cell) > 1.1 && await due('cell_rebalancing_needed', cell.id)) {
        await recordEvent(db, 'cell_rebalancing_needed', { cellId: cell.id, detail: {
          residency: cell.residency, organisations: cell.organisations, connections: cell.connectionCount,
        } });
        out.rebalancing.push(cell.id);
      }
    }
    if (out.provisioning.length + out.rebalancing.length > 0) {
      logger.warn('cells are near or past their limits', { event: 'fleet.capacity', reason: [...out.provisioning, ...out.rebalancing].join(','), count: out.provisioning.length });
    }
    return out;
  };

  /** A change: one transaction under fleet-control's lock. */
  const change = <T>(work: (db: Queryable) => Promise<T>): Promise<T> =>
    inTransaction(pool, {}, async (db) => {
      await fleetLockRepo.lock(db);
      return work(db);
    });
  const read = <T>(work: (db: Queryable) => Promise<T>): Promise<T> => inTransaction(pool, {}, work, { readOnly: true });

  /** One of Fleet's own events (spec 11.6), appended in this transaction: under the lock, so the chain has one order. */
  const recordEvent = async (db: Queryable, event: FleetEvent, fields: {
    releaseId?: string | null; rolloutId?: string | null; cellId?: string | null; channel?: string | null; operatorId?: string | null;
    detail?: FleetEventBody['detail'];
  } = {}): Promise<void> => {
    const body: FleetEventBody = {
      event, occurredAt: at(), releaseId: fields.releaseId ?? null, rolloutId: fields.rolloutId ?? null, cellId: fields.cellId ?? null,
      channel: fields.channel ?? null, operatorId: fields.operatorId ?? null, detail: fields.detail ?? {},
    };
    const previous = await eventRepo.headHash(db);
    await eventRepo.append(db, { ...body, previousHash: previous, hash: eventHash(previous, body) });
  };

  const requireRole = (role: Signer['role'], what: string): void => {
    if (signer.role !== role) {
      throw new AppError('forbidden', `this fleet-control holds the ${signer.role} key and does not ${what}`, { code: 'fleet.wrong_signing_role' });
    }
  };

  /** A rollout's progress: logged, and recorded where it is one of Fleet's events (a dedicated cell's start is its wave's). */
  const logEvents = async (db: Queryable, rollout: RolloutView, events: readonly RolloutEvent[]): Promise<void> => {
    const about = { releaseId: rollout.releaseId, rolloutId: rollout.rolloutId, cellId: rollout.cellId, channel: rollout.channel };
    for (const event of events) {
      logger.info('rollout progressed', { event: `fleet.${event}`, resourceType: 'rollout', resourceId: rollout.rolloutId, outcome: rollout.status });
      if (event === 'wave_started' && rollout.cellId !== null) {
        await recordEvent(db, 'rollout_started', { ...about, detail: { previous_release_id: rollout.previousReleaseId } });
      }
      if (event === 'rollout_completed') await recordEvent(db, 'rollout_completed', about);
      if (event === 'rollout_gate_failed' || event === 'rollout_signal_missing') {
        const failing = Object.entries(rollout.verdicts).filter(([, v]) => v.verdict === 'fail' && v.releaseId === rollout.releaseId);
        await recordEvent(db, 'rollout_gate_failed', { ...about, detail: {
          reason: event === 'rollout_signal_missing' ? 'signal_missing' : 'gate_failed',
          cells: failing.map(([cell]) => cell).sort().join(','), gates: [...new Set(failing.flatMap(([, v]) => v.failedGates))].sort().join(','),
        } });
        logger.warn('rollout halted; cells roll back', { event: 'fleet.rollout_rolled_back', resourceType: 'rollout', resourceId: rollout.rolloutId,
          reason: rollout.haltReason ?? 'unknown' });
        await recordEvent(db, 'rollout_rolled_back', { ...about, detail: { reason: rollout.haltReason ?? 'gate_failed', to_release_id: rollout.previousReleaseId } });
      }
    }
  };

  // ------------------------------------------------------------------ rollouts in the tables
  const loadRollout = async (db: Queryable, rolloutId: string): Promise<RolloutView | undefined> => {
    const row = await rolloutRepo.findById(db, rolloutId);
    if (row === undefined) return undefined;
    const waves = await rolloutWaveRepo.listByRollout(db, rolloutId);
    const verdicts = await verdictRepo.listByRollout(db, rolloutId);
    return rolloutView.parse({
      rolloutId: row.id, cellId: row.cellId, notice: row.notice === null ? null : { ...(row.notice as object), noticedAt: iso(row.noticedAt!) },
      channel: row.channel, releaseId: row.releaseId, previousReleaseId: row.previousReleaseId, sequence: row.sequence,
      status: row.status, startedAt: iso(row.startedAt), endedAt: isoOrNull(row.endedAt), haltReason: row.haltReason, haltedBy: row.haltedBy,
      waves: waves.map((w) => ({ cells: w.cells, soakHours: w.soakHours, startedAt: isoOrNull(w.startedAt), passedAt: isoOrNull(w.passedAt) })),
      verdicts: Object.fromEntries(verdicts.map((v) => [v.cellId, {
        releaseId: v.releaseId, verdict: v.verdict, failedGates: v.failedGates, reportedAt: iso(v.reportedAt),
      }])),
    });
  };
  const requireRollout = async (db: Queryable, rolloutId: string): Promise<RolloutView> => {
    const rollout = await loadRollout(db, rolloutId);
    if (rollout === undefined) throw new AppError('not_found', 'no such rollout', { code: 'fleet.rollout_unknown' });
    return rollout;
  };

  /** Writes what changed between two states of a rollout (all of it for a new one). */
  const saveRollout = async (db: Queryable, before: RolloutView | undefined, after: RolloutView): Promise<void> => {
    if (before === undefined) {
      await rolloutRepo.insert(db, {
        id: after.rolloutId, channel: after.channel as 'dev' | 'canary' | 'stable' | 'sovereign', releaseId: after.releaseId,
        previousReleaseId: after.previousReleaseId, sequence: after.sequence, status: after.status, startedAt: after.startedAt,
        endedAt: after.endedAt, haltReason: after.haltReason, haltedBy: after.haltedBy, cellId: after.cellId,
        noticedAt: after.notice?.noticedAt ?? null,
        notice: after.notice === null ? null : asJson((({ noticedAt: _noticedAt, ...rest }) => rest)(after.notice)),
      });
      for (const [position, wave] of after.waves.entries()) {
        await rolloutWaveRepo.insert(db, {
          rolloutId: after.rolloutId, position, cells: wave.cells, soakHours: wave.soakHours, startedAt: wave.startedAt, passedAt: wave.passedAt,
        });
      }
    } else {
      await rolloutRepo.update(db, after.rolloutId, {
        status: after.status, endedAt: after.endedAt, haltReason: after.haltReason, haltedBy: after.haltedBy,
      });
      for (const [position, wave] of after.waves.entries()) {
        const earlier = before.waves[position];
        if (earlier?.startedAt === wave.startedAt && earlier.passedAt === wave.passedAt) continue;
        await rolloutWaveRepo.update(db, { rolloutId: after.rolloutId, position }, { startedAt: wave.startedAt, passedAt: wave.passedAt });
      }
    }
    for (const [cellId, verdict] of Object.entries(after.verdicts)) {
      if (before !== undefined && canonicalJson(before.verdicts[cellId] ?? null) === canonicalJson(verdict)) continue;
      await verdictRepo.upsert(db, {
        rolloutId: after.rolloutId, cellId, releaseId: verdict.releaseId, verdict: verdict.verdict, failedGates: verdict.failedGates,
        reportedAt: verdict.reportedAt,
      });
    }
  };

  const noticeMs = (deps.noticeHours ?? NOTICE_HOURS) * HOUR;
  const policyOf = async (db: Queryable, cellId: string): Promise<ChangePolicy | undefined> => {
    const row = await cellChangePolicyRepo.findByCellId(db, cellId);
    return row === undefined ? undefined : {
      timeZone: row.timeZone, windows: row.windows as unknown as ChangePolicy['windows'], changeAuthorityMembershipId: row.changeAuthorityMembershipId,
      freezes: row.freezes as unknown as ChangePolicy['freezes'], exceptions: row.exceptions as unknown as ChangePolicy['exceptions'],
    };
  };
  /** What holds a dedicated cell's rollout from starting now; null when it may start (or is not a cell's). */
  const holdFor = async (db: Queryable, rollout: RolloutView): Promise<Hold> => {
    if (rollout.cellId === null || rollout.notice === null) return null;
    return holdOf(await policyOf(db, rollout.cellId), { releaseId: rollout.releaseId, securityFix: rollout.notice.securityFix },
      Date.parse(rollout.notice.noticedAt), noticeMs, now());
  };

  const advance = async (db: Queryable, rollout: RolloutView): Promise<RolloutView> => {
    const waiting = rollout.cellId !== null && rollout.waves[0]?.startedAt === null;
    const hold = waiting ? await holdFor(db, rollout) : null;
    const { rollout: next, events } = advanceRollout(rollout, now(), deps.verdictGraceMinutes, () => hold === null);
    if (events.length === 0) return rollout;
    await saveRollout(db, rollout, next);
    await logEvents(db, next, events);
    return next;
  };

  // ------------------------------------------------------------------ dedicated cells (spec 11.2 wave 5, 11.5)

  /** What a dedicated cell's images gain, lose and change from one release to the next, from their SBOMs. */
  const differenceBetween = async (db: Queryable, before: string | null, after: string) => {
    const componentsOf = async (releaseId: string | null) => {
      if (releaseId === null) return undefined;
      const stored = await requireRelease(db, releaseId);
      const received = await releaseSbomRepo.forRelease(db, releaseId);
      if (!stored.manifest.images.every((i) => received.some((r) => r.digest === i.sbom.digest))) return undefined;
      return releaseComponentRepo.imageComponents(db, releaseId);
    };
    return sbomDifference(await componentsOf(before), await componentsOf(after));
  };

  /** The notice for a dedicated cell's rollout not yet started, with what holds it now. */
  const noticeOf = async (db: Queryable, rollout: RolloutView): Promise<ChangeNotice | null> => {
    if (rollout.notice === null || rollout.status !== 'running' || rollout.waves[0]?.startedAt !== null) return null;
    return { ...rollout.notice, hold: await holdFor(db, rollout) };
  };

  /** A dedicated cell's answer: its own latest rollout of stable, moved on first when the clock says so. */
  const answerForCell = async (db: Queryable, cellId: string, advanceDue: boolean): Promise<DesiredRelease | 'advance'> => {
    const row = await rolloutRepo.latestForCell(db, cellId);
    if (row === undefined) return { channel: 'stable', releaseId: null, reason: 'none', rolloutId: null, release: null, notice: null };
    let rollout = await requireRollout(db, row.id);
    if (rollout.status === 'running') {
      const hold = rollout.waves[0]?.startedAt === null ? await holdFor(db, rollout) : null;
      if (advanceRollout(rollout, now(), deps.verdictGraceMinutes, () => hold === null).events.length > 0) {
        if (!advanceDue) return 'advance';
        rollout = await advance(db, rollout);
      }
    }
    const { releaseId, reason } = desiredFor(rollout, cellId);
    const notice = await noticeOf(db, rollout);
    if (releaseId === null) return { channel: 'stable', releaseId: null, reason, rolloutId: rollout.rolloutId, release: null, notice };
    const { registeredAt: _registeredAt, ...release } = await requireRelease(db, releaseId);
    return { channel: 'stable', releaseId, reason, rolloutId: rollout.rolloutId, release, notice };
  };

  /**
   * Once stable's head has passed its shared waves, each dedicated cell gets a rollout of its
   * own, noticed now. One still waiting for its window gives way to a newer head; one under
   * way finishes first. A release the cell already took, or was rolled back from, is not
   * offered again: the next head is.
   */
  const followStable = async (db: Queryable): Promise<number> => {
    const head = await channelHeadRepo.latest(db, 'stable');
    if (head === undefined || head.rolloutId === null) return 0;
    const shared = await requireRollout(db, head.rolloutId);
    if (shared.status !== 'completed') return 0;
    const release = await requireRelease(db, head.releaseId);
    let noticed = 0;
    for (const cellId of dedicatedCells(await cellRepo.list(db))) {
      const latest = await rolloutRepo.latestForCell(db, cellId);
      if (latest?.releaseId === head.releaseId) continue;
      if (latest?.status === 'running') {
        if ((await requireRollout(db, latest.id)).waves[0]?.startedAt !== null) continue;
        await rolloutRepo.update(db, latest.id, { status: 'superseded', endedAt: at() });
        logger.info('a release waiting for its window gave way to a newer one', {
          event: 'fleet.rollout_superseded', resourceType: 'rollout', resourceId: latest.id, outcome: cellId,
        });
      }
      const previous = (await rolloutRepo.lastCompletedReleaseForCell(db, cellId)) ?? shared.previousReleaseId;
      if (previous === head.releaseId) continue;
      const noticedAt = at();
      const securityFix = release.manifest.securityFix;
      const rollout: RolloutView = {
        rolloutId: uuidv7(now()), cellId, channel: 'stable', releaseId: head.releaseId, previousReleaseId: previous, sequence: head.sequence,
        status: 'running', startedAt: noticedAt, endedAt: null, haltReason: null, haltedBy: null,
        waves: [{ cells: [cellId], soakHours: SOAK_HOURS.dedicated, startedAt: null, passedAt: null }], verdicts: {},
        notice: {
          releaseId: head.releaseId, securityFix, previousReleaseId: previous, noticedAt,
          earliestStartAt: new Date(now() + (securityFix ? 0 : noticeMs)).toISOString(),
          sbomDifference: await differenceBetween(db, previous, head.releaseId),
        },
      };
      await saveRollout(db, undefined, rollout);
      logger.info('a dedicated cell is told of a release coming', { event: 'fleet.change_noticed', resourceType: 'rollout', resourceId: rollout.rolloutId, outcome: cellId });
      await advance(db, rollout);
      noticed += 1;
    }
    return noticed;
  };

  const readStored = async (db: Queryable, releaseId: string): Promise<StoredRelease | undefined> => {
    const row = await releaseRepo.findByReleaseId(db, releaseId);
    return row === undefined ? undefined : releaseView(row);
  };
  const requireRelease = async (db: Queryable, releaseId: string): Promise<StoredRelease> => {
    const release = await readStored(db, releaseId);
    if (release === undefined) throw new AppError('not_found', 'no such release', { code: 'fleet.release_unknown', details: { releaseId } });
    return release;
  };

  const refuse = (code: string, message: string): never => {
    throw new AppError('conflict', message, { code });
  };

  const checkPromotion = async (db: Queryable, channel: Channel, manifest: ReleaseManifest, expedite: boolean): Promise<void> => {
    const time = now();
    const forAgents = channel === 'agent-stable' || channel === 'agent-sovereign';
    if (forAgents && manifest.agentBinaries.length === 0) refuse('fleet.no_agent_binaries', 'an agent channel takes releases with agent binaries');
    if (!forAgents && manifest.images.length === 0) refuse('fleet.no_images', 'a cell channel takes releases with images');
    const sovereignChannel = channel === 'sovereign' || channel === 'agent-sovereign';
    if ((manifest.target === 'sovereign') !== sovereignChannel) {
      refuse('fleet.wrong_target', `the ${channel} channel takes ${sovereignChannel ? 'sovereign' : 'commercial'} builds`);
    }
    if (expedite && !(channel === 'stable' || channel === 'agent-stable')) refuse('fleet.expedite_channel', 'only stable takes an expedited fix');
    if (expedite && !manifest.securityFix) refuse('fleet.expedite_not_security_fix', 'only a security fix skips the canary soak');
    const head = await channelHeadRepo.latest(db, channel);
    if (head?.releaseId === manifest.releaseId) refuse('fleet.already_head', 'that release is already the channel head');

    const history = (on: Channel, releaseId: string): Promise<History> => channelHeadRepo.historyOf(db, on, releaseId);
    const completed = (entries: History) => entries.some((e) => e.rolloutStatus === 'completed');
    const notHalted = (entries: History) => entries.some((e) => e.rolloutStatus !== 'halted');
    switch (channel) {
      case 'dev':
        break;
      case 'canary':
        if (!completed(await history('dev', manifest.releaseId))) refuse('fleet.not_passed_dev', 'canary takes releases that passed the internal test cells');
        break;
      case 'stable':
      case 'agent-stable': {
        const canary = await history('canary', manifest.releaseId);
        if (expedite) {
          if (canary.length === 0 || !notHalted(canary)) refuse('fleet.not_on_canary', 'an expedited fix still goes through canary first');
        } else if (!canary.some((e) => e.rolloutStatus === 'completed' && Date.parse(e.promotedAt) <= time - CANARY_SOAK_MS)) {
          refuse('fleet.canary_soak', 'stable takes releases after 48 hours of canary with every gate passing');
        }
        break;
      }
      case 'sovereign': {
        const stable = await history('stable', manifest.commercialRelease!);
        if (!stable.some((e) => e.rolloutStatus !== 'halted' && Date.parse(e.promotedAt) <= time - SOVEREIGN_STABLE_MS)) {
          refuse('fleet.stable_soak', 'sovereign takes builds whose commercial release has been 14 days in stable');
        }
        break;
      }
      case 'agent-sovereign': {
        const sovereign = await history('sovereign', manifest.releaseId);
        if (sovereign.length === 0 || !notHalted(sovereign)) {
          refuse('fleet.not_on_sovereign', 'agent-sovereign takes releases already on the sovereign channel');
        }
        break;
      }
    }
    if (forAgents) {
      // Cells copy each binary from the store: every one the release names must be there, whole.
      for (const binary of manifest.agentBinaries) {
        const hex = binary.digest.slice('sha256:'.length);
        const held = await store.sha256(agentBinaryKey(hex));
        if (held === undefined || held.hex !== hex) {
          refuse('fleet.agent_binary_missing', `the ${binary.platform} agent binary is not in the artefact store: the build puts it there first`);
        }
      }
    }
    if (!forAgents) {
      // Cells apply the release's configuration, flags and model routing with it: each must be there, whole.
      const documents: [string, string][] = [['configuration', manifest.configurationDigest], ['flags', manifest.flagsDigest], ['model routing', manifest.modelRoutingDigest],
        ...(manifest.catalogueDigest === undefined ? [] : [['catalogue', manifest.catalogueDigest] as [string, string]])];
      for (const [name, digest] of documents) {
        const hex = digest.slice('sha256:'.length);
        const held = await store.sha256(releaseDocumentKey(hex));
        if (held === undefined || held.hex !== hex) {
          refuse('fleet.release_document_missing', `the release's ${name} document is not in the artefact store: the build puts it there first`);
        }
      }
    }
    // Spec 11.1: a critical vulnerability in a reachable component blocks stable (and what follows it).
    await deps.sbomGate?.(db, manifest, channel);
  };

  const apply = async (db: Queryable, promotion: Promotion, approvedBy: string | null): Promise<Promotion> => {
    const release = await requireRelease(db, promotion.releaseId);
    const channel = promotion.channel;
    const current = await channelHeadRepo.latest(db, channel);
    let previousReleaseId: string | null = null;
    if (current !== undefined) {
      const currentRollout = current.rolloutId ? await loadRollout(db, current.rolloutId) : undefined;
      if (currentRollout === undefined || currentRollout.status === 'completed') {
        previousReleaseId = current.releaseId;
      } else {
        if (currentRollout.status === 'running') {
          if (!promotion.expedite) refuse('fleet.rollout_in_progress', 'the channel is rolling out a release; wait, halt it, or expedite a fix');
          await rolloutRepo.update(db, currentRollout.rolloutId, { status: 'superseded', endedAt: at() });
          logger.info('rollout superseded by an expedited fix', { event: 'fleet.rollout_superseded', resourceType: 'rollout', resourceId: currentRollout.rolloutId });
        }
        // Halted or superseded: the cells it reached went back; the last good release stands.
        previousReleaseId = currentRollout.previousReleaseId;
      }
    }

    const promotedAt = at();
    const sequence = (current?.sequence ?? 0) + 1;
    const document: ChannelHead = {
      schema: 'silo.channel.v1', channel, sequence, releaseId: release.manifest.releaseId, manifestDigest: release.manifestDigest,
      promotedAt, promotionId: promotion.promotionId,
    };
    const headSignatures = [await signDocument(signer, 'channel', document)];

    let rolloutId: string | null = null;
    let started: RolloutView | undefined;
    if (CELL_CHANNELS.includes(channel)) {
      const cells = await cellRepo.list(db);
      const rollout: RolloutView = {
        rolloutId: uuidv7(now()), cellId: null, notice: null, channel, releaseId: release.manifest.releaseId, previousReleaseId, sequence, status: 'running',
        startedAt: promotedAt, endedAt: null, haltReason: null, haltedBy: null,
        waves: planWaves(channel, cells, deps.plan).map((w) => ({ ...w, startedAt: null, passedAt: null })),
        verdicts: {},
      };
      await saveRollout(db, undefined, rollout);
      logger.info('rollout started', { event: 'fleet.rollout_started', resourceType: 'rollout', resourceId: rollout.rolloutId, count: rollout.waves.length });
      started = rollout;
      rolloutId = rollout.rolloutId;
    }

    await channelHeadRepo.insert(db, {
      channel, sequence, releaseId: release.manifest.releaseId, promotionId: promotion.promotionId, rolloutId, promotedAt,
      document: asJson(document), signatures: asJson(headSignatures),
    });
    const applied = await promotionRepo.update(db, promotion.promotionId, { state: 'applied', approvedBy, appliedAt: promotedAt, sequence, rolloutId });
    const promoted = { releaseId: release.manifest.releaseId, rolloutId, channel, operatorId: approvedBy ?? promotion.requestedBy,
      detail: { promotion_id: promotion.promotionId, sequence, requested_by: promotion.requestedBy } };
    await recordEvent(db, 'release_promoted', promoted);
    if (promotion.expedite) await recordEvent(db, 'release_expedited', promoted);
    // The promotion first, then the rollout it starts, then its first move (a wave with nothing to wait for passes at once).
    if (started !== undefined) {
      await recordEvent(db, 'rollout_started', { releaseId: started.releaseId, rolloutId: started.rolloutId, channel, detail: {
        waves: started.waves.length, previous_release_id: previousReleaseId,
      } });
      await advance(db, started);
    }
    // The published copy, for cells and bundles; the table is the record.
    await store.write(`channels/${channel}/${String(sequence).padStart(8, '0')}.json`, json({ document, signatures: headSignatures }));
    logger.info('release promoted', { event: promotion.expedite ? 'fleet.release_expedited' : 'fleet.release_promoted', resourceType: 'promotion',
      resourceId: promotion.promotionId, outcome: channel });
    return promotionOf(applied!);
  };

  /** A bundle as stored, compared with what is asked for. */
  const storedBundle = async (db: Queryable, bundleId: string): Promise<SignedBundle | undefined> => {
    const row = await bundleRepo.findById(db, bundleId);
    return row === undefined ? undefined : { bundle: bundleManifest.parse(row.bundle), signatures: signatures.parse(row.signatures) };
  };
  const saveBundle = async (db: Queryable, signed: SignedBundle): Promise<void> => {
    await bundleRepo.insert(db, {
      id: signed.bundle.bundleId, releaseId: signed.bundle.releaseId, fromReleaseId: signed.bundle.fromReleaseId,
      bundle: asJson(signed.bundle), signatures: asJson(signed.signatures), createdAt: signed.bundle.createdAt,
    });
    await store.write(`bundles/${signed.bundle.bundleId}/bundle.json`, json(signed));
  };

  return {
    async registerRelease(releaseId, manifest, operatorId) {
      requireRole('release', 'register releases');
      if (manifest.releaseId !== releaseId) {
        throw new AppError('validation', 'the manifest names another release', { code: 'fleet.manifest_invalid', details: { reason: 'release_id' } });
      }
      validateManifest(manifest);
      const manifestDigest = documentDigest(manifest);
      const { stored, created } = await change(async (db) => {
        const existing = await readStored(db, releaseId);
        if (existing !== undefined) {
          if (existing.manifestDigest === manifestDigest) return { stored: existing, created: false };
          throw new AppError('conflict', 'a different manifest is registered under that release; releases are immutable', { code: 'fleet.release_exists' });
        }
        const releaseSignatures = [await signDocument(signer, 'release', manifest)];
        const row = await releaseRepo.insert(db, {
          releaseId, target: manifest.target, manifest: asJson(manifest), manifestDigest, signatures: asJson(releaseSignatures),
          registeredBy: operatorId, registeredAt: at(),
        });
        const view = releaseView(row);
        const { registeredAt: _registeredAt, ...published } = view;
        await store.write(`releases/${releaseId}/release.json`, json(published));
        await recordEvent(db, 'release_built', { releaseId, operatorId, detail: {
          target: manifest.target, source_commit: manifest.provenance.sourceCommit, builder: manifest.provenance.builder, built_at: manifest.builtAt,
          security_fix: manifest.securityFix,
        } });
        await recordEvent(db, 'release_signed', { releaseId, operatorId, detail: { manifest_digest: manifestDigest, key_id: releaseSignatures[0]!.keyId } });
        return { stored: view, created: true };
      });
      if (created) logger.info('release signed', { event: 'fleet.release_signed', resourceType: 'operator', resourceId: operatorId });
      return stored;
    },

    async readRelease(releaseId) {
      const { registeredAt: _registeredAt, ...release } = await read((db) => requireRelease(db, releaseId));
      return release;
    },

    requestPromotion(promotionId, input) {
      return change(async (db) => {
        const existingRow = await promotionRepo.findById(db, promotionId);
        if (existingRow !== undefined) {
          const existing = promotionOf(existingRow);
          const same = existing.releaseId === input.releaseId && existing.channel === input.channel
            && existing.expedite === input.expedite && existing.requestedBy === input.requestedBy;
          if (same) return existing;
          throw new AppError('conflict', 'that promotion was asked for with other content', { code: 'fleet.promotion_exists' });
        }
        const release = await requireRelease(db, input.releaseId);
        await checkPromotion(db, input.channel, release.manifest, input.expedite);
        const promotion = promotionOf(await promotionRepo.insert(db, {
          id: promotionId, releaseId: input.releaseId, channel: input.channel, expedite: input.expedite, state: 'pending',
          requestedBy: input.requestedBy, requestedAt: at(),
        }));
        logger.info('promotion requested', { event: 'fleet.promotion_requested', resourceType: 'promotion', resourceId: promotionId, outcome: input.channel });
        // Entering dev is one person: every merge goes to the internal cells.
        return input.channel === 'dev' ? apply(db, promotion, null) : promotion;
      });
    },

    approvePromotion(promotionId, approvedBy) {
      return change(async (db) => {
        const row = await promotionRepo.findById(db, promotionId);
        if (row === undefined) throw new AppError('not_found', 'no such promotion', { code: 'fleet.promotion_unknown' });
        const promotion = promotionOf(row);
        if (promotion.state === 'applied') {
          if (promotion.approvedBy === approvedBy) return promotion;
          throw new AppError('conflict', 'that promotion has been applied', { code: 'fleet.promotion_applied' });
        }
        if (approvedBy === promotion.requestedBy) {
          throw new AppError('forbidden', 'a promotion is approved by a second release engineer (two-person rule)', { code: 'fleet.two_person' });
        }
        const release = await requireRelease(db, promotion.releaseId);
        await checkPromotion(db, promotion.channel, release.manifest, promotion.expedite);
        return apply(db, promotion, approvedBy);
      });
    },

    readChannel(channel) {
      return read(async (db) => {
        const head = await channelHeadRepo.latest(db, channel);
        if (head === undefined) return { channel, head: null, rolloutId: null };
        return { channel, head: { document: channelHead.parse(head.document), signatures: signatures.parse(head.signatures) }, rolloutId: head.rolloutId };
      });
    },

    async desiredRelease(cellId, channel) {
      const answer = async (db: Queryable, advanceDue: boolean): Promise<DesiredRelease | 'advance'> => {
        if (channel === 'stable' && (await cellRepo.findById(db, cellId))?.kind === 'dedicated') return answerForCell(db, cellId, advanceDue);
        const head = await channelHeadRepo.latest(db, channel);
        if (head === undefined) return { channel, releaseId: null, reason: 'none', rolloutId: null, release: null, notice: null };
        let releaseId: string | null = head.releaseId;
        let reason: DesiredRelease['reason'] = 'current';
        if (head.rolloutId !== null) {
          let rollout = await requireRollout(db, head.rolloutId);
          if (advanceDue) rollout = await advance(db, rollout);
          else if (advanceRollout(rollout, now(), deps.verdictGraceMinutes).events.length > 0) return 'advance';
          ({ releaseId, reason } = desiredFor(rollout, cellId));
        }
        // Nothing earlier to run: the cell waits for its wave (or, rolled back, for a fix).
        if (releaseId === null) return { channel, releaseId: null, reason, rolloutId: head.rolloutId, release: null, notice: null };
        const { registeredAt: _registeredAt, ...release } = await requireRelease(db, releaseId);
        return { channel, releaseId, reason, rolloutId: head.rolloutId, release, notice: null };
      };
      // Every cell asks often: answer from a read, and take the lock only when the clock has moved the rollout on.
      const first = await read((db) => answer(db, false));
      if (first !== 'advance') return first;
      return (await change((db) => answer(db, true))) as DesiredRelease;
    },

    reportVerdict(rolloutId, cellId, releaseId, gates) {
      return change(async (db) => {
        const before = await requireRollout(db, rolloutId);
        if (releaseId !== before.releaseId) {
          throw new AppError('conflict', 'the verdict is for another release than this rollout', { code: 'fleet.verdict_release_mismatch' });
        }
        if (!before.waves.some((w) => w.startedAt !== null && w.cells.includes(cellId))) {
          throw new AppError('conflict', 'that cell has not been given this release', { code: 'fleet.cell_not_in_wave' });
        }
        const { verdict, failedGates } = verdictOf(gates);
        const rollout = structuredClone(before);
        rollout.verdicts[cellId] = { releaseId, verdict, failedGates, reportedAt: at() };
        const events: RolloutEvent[] = [];
        if (rollout.status === 'running' && verdict === 'fail') {
          haltRolloutState(rollout, 'gate_failed', at());
          events.push('rollout_gate_failed');
        }
        await saveRollout(db, before, rollout);
        logger.info('verdict reported', { event: 'fleet.verdict', resourceType: 'cell', resourceId: cellId, outcome: verdict, count: failedGates.length });
        await logEvents(db, rollout, events);
        return advance(db, rollout);
      });
    },

    haltRollout(rolloutId, haltedBy) {
      return change(async (db) => {
        const rollout = await requireRollout(db, rolloutId);
        if (rollout.status === 'halted') return rollout;
        if (rollout.status !== 'running') {
          throw new AppError('conflict', 'only a running rollout halts; promote the earlier release to go back', { code: 'fleet.rollout_not_running' });
        }
        const halted = structuredClone(rollout);
        haltRolloutState(halted, 'manual', at(), haltedBy);
        await saveRollout(db, rollout, halted);
        logger.warn('rollout halted by hand; cells roll back', { event: 'fleet.rollout_rolled_back', resourceType: 'rollout', resourceId: rolloutId, reason: 'manual' });
        await recordEvent(db, 'rollout_rolled_back', { releaseId: halted.releaseId, rolloutId, cellId: halted.cellId, channel: halted.channel, operatorId: haltedBy,
          detail: { reason: 'manual', to_release_id: halted.previousReleaseId } });
        return halted;
      });
    },

    readRollout(rolloutId) {
      return read((db) => requireRollout(db, rolloutId));
    },

    readPromotion(promotionId) {
      return read(async (db) => {
        const row = await promotionRepo.findById(db, promotionId);
        if (row === undefined) throw new AppError('not_found', 'no such promotion', { code: 'fleet.promotion_unknown' });
        return promotionOf(row);
      });
    },

    signBundle(bundleId, input) {
      requireRole('release', 'sign bundles');
      return change(async (db) => {
        await requireRelease(db, input.releaseId);
        if (input.fromReleaseId !== null) {
          if (input.fromReleaseId === input.releaseId) throw new AppError('validation', 'a bundle builds on an earlier release', { code: 'fleet.bundle_from_self' });
          await requireRelease(db, input.fromReleaseId);
        }
        const existing = await storedBundle(db, bundleId);
        if (existing !== undefined) {
          const same = existing.bundle.releaseId === input.releaseId && existing.bundle.fromReleaseId === input.fromReleaseId
            && canonicalJson(existing.bundle.files) === canonicalJson(input.files);
          if (same) return existing;
          throw new AppError('conflict', 'a different bundle is signed under that id', { code: 'fleet.bundle_exists' });
        }
        const bundle: BundleManifest = {
          schema: 'silo.bundle.v1', bundleId, releaseId: input.releaseId, fromReleaseId: input.fromReleaseId, createdAt: at(), files: input.files,
        };
        const signed: SignedBundle = { bundle, signatures: [await signDocument(signer, 'bundle', bundle)] };
        await saveBundle(db, signed);
        logger.info('bundle signed', { event: 'fleet.bundle_signed', resourceType: 'bundle', resourceId: bundleId, count: input.files.length });
        return signed;
      });
    },

    countersignBundle(bundleId, bundle, bundleSignatures) {
      requireRole('sovereign', 'countersign bundles');
      if (bundle.bundleId !== bundleId) {
        throw new AppError('validation', 'the manifest names another bundle', { code: 'fleet.bundle_id_mismatch' });
      }
      // The Silo release signature first: a sovereign key never vouches for an unsigned bundle.
      verifyDocument('bundle', bundle, bundleSignatures, deps.trusted, ['release']);
      return change(async (db) => {
        const existing = await storedBundle(db, bundleId);
        if (existing !== undefined) {
          if (canonicalJson(existing.bundle) === canonicalJson(bundle)) return existing;
          throw new AppError('conflict', 'a different bundle was countersigned under that id', { code: 'fleet.bundle_exists' });
        }
        const releaseSignatures = bundleSignatures.filter((s) => s.role === 'release');
        const signed: SignedBundle = { bundle, signatures: [...releaseSignatures, await signDocument(signer, 'bundle', bundle)] };
        await saveBundle(db, signed);
        logger.info('bundle countersigned', { event: 'fleet.sovereign_release_countersigned', resourceType: 'bundle', resourceId: bundleId });
        await recordEvent(db, 'sovereign_release_countersigned', { releaseId: bundle.releaseId, detail: {
          bundle_id: bundleId, from_release_id: bundle.fromReleaseId, files: bundle.files.length,
        } });
        return signed;
      });
    },

    tick() {
      return change(async (db) => {
        let advanced = 0;
        for (const row of await rolloutRepo.listRunning(db)) {
          const rollout = await requireRollout(db, row.id);
          if (await advance(db, rollout) !== rollout) advanced += 1;
        }
        if (now() - capacityCheckedAt >= 3_600_000) {
          capacityCheckedAt = now();
          await checkCapacity(db);
        }
        return advanced + await followStable(db);
      });
    },

    checkCapacity() {
      return change((db) => checkCapacity(db));
    },

    async readAgentBinary(hex, offset) {
      const part = await store.readRange(agentBinaryKey(hex), offset, AGENT_BINARY_PART_BYTES);
      if (part === undefined) throw new AppError('not_found', 'no such agent binary', { code: 'fleet.agent_binary_unknown' });
      if (offset >= part.bytes) throw new AppError('validation', 'the offset is past the end of the binary', { code: 'fleet.agent_binary_offset' });
      return { bytes: part.bytes, offset, data: part.data.toString('base64') };
    },

    async authorTemplate(input) {
      const at = new Date(now()).toISOString();
      const fieldNames = [...new Set(input.fieldNames.map((f) => f.trim()))];
      // A change to a reviewed template is a withdrawal and a new template with a fresh review.
      const row = await change(async (db) => conceptTemplateRepo.insert(db, {
        id: uuidv7(), name: input.name.trim(), fieldNames, authoredBy: input.operatorId, createdAt: at,
      })).catch((error: unknown) => {
        if (fromDatabaseError(error).details['sqlstate'] === '23505') {
          throw new AppError('conflict', 'a live template already has that name', { code: 'fleet.template_name_taken' });
        }
        throw error;
      });
      return templateViewOf(row);
    },

    async reviewTemplate(templateId, reviewerId) {
      return templateViewOf(await change(async (db) => {
        const t = await conceptTemplateRepo.findById(db, templateId);
        if (t === undefined) throw new AppError('not_found', 'no such template', { code: 'fleet.template_unknown' });
        if (t.status !== 'draft') throw new AppError('conflict', `the template is ${t.status}`, { code: 'fleet.template_not_draft' });
        if (t.authoredBy === reviewerId) throw new AppError('forbidden', 'a template is reviewed by someone other than its author', { code: 'fleet.two_person' });
        const reviewed = (await conceptTemplateRepo.update(db, templateId, { status: 'reviewed', reviewedBy: reviewerId, reviewedAt: new Date(now()).toISOString() }))!;
        await recordEvent(db, 'template_reviewed', { operatorId: reviewerId, detail: { template_id: templateId, revision: t.revision, author: t.authoredBy, fields: t.fieldNames.length } });
        return reviewed;
      }));
    },

    async withdrawTemplate(templateId, operatorId) {
      return templateViewOf(await change(async (db) => {
        const t = await conceptTemplateRepo.findById(db, templateId);
        if (t === undefined) throw new AppError('not_found', 'no such template', { code: 'fleet.template_unknown' });
        if (t.status === 'withdrawn') return t;
        const withdrawn = (await conceptTemplateRepo.update(db, templateId, { status: 'withdrawn', withdrawnBy: operatorId, withdrawnAt: new Date(now()).toISOString() }))!;
        if (t.status === 'reviewed') await recordEvent(db, 'template_withdrawn', { operatorId, detail: { template_id: templateId, revision: t.revision } });
        return withdrawn;
      }));
    },

    async listTemplates() {
      return (await read((db) => conceptTemplateRepo.listAll(db))).map(templateViewOf);
    },

    async templateSet() {
      const rows = await read((db) => conceptTemplateRepo.listForCells(db));
      // Sorted by id and stamped by the newest change: the same set always signs the same.
      const generatedAt = rows.reduce((latest, r) => (r.updatedAt > latest ? r.updatedAt : latest), '1970-01-01T00:00:00.000Z');
      const set: ConceptTemplateSet = {
        schema: 'silo.concept_templates.v1', generatedAt: new Date(generatedAt).toISOString(),
        templates: rows.map((r) => ({ ...templateViewOf(r), status: r.status as 'reviewed' | 'withdrawn' })),
      };
      return { set, signatures: [await signDocument(signer, 'templates', set)], digest: documentDigest(set) };
    },

    async loadBundle(dir, input) {
      if (input.approverId === input.operatorId) {
        throw new AppError('forbidden', 'a bundle is loaded by one person and approved by another (two-person rule)', { code: 'fleet.two_person' });
      }
      const fail = async (reason: string, error: unknown): Promise<never> => {
        await change((db) => recordEvent(db, 'bundle_refused', { operatorId: input.operatorId, cellId: input.cellId, detail: { reason } }));
        logger.warn('a bundle was refused', { event: 'fleet.bundle_refused', reason, resourceType: 'operator', resourceId: input.operatorId });
        throw error;
      };
      let verified: Awaited<ReturnType<typeof verifyBundle>>;
      try {
        verified = await verifyBundle(dir, { keys: deps.trusted, requireSovereign: signer.role === 'sovereign' });
      } catch (error) {
        return fail(isAppError(error) ? String(error.details['reason'] ?? error.code) : 'unreadable', error);
      }
      const { bundle } = verified;
      const root = path.join(dir, ARTEFACTS_DIR);
      const listed = new Set(bundle.files.map((f) => f.path));
      let manifest: ReleaseManifest;
      let releaseSignatures: SignatureRecord[];
      try {
        if (!listed.has('release.json')) throw new AppError('validation', 'the bundle carries no release.json', { code: 'fleet.bundle_refused', details: { reason: 'no_release' } });
        const signed = z.object({ manifest: releaseManifest, manifestDigest: z.string(), signatures: z.array(signatureRecord) })
          .parse(JSON.parse(await readFile(path.join(root, 'release.json'), 'utf8')));
        verifyDocument('release', signed.manifest, signed.signatures, deps.trusted, ['release']);
        if (signed.manifest.releaseId !== bundle.releaseId || documentDigest(signed.manifest) !== signed.manifestDigest) {
          throw new AppError('integrity', 'the bundle\'s release is not the one its manifest names', { code: 'fleet.bundle_refused', details: { reason: 'release_mismatch' } });
        }
        validateManifest(signed.manifest);
        manifest = signed.manifest;
        releaseSignatures = signed.signatures;
        // A cumulative bundle carries every artefact its release needs.
        const needed = [
          ...manifest.agentBinaries.map((b) => `agent-binaries/${b.digest.slice('sha256:'.length)}`),
          ...[manifest.configurationDigest, manifest.flagsDigest, manifest.modelRoutingDigest, ...(manifest.catalogueDigest ? [manifest.catalogueDigest] : [])]
            .map((d) => `release-documents/${d.slice('sha256:'.length)}`),
        ];
        const missing = needed.find((p) => !listed.has(p));
        if (missing !== undefined) throw new AppError('validation', `the bundle lacks ${missing}, which its release names`, { code: 'fleet.bundle_refused', details: { reason: 'artefact_missing' } });
      } catch (error) {
        return fail(isAppError(error) ? String(error.details['reason'] ?? error.code) : 'release_unreadable', error);
      }
      // Each artefact under its digest: the name is the hash verifyBundle checked.
      for (const file of bundle.files.filter((f) => f.path.startsWith('agent-binaries/') || f.path.startsWith('release-documents/'))) {
        if (file.path.split('/')[1] !== file.sha256) return fail('artefact_name', new AppError('integrity', 'an artefact is not named for its hash', { code: 'fleet.bundle_refused' }));
        await store.create(file.path, await readFile(path.join(root, ...file.path.split('/'))));
      }
      const manifestDigest = documentDigest(manifest);
      const promotionId = uuidv7();
      await change(async (db) => {
        const existing = await readStored(db, manifest.releaseId);
        if (existing !== undefined && existing.manifestDigest !== manifestDigest) {
          throw new AppError('conflict', 'a different manifest is registered under that release; releases are immutable', { code: 'fleet.release_exists' });
        }
        if (existing === undefined) {
          const row = await releaseRepo.insert(db, {
            releaseId: manifest.releaseId, target: manifest.target, manifest: asJson(manifest), manifestDigest, signatures: asJson(releaseSignatures),
            registeredBy: input.operatorId, registeredAt: at(),
          });
          const { registeredAt: _registeredAt, ...published } = releaseView(row);
          await store.write(`releases/${manifest.releaseId}/release.json`, json(published));
        }
        await recordEvent(db, 'bundle_verified', {
          releaseId: manifest.releaseId, operatorId: input.operatorId, cellId: input.cellId, channel: input.channel,
          detail: { bundle_id: bundle.bundleId, from_release_id: bundle.fromReleaseId, files: verified.files, bytes: verified.bytes },
        });
        const promotion = promotionOf(await promotionRepo.insert(db, {
          id: promotionId, releaseId: manifest.releaseId, channel: input.channel, expedite: false, state: 'pending', requestedBy: input.operatorId, requestedAt: at(),
        }));
        await apply(db, promotion, input.approverId);
      });
      logger.info('a bundle was loaded', { event: 'fleet.bundle_loaded', resourceType: 'release', resourceId: manifest.releaseId, count: verified.files });
      return { bundleId: bundle.bundleId, releaseId: manifest.releaseId, files: verified.files, bytes: verified.bytes, promotionId };
    },

    async readReleaseDocument(hex) {
      const body = await store.read(releaseDocumentKey(hex));
      if (body === undefined) throw new AppError('not_found', 'no such release document', { code: 'fleet.release_document_unknown' });
      return { bytes: body.length, data: body.toString('base64') };
    },

    listEvents(filter) {
      return read(async (db) => {
        const rows = await eventRepo.list(db, filter);
        return {
          events: rows.map((r) => ({ ...r, event: r.event as FleetEvent, occurredAt: iso(r.occurredAt), hash: r.hash.toString('hex') }))
            .map(({ previousHash: _previousHash, ...e }) => e),
          next: rows.length === filter.limit ? rows[rows.length - 1]!.seq : null,
        };
      });
    },

    verifyEvents() {
      return read(async (db) => {
        let after = 0;
        let previous: Buffer | null = null;
        let count = 0;
        for (;;) {
          const rows = await eventRepo.list(db, { after, limit: 1_000 });
          if (rows.length === 0) break;
          const broken = chainBreak(rows.map((r) => ({ ...r, event: r.event as FleetEvent })), previous);
          if (broken !== null) return { events: count + rows.findIndex((r) => r.seq === broken), intact: false, brokenAt: broken, headHash: null };
          count += rows.length;
          previous = rows[rows.length - 1]!.hash;
          after = rows[rows.length - 1]!.seq;
        }
        return { events: count, intact: true, brokenAt: null, headHash: previous?.toString('hex') ?? null };
      });
    },

    reportMigrationApplied(cellId, releaseId, migration) {
      return change(async (db) => {
        if (await cellRepo.findById(db, cellId) === undefined) throw new AppError('not_found', 'no such cell', { code: 'fleet.cell_unknown' });
        const release = await requireRelease(db, releaseId);
        const named = release.manifest.migrations.find((m) => m.database === migration.database && m.version === migration.version);
        if (named === undefined || named.name !== migration.name || named.digest !== migration.digest) {
          throw new AppError('conflict', 'the release names no such migration', { code: 'fleet.migration_unknown' });
        }
        if (await eventRepo.migrationRecorded(db, cellId, releaseId, migration.database, migration.version)) return { recorded: false };
        await recordEvent(db, 'migration_applied', { releaseId, cellId, detail: {
          database: migration.database, version: migration.version, name: migration.name, digest: migration.digest, applied_at: migration.appliedAt,
        } });
        return { recorded: true };
      });
    },

    putCellChangePolicy(cellId, policy) {
      return change(async (db) => {
        const cell = await cellRepo.findById(db, cellId);
        if (cell === undefined) throw new AppError('not_found', 'no such cell', { code: 'fleet.cell_unknown' });
        if (cell.kind !== 'dedicated') {
          throw new AppError('conflict', 'change windows hold a dedicated cell\'s own rollouts; this cell takes the channel\'s waves',
            { code: 'fleet.change_policy_not_dedicated' });
        }
        const before = await policyOf(db, cellId);
        const reportedAt = at();
        await cellChangePolicyRepo.put(db, {
          cellId, organisationId: policy.organisationId, timeZone: policy.timeZone, windows: asJson(policy.windows),
          changeAuthorityMembershipId: policy.changeAuthorityMembershipId, freezes: asJson(policy.freezes), exceptions: asJson(policy.exceptions),
          reportedAt,
        });
        const known = new Set((before?.freezes ?? []).map((f) => f.id));
        const set = policy.freezes.filter((f) => !known.has(f.id));
        for (const freeze of set) {
          logger.info('change freeze set', { event: 'fleet.change_freeze_set', resourceType: 'cell', resourceId: cellId, reason: freeze.endsAt });
          await recordEvent(db, 'change_freeze_set', { cellId, detail: {
            freeze_id: freeze.id, starts_at: freeze.startsAt, ends_at: freeze.endsAt, organisation_id: policy.organisationId,
          } });
        }
        return { cellId, reportedAt, freezesSet: set.length };
      });
    },
  };
}
