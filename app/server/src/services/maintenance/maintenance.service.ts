// The maintenance jobs (docs/siloServiceCatalogue.doc.md; database README, partitions;
// design: audit.partition_seals, platform.outbox and the retention notes). Each job is
// idempotent and runs every interval; each unit of work (a partition, a seal, a drop, a
// sweep batch) is its own short transaction as silo_migrate, taking a lock so two
// replicas never do the same unit at once.
//
// - partitions: platform.maintain_partitions() keeps partitions create_ahead units ahead
//   (three months; fourteen days for the outbox) and moves rows out of default partitions;
//   platform.partition_status() is then checked and every unhealthy table alerts.
// - seals: each ledger partition closed for sealGraceDays gets a seal: its row count and a
//   running SHA-256 over its rows in id order (audit_events rows contribute their row_hash,
//   the other ledgers a digest of the row; utils/auditChain.util.ts). A removed or changed
//   row no longer matches. This runs here, not in the audit service, because a partition
//   holds every organisation's rows and only the migration role reads across them.
// - retention: a ledger partition past its retention is dropped only when it is sealed and
//   its rows still match the seal; the seal row stays, marked dropped, as the record that
//   the drop was complete. An outbox partition is dropped 14 days after its day ends, and
//   only when every row in it is published or dead-lettered.
// - sweeps: reset links and sessions 30 days past expiry are removed, invitations past
//   expiry are closed (so the address can be invited again), ended live subscriptions
//   older than 7 days and expired layout precomputations are removed. OAuth flows past
//   expiry are marked expired and their sealed PKCE verifier shredded (the callback
//   already refuses them), and settled flows go with the sessions' retention, before the
//   sessions they reference, so those sessions can go too.
//
// Every job records when it last ran and succeeded; one that has not succeeded within two
// intervals is behind, which alerts and shows on the status endpoint.

import { metrics, type Counter } from '@opentelemetry/api';
import type { MaintenanceConfig } from '../../config/maintenance.config.ts';
import type { Logger } from '../../infra/logger.infra.ts';
import { inTransaction, type Databases, type Queryable } from '../../infra/postgres.infra.ts';
import type { PartitionSeal as SealRow } from '../../models/audit/partitionSeal.model.ts';
import { partitionSealRepo } from '../../repos/audit/index.repo.ts';
import { auditEventMessage } from '../../contracts/audit/auditEvent.contract.ts';
import { recordActionEvent, recordMutationStage } from '../actions/events.service.ts';
import { maintenanceRepo, type LeafPartition, type PartitionStatus } from '../../repos/platform/maintenance.repo.ts';
import { outboxRepo } from '../../repos/platform/index.repo.ts';
import { PartitionSeal, rowDigest } from '../../utils/auditChain.util.ts';
import { uuidv7 } from '../../utils/id.util.ts';

export const JOBS = ['partitions', 'seals', 'retention', 'sweeps'] as const;
export type JobName = (typeof JOBS)[number];

export interface JobState {
  lastRunAt: string | null;
  lastSuccessAt: string | null;
  outcome: 'never' | 'ok' | 'failed';
  /** Counts from the last run: partitions sealed, rows removed and the like. */
  counts: Record<string, number>;
}

type Pool = ReturnType<Databases['pool']>;

export interface MaintenanceDeps {
  pool: Pool;
  config: MaintenanceConfig;
  logger: Logger;
  now?: () => Date;
}

const LEDGERS: { ledger: SealRow['ledger']; parent: string }[] = [
  { ledger: 'audit.auth_events', parent: 'audit.auth_events' },
  { ledger: 'audit.audit_events', parent: 'audit.audit_events' },
  { ledger: 'platform.model_calls', parent: 'platform.model_calls' },
  { ledger: 'iam.credential_unwraps', parent: 'iam.credential_unwraps' },
];
const OUTBOX_KEEP_DAYS = 14;
const LIVE_SUBSCRIPTION_KEEP_DAYS = 7;
/** A live subscription whose holder has not heartbeated for this long is expired (spec 30.5). */
const LIVE_HEARTBEAT_LAPSE_MS = 2 * 60_000;
const PAGE = 5_000;
const MAX_BATCHES = 100;
const DAY_MS = 86_400_000;

let failures: Counter | undefined;
const failureCounter = () => (failures ??= metrics.getMeter('silo').createCounter('silo.maintenance.job_failed'));

const monthsBefore = (now: Date, months: number): Date => {
  const d = new Date(now);
  d.setUTCMonth(d.getUTCMonth() - months);
  return d;
};

export function createMaintenance(deps: MaintenanceDeps) {
  const { config, logger } = deps;
  const now = deps.now ?? (() => new Date());
  const state = Object.fromEntries(JOBS.map((job) => [job, { lastRunAt: null, lastSuccessAt: null, outcome: 'never', counts: {} }])) as
    Record<JobName, JobState>;
  let unhealthy: PartitionStatus[] = [];

  /** One unit of work as silo_migrate; undefined when another replica holds the unit. */
  const unit = <T>(lock: string, work: (db: Queryable) => Promise<T>): Promise<T | undefined> =>
    inTransaction(deps.pool, {}, async (db) => {
      await maintenanceRepo.actAsMigrate(db);
      if (!await maintenanceRepo.tryLock(db, lock)) return undefined;
      return work(db);
    });

  // A seal covers the rows a partition held when it was sealed, in id order. Checking it
  // again covers that many: a tenant migration may later load another organisation's old
  // rows into a sealed partition (spec 6.4), and they take ids after every sealed row.
  async function computeSeal(db: Queryable, ledger: SealRow['ledger'], leaf: LeafPartition, sealedRows?: number): Promise<PartitionSeal> {
    const seal = new PartitionSeal();
    let after = '0';
    for (;;) {
      const rows = await maintenanceRepo.partitionRows(db, leaf, after, PAGE);
      for (const row of rows) {
        if (sealedRows !== undefined && seal.rowCount >= sealedRows) return seal;
        seal.add(ledger === 'audit.audit_events' ? row['row_hash'] as Buffer : rowDigest(row));
      }
      if (rows.length < PAGE) return seal;
      after = String(rows.at(-1)!['id']);
    }
  }

  const retentionCutoff = (ledger: SealRow['ledger'], leaf: LeafPartition, at: Date): Date => {
    const { retention } = config;
    if (ledger === 'audit.audit_events' && leaf.parent === 'audit_events_high_volume') return new Date(at.getTime() - retention.highVolumeDays * DAY_MS);
    if (ledger === 'platform.model_calls') return monthsBefore(at, retention.modelCallMonths);
    return monthsBefore(at, retention.auditMonths);
  };

  const jobs: Record<JobName, () => Promise<Record<string, number>>> = {
    async partitions() {
      const status = await unit('partitions', async (db) => {
        await maintenanceRepo.maintainPartitions(db);
        return maintenanceRepo.partitionStatus(db);
      });
      if (status === undefined) return { skipped: 1 };
      unhealthy = status.filter((s) => !s.healthy);
      for (const s of unhealthy) {
        logger.error('a partitioned table needs attention', {
          event: 'partitions.unhealthy', resourceType: 'partitioned_table', reason: s.parent,
          ...(s.defaultRows !== null ? { rowCount: Number(s.defaultRows) } : {}),
          outcome: s.coveredUntil === null && s.defaultRows === null ? 'table_missing' : 'behind_or_default_rows',
        });
      }
      return { tables: status.length, unhealthy: unhealthy.length };
    },

    async seals() {
      const closedBefore = new Date(now().getTime() - config.sealGraceDays * DAY_MS);
      let sealed = 0;
      for (const { ledger, parent } of LEDGERS) {
        const leaves = await unit(`leaves:${parent}`, (db) => maintenanceRepo.leafPartitions(db, parent)) ?? [];
        for (const leaf of leaves.filter((l) => Date.parse(l.rangeEnd) <= closedBefore.getTime())) {
          const done = await unit(`seal:${leaf.schema}.${leaf.table}`, async (db) => {
            if (await partitionSealRepo.findByLedgerAndPartitionName(db, { ledger, partitionName: leaf.table })) return false;
            const seal = await computeSeal(db, ledger, leaf);
            await partitionSealRepo.insert(db, {
              id: uuidv7(), ledger, partitionName: leaf.table, rangeStart: leaf.rangeStart, rangeEnd: leaf.rangeEnd,
              rowCount: String(seal.rowCount), runningHash: seal.runningHash,
            });
            return true;
          });
          if (done) {
            sealed += 1;
            logger.info('ledger partition sealed', { event: 'partition.sealed', resourceType: 'partition', reason: `${leaf.schema}.${leaf.table}` });
          }
        }
      }
      return { sealed };
    },

    async retention() {
      const at = now();
      let dropped = 0;
      let waiting = 0;
      for (const { ledger, parent } of LEDGERS) {
        const leaves = await unit(`leaves:${parent}`, (db) => maintenanceRepo.leafPartitions(db, parent)) ?? [];
        for (const leaf of leaves.filter((l) => Date.parse(l.rangeEnd) <= retentionCutoff(ledger, l, at).getTime())) {
          const name = `${leaf.schema}.${leaf.table}`;
          const outcome = await unit(`drop:${name}`, async (db) => {
            const seal = await partitionSealRepo.findByLedgerAndPartitionName(db, { ledger, partitionName: leaf.table });
            if (!seal || seal.droppedAt !== null) return 'unsealed' as const;
            const recomputed = await computeSeal(db, ledger, leaf, Number(seal.rowCount));
            if (String(recomputed.rowCount) !== seal.rowCount || !recomputed.runningHash.equals(seal.runningHash)) return 'mismatch' as const;
            await maintenanceRepo.dropPartition(db, leaf);
            await maintenanceRepo.markSealDropped(db, ledger, leaf.table);
            return 'dropped' as const;
          });
          if (outcome === 'dropped') {
            dropped += 1;
            logger.info('ledger partition dropped at the end of retention', { event: 'partition.dropped', resourceType: 'partition', reason: name });
          } else if (outcome === 'mismatch') {
            waiting += 1;
            logger.error('a sealed ledger partition no longer matches its seal; not dropped', {
              event: 'partition.seal_mismatch', resourceType: 'partition', reason: name,
            });
          } else if (outcome === 'unsealed') {
            waiting += 1;
            logger.warn('a ledger partition past retention waits for its seal', { event: 'partition.unsealed', resourceType: 'partition', reason: name });
          }
        }
      }
      const outboxBefore = at.getTime() - OUTBOX_KEEP_DAYS * DAY_MS;
      const outboxLeaves = await unit('leaves:platform.outbox', (db) => maintenanceRepo.leafPartitions(db, 'platform.outbox')) ?? [];
      for (const leaf of outboxLeaves.filter((l) => Date.parse(l.rangeEnd) <= outboxBefore)) {
        const name = `${leaf.schema}.${leaf.table}`;
        const unsettled = await unit(`drop:${name}`, async (db) => {
          const count = await maintenanceRepo.unsettledOutboxRows(db, leaf);
          if (count === 0) await maintenanceRepo.dropPartition(db, leaf);
          return count;
        });
        if (unsettled === 0) {
          dropped += 1;
          logger.info('outbox partition dropped', { event: 'partition.dropped', resourceType: 'partition', reason: name });
        } else if (unsettled !== undefined) {
          waiting += 1;
          logger.error('an outbox partition past 14 days still holds unpublished rows; not dropped', {
            event: 'outbox.partition_unsettled', resourceType: 'partition', reason: name, rowCount: unsettled,
          });
        }
      }
      return { dropped, waiting };
    },

    async sweeps() {
      const at = now().getTime();
      /** An audit event of a sweep, by maintenance acting on its own, in the sweep's transaction. */
      const sweepEvent = async (db: Queryable, organisationId: string, event: string, resource: { type: string; id: string }, subject: string | null = null) => {
        const payload = auditEventMessage.schema.parse({
          event, actor: { kind: 'service', service: 'maintenance' }, subjectMembershipId: subject, scopeId: null, resource,
          purposeSessionId: null, operatorAccessSessionId: null, ipHash: null, detail: {},
        });
        await outboxRepo.insert(db, {
          id: uuidv7(), organisationId, topic: auditEventMessage.topic, orderingKey: organisationId,
          event: auditEventMessage.name, schemaVersion: auditEventMessage.version, payload, correlationId: uuidv7(),
        });
      };
      const { retention, sweepBatch } = config;
      const sweep = async (name: string, statement: (db: Queryable) => Promise<number>): Promise<number> => {
        let total = 0;
        for (let i = 0; i < MAX_BATCHES; i++) {
          const n = await unit(`sweep:${name}`, statement) ?? 0;
          total += n;
          if (n < sweepBatch) break;
        }
        return total;
      };
      const counts = {
        passwordResets: await sweep('password_resets', (db) =>
          maintenanceRepo.deleteExpiredPasswordResets(db, new Date(at - retention.resetDays * DAY_MS).toISOString(), sweepBatch)),
        oauthFlowsExpired: await sweep('oauth_flows_expired', (db) => maintenanceRepo.expireOAuthFlows(db, new Date(at).toISOString(), sweepBatch)),
        oauthFlowsRemoved: await sweep('oauth_flows_removed', (db) =>
          maintenanceRepo.deleteSettledOAuthFlows(db, new Date(at - retention.sessionDays * DAY_MS).toISOString(), sweepBatch)),
        sessions: await sweep('sessions', (db) =>
          maintenanceRepo.deleteExpiredSessions(db, new Date(at - retention.sessionDays * DAY_MS).toISOString(), sweepBatch)),
        invitations: await sweep('invitations', (db) => maintenanceRepo.closeExpiredInvitations(db, sweepBatch)),
        liveSubscriptions: await sweep('live_subscriptions', (db) =>
          maintenanceRepo.deleteEndedLiveSubscriptions(db, new Date(at - LIVE_SUBSCRIPTION_KEEP_DAYS * DAY_MS).toISOString(), sweepBatch)),
        layoutPrecomputations: await sweep('layout_precomputations', (db) => maintenanceRepo.deleteExpiredLayoutPrecomputations(db, sweepBatch)),
        // A closed scenario branch keeps its bases (values) for its retention, then they purge (spec 39.11).
        branchBases: await sweep('branch_bases', (db) => maintenanceRepo.purgeBranchBases(db, sweepBatch)),
        branchesPurged: await sweep('branches_purged', (db) => maintenanceRepo.closeOutPurgedBranches(db, sweepBatch)),
        liveSubscriptionsLapsed: await sweep('live_subscriptions_lapsed', (db) =>
          maintenanceRepo.expireLapsedLiveSubscriptions(db, new Date(at - LIVE_HEARTBEAT_LAPSE_MS).toISOString(), sweepBatch)),
        // Each expiry below is reported once, in the transaction that records it.
        viewShares: await sweep('view_shares', async (db) => {
          const expired = await maintenanceRepo.expireViewShares(db, sweepBatch);
          for (const share of expired) {
            await sweepEvent(db, share.organisationId, 'view_share_expired', { type: 'view_share', id: share.id });
          }
          return expired.length;
        }),
        // A service principal past its expiry is refused from that moment; the expiry is recorded once (spec 60.8).
        servicePrincipalsExpired: await sweep('service_principals_expired', async (db) => {
          const expired = await maintenanceRepo.recordExpiredPrincipals(db, sweepBatch);
          for (const p of expired) {
            await sweepEvent(db, p.organisationId, 'service_principal_expired', { type: 'service_principal', id: p.id }, p.ownerMembershipId);
          }
          return expired.length;
        }),
        cronAuthorisations: await sweep('cron_authorisations', async (db) => {
          const expired = await maintenanceRepo.recordExpiredAuthorisations(db, sweepBatch);
          for (const a of expired) {
            await sweepEvent(db, a.organisationId, 'automation_authorisation_expired', { type: 'automation', id: a.automationId }, a.authorisedBy);
          }
          return expired.length;
        }),
        appShares: await sweep('app_shares', async (db) => {
          const expired = await maintenanceRepo.expireAppShares(db, sweepBatch);
          for (const share of expired) {
            await sweepEvent(db, share.organisationId, 'app_share_expired', { type: 'app', id: share.appId });
          }
          return expired.length;
        }),
        purposeSessions: await sweep('purpose_sessions', async (db) => {
          const expired = await maintenanceRepo.expirePurposeSessions(db, sweepBatch);
          for (const session of expired) {
            await sweepEvent(db, session.organisationId, 'purpose_session_expired', { type: 'purpose_session', id: session.id }, session.membershipId);
          }
          return expired.length;
        }),
        approvalChains: await sweep('approval_chains', async (db) => {
          const expired = await maintenanceRepo.expireApprovalChains(db, sweepBatch);
          for (const chain of expired) {
            const correlationId = uuidv7();
            if (chain.mutationId !== null && chain.mutationExpired) {
              await recordMutationStage(db, { organisationId: chain.organisationId, correlationId, mutationId: chain.mutationId, stage: 'expired', rowCount: chain.rowCount });
            }
            await recordActionEvent(db, {
              organisationId: chain.organisationId, correlationId, event: 'approval_expired', service: 'approvals',
              resource: { type: 'approval_chain', id: chain.id }, detail: { mutation_id: chain.mutationId },
            });
          }
          return expired.length;
        }),
      };
      // Counts only, as the receipt of each sweep (design: clone, decision 5).
      for (const [table, rowCount] of Object.entries(counts)) {
        if (rowCount > 0) logger.info('expired rows swept', { event: 'sweep.completed', resourceType: table, rowCount });
      }
      return counts;
    },
  };

  const behind = (job: JobName): boolean => {
    const s = state[job];
    const limit = 2 * config.intervalSeconds * 1000;
    if (s.lastRunAt === null) return false;
    return s.lastSuccessAt === null || now().getTime() - Date.parse(s.lastSuccessAt) > limit;
  };

  return {
    /** Runs one job, recording its outcome. Never throws: a failure is logged and counted. */
    async run(job: JobName): Promise<JobState> {
      const s = state[job];
      s.lastRunAt = now().toISOString();
      try {
        s.counts = await jobs[job]();
        s.outcome = 'ok';
        s.lastSuccessAt = now().toISOString();
      } catch (error) {
        s.outcome = 'failed';
        failureCounter().add(1, { job });
        logger.failure('a maintenance job failed; it runs again next interval', error, { event: 'maintenance.job_failed', reason: job });
      }
      if (behind(job)) {
        logger.error('a maintenance job has not succeeded within two intervals', { event: 'maintenance.behind', reason: job });
      }
      return { ...s, counts: { ...s.counts } };
    },

    async runAll(): Promise<void> {
      for (const job of JOBS) await this.run(job);
    },

    status() {
      return {
        jobs: JOBS.map((name) => ({ name, ...state[name], behind: behind(name) })),
        unhealthyPartitions: unhealthy.map((s) => ({
          parent: s.parent, coveredUntil: s.coveredUntil, requiredUntil: s.requiredUntil,
          defaultRows: s.defaultRows === null ? null : Number(s.defaultRows),
        })),
      };
    },
  };
}

export type Maintenance = ReturnType<typeof createMaintenance>;
