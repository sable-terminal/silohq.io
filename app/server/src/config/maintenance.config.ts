// The maintenance service (docs/siloServiceCatalogue.doc.md): partitions kept ahead,
// ledger partitions sealed and dropped at the end of retention, expiry sweeps, and an
// alert when any of them falls behind.
//
// Every one of these jobs crosses organisations or changes the schema, which only the
// migration role may do (spec 11.3; database README, Roles). So maintenance connects
// with its own login, a member of silo_migrate, given in MAINTENANCE_DATABASE_URL, and
// acts as the role inside each transaction. Request-serving pods never hold it: the
// configuration refuses the URL in any process that hosts a service other than the
// platform workers (maintenance, outbox-relay, tenant-migrations), which run in their own
// deployment. The URL may name Postgres directly or the transaction pooler; nothing the
// jobs do outlives a transaction.
//
// Retention (design: audit and platform schemas; open decision, spec 63.4): seven years
// for the audit ledgers and the unwrap ledger, 400 days for high-volume audit events, 13
// months for model calls, 30 days past expiry for sessions and reset links. A ledger
// partition is dropped only once sealed, and only when its seal still matches.

import { z } from 'zod';
import { parseSection, read, readSecret, zPositiveInt, zPostgresUrl, type Env } from './env.config.ts';

const schema = z.object({
  databaseUrl: zPostgresUrl.optional(),
  intervalSeconds: zPositiveInt(86_400).default(3_600),
  sealGraceDays: zPositiveInt(90).default(15),
  auditRetentionMonths: zPositiveInt(240).default(84),
  highVolumeRetentionDays: zPositiveInt(3_650).default(400),
  modelCallRetentionMonths: zPositiveInt(240).default(13),
  sessionRetentionDays: zPositiveInt(3_650).default(30),
  resetRetentionDays: zPositiveInt(3_650).default(30),
  sweepBatch: zPositiveInt(100_000).default(1_000),
  statementTimeoutMs: zPositiveInt(3_600_000).default(600_000),
});

export interface MaintenanceConfig {
  /** A login in silo_migrate. Only the platform workers' deployment holds it. */
  databaseUrl: string | undefined;
  /** How often every job runs. Each is idempotent, so running more often than daily is safe. */
  intervalSeconds: number;
  /**
   * Days after a partition's range ends before it is sealed. Audit rows take their time from
   * the outbox row, which the relay may retry for 7 days and the bus may hold for 7 more, so a
   * late row can still land in a closed month for about 14 days.
   */
  sealGraceDays: number;
  retention: {
    auditMonths: number;
    highVolumeDays: number;
    modelCallMonths: number;
    sessionDays: number;
    resetDays: number;
  };
  /** Rows a sweep removes per statement. */
  sweepBatch: number;
  statementTimeoutMs: number;
}

export function loadMaintenanceConfig(env: Env, problems: string[]): MaintenanceConfig | undefined {
  const parsed = parseSection(schema, {
    databaseUrl: readSecret(env, 'MAINTENANCE_DATABASE_URL', problems),
    intervalSeconds: read(env, 'MAINTENANCE_INTERVAL_SECONDS'),
    sealGraceDays: read(env, 'MAINTENANCE_SEAL_GRACE_DAYS'),
    auditRetentionMonths: read(env, 'AUDIT_RETENTION_MONTHS'),
    highVolumeRetentionDays: read(env, 'AUDIT_HIGH_VOLUME_RETENTION_DAYS'),
    modelCallRetentionMonths: read(env, 'MODEL_CALL_RETENTION_MONTHS'),
    sessionRetentionDays: read(env, 'SESSION_RETENTION_DAYS'),
    resetRetentionDays: read(env, 'PASSWORD_RESET_RETENTION_DAYS'),
    sweepBatch: read(env, 'MAINTENANCE_SWEEP_BATCH'),
    statementTimeoutMs: read(env, 'MAINTENANCE_STATEMENT_TIMEOUT_MS'),
  }, {
    databaseUrl: 'MAINTENANCE_DATABASE_URL', intervalSeconds: 'MAINTENANCE_INTERVAL_SECONDS', sealGraceDays: 'MAINTENANCE_SEAL_GRACE_DAYS',
    auditRetentionMonths: 'AUDIT_RETENTION_MONTHS', highVolumeRetentionDays: 'AUDIT_HIGH_VOLUME_RETENTION_DAYS',
    modelCallRetentionMonths: 'MODEL_CALL_RETENTION_MONTHS', sessionRetentionDays: 'SESSION_RETENTION_DAYS',
    resetRetentionDays: 'PASSWORD_RESET_RETENTION_DAYS', sweepBatch: 'MAINTENANCE_SWEEP_BATCH',
    statementTimeoutMs: 'MAINTENANCE_STATEMENT_TIMEOUT_MS',
  }, problems);
  if (!parsed) return undefined;
  if (parsed.databaseUrl !== undefined && new URL(parsed.databaseUrl).username === 'postgres') {
    problems.push('MAINTENANCE_DATABASE_URL: never the superuser; a login in silo_migrate (spec 11.3)');
  }
  return {
    databaseUrl: parsed.databaseUrl,
    intervalSeconds: parsed.intervalSeconds,
    sealGraceDays: parsed.sealGraceDays,
    retention: {
      auditMonths: parsed.auditRetentionMonths,
      highVolumeDays: parsed.highVolumeRetentionDays,
      modelCallMonths: parsed.modelCallRetentionMonths,
      sessionDays: parsed.sessionRetentionDays,
      resetDays: parsed.resetRetentionDays,
    },
    sweepBatch: parsed.sweepBatch,
    statementTimeoutMs: parsed.statementTimeoutMs,
  };
}

/** The services that may share a process with the migration login. */
export const PLATFORM_WORKERS = ['maintenance', 'outbox-relay', 'tenant-migrations'] as const;
