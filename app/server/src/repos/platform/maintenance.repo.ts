// The maintenance jobs' statements: partitions, seals, retention drops and expiry sweeps
// (database README: partitions; design: audit.partition_seals, platform.outbox, and the
// retention notes of iam.sessions, iam.password_resets and the clone caches).
//
// Hand-written, not scaffolded: these cross tables and organisations, which only the
// migration role may do. Every statement here runs in a transaction that first calls
// actAsMigrate (the login is a member of silo_migrate; BYPASSRLS is not inherited through
// membership, so the role is set for the transaction). Table names in dynamic statements
// come only from pg_catalog and are quoted here.

import type { Queryable } from '../base.repo.ts';

export interface PartitionStatus {
  parent: string;
  granularity: string;
  coveredUntil: string | null;
  requiredUntil: string;
  defaultRows: string | null;
  healthy: boolean;
}

export interface LeafPartition {
  schema: string;
  table: string;
  /** The partitioned table it hangs from directly: for audit.audit_events, its retention class. */
  parent: string;
  rangeStart: string;
  rangeEnd: string;
}

/** A Postgres identifier, quoted. Only ever given names read from pg_catalog. */
const ident = (name: string): string => `"${name.replace(/"/g, '""')}"`;
const qualified = (p: { schema: string; table: string }): string => `${ident(p.schema)}.${ident(p.table)}`;
const BOUND = /^FOR VALUES FROM \('([^']+)'\) TO \('([^']+)'\)$/;
const iso = (text: string): string => new Date(text.replace(' ', 'T').replace(/([+-]\d\d)$/, '$1:00')).toISOString();

export const maintenanceRepo = {
  /** Acts as silo_migrate until the transaction ends (SET LOCAL ROLE). */
  async actAsMigrate(db: Queryable): Promise<void> {
    await db.query(`select set_config('role', 'silo_migrate', true)`);
  },

  /** One replica at a time per job: false when another holds it. Released at commit. */
  async tryLock(db: Queryable, job: string): Promise<boolean> {
    const { rows } = await db.query(`select pg_try_advisory_xact_lock(hashtextextended('platform.maintenance:' || $1::text, 0)) as locked`, [job]);
    return (rows[0] as { locked: boolean }).locked;
  },

  async maintainPartitions(db: Queryable): Promise<void> {
    await db.query('select platform.maintain_partitions()');
  },

  async partitionStatus(db: Queryable): Promise<PartitionStatus[]> {
    const { rows } = await db.query(
      `select parent, granularity, covered_until as "coveredUntil", required_until as "requiredUntil",
              default_rows as "defaultRows", healthy
       from platform.partition_status()`);
    return rows as PartitionStatus[];
  },

  /** The range partitions at the bottom of a partitioned table, defaults excluded. */
  async leafPartitions(db: Queryable, parent: string): Promise<LeafPartition[]> {
    const { rows } = await db.query(
      `with recursive tree as (
         select i.inhrelid as oid, i.inhparent as parent from pg_inherits i where i.inhparent = $1::regclass
         union all
         select i.inhrelid, i.inhparent from tree t join pg_inherits i on i.inhparent = t.oid
       )
       select n.nspname as schema, c.relname as "table", pc.relname as parent, pg_get_expr(c.relpartbound, c.oid) as bound
       from tree t
       join pg_class c on c.oid = t.oid
       join pg_namespace n on n.oid = c.relnamespace
       join pg_class pc on pc.oid = t.parent
       where c.relkind = 'r'
       order by c.relname`, [parent]);
    const leaves: LeafPartition[] = [];
    for (const row of rows as { schema: string; table: string; parent: string; bound: string }[]) {
      const match = BOUND.exec(row.bound);
      if (!match) continue;
      leaves.push({ schema: row.schema, table: row.table, parent: row.parent, rangeStart: iso(match[1]!), rangeEnd: iso(match[2]!) });
    }
    return leaves;
  },

  /** A page of a partition's rows in id order, every column as the database returns it. */
  async partitionRows(db: Queryable, partition: { schema: string; table: string }, afterId: string, limit: number)
    : Promise<Record<string, unknown>[]> {
    const { rows } = await db.query(
      `select * from ${qualified(partition)} where id > $1::bigint order by id limit $2`, [afterId, limit]);
    return rows as Record<string, unknown>[];
  },

  async dropPartition(db: Queryable, partition: { schema: string; table: string }): Promise<void> {
    await db.query(`drop table ${qualified(partition)}`);
  },

  /** Records that retention dropped a sealed partition; the seal row stays as the record. */
  async markSealDropped(db: Queryable, ledger: string, partitionName: string): Promise<void> {
    await db.query(
      'update audit.partition_seals set dropped_at = now() where ledger = $1 and partition_name = $2 and dropped_at is null',
      [ledger, partitionName]);
  },

  /** Outbox rows in a partition that are neither published nor dead-lettered. */
  async unsettledOutboxRows(db: Queryable, partition: { schema: string; table: string }): Promise<number> {
    const { rows } = await db.query(
      `select count(*)::bigint as n from ${qualified(partition)} where published_at is null and dead_lettered_at is null`);
    return Number((rows[0] as { n: string }).n);
  },

  // Expiry sweeps. Each removes or closes at most `batch` rows per call; the job calls
  // again until a call does less than a batch.

  async deleteExpiredPasswordResets(db: Queryable, expiredBefore: string, batch: number): Promise<number> {
    const { rowCount } = await db.query(
      `delete from iam.password_resets where id in (
         select id from iam.password_resets where expires_at < $1 limit $2)`, [expiredBefore, batch]);
    return rowCount ?? 0;
  },

  /** Sessions past expiry, except any still referenced (a purpose session, an OAuth flow, a live subscription). */
  async deleteExpiredSessions(db: Queryable, expiredBefore: string, batch: number): Promise<number> {
    const { rowCount } = await db.query(
      `delete from iam.sessions where id in (
         select s.id from iam.sessions s
         where s.expires_at < $1
           and not exists (select 1 from gov.purpose_sessions p where p.organisation_id = s.organisation_id and p.session_id = s.id)
           and not exists (select 1 from connect.oauth_pending_flows f where f.organisation_id = s.organisation_id and f.session_id = s.id)
           and not exists (select 1 from clone.live_subscriptions l where l.organisation_id = s.organisation_id and l.session_id = s.id)
         limit $2)`, [expiredBefore, batch]);
    return rowCount ?? 0;
  },

  /**
   * Closes invitations past expiry, so the address may be invited again (one open
   * invitation per address). An expired invitation could never be accepted anyway.
   */
  async closeExpiredInvitations(db: Queryable, batch: number): Promise<number> {
    const { rowCount } = await db.query(
      `update iam.invitations set revoked_at = expires_at where id in (
         select id from iam.invitations where accepted_at is null and revoked_at is null and expires_at < now() limit $1)`, [batch]);
    return rowCount ?? 0;
  },

  /**
   * OAuth flows past expiry and never used: marked expired at their expiry, and the sealed
   * PKCE verifier shredded, so nothing of an abandoned authorisation stays openable.
   */
  async expireOAuthFlows(db: Queryable, now: string, batch: number): Promise<number> {
    const { rowCount } = await db.query(
      `update connect.oauth_pending_flows set expired_at = expires_at, pkce_verifier_sealed = null
        where (organisation_id, state_hash) in (
          select organisation_id, state_hash from connect.oauth_pending_flows
           where consumed_at is null and expired_at is null and expires_at < $1 limit $2)`, [now, batch]);
    return rowCount ?? 0;
  },

  /** Settled OAuth flows (used or expired) whose expiry is past the sessions' retention. */
  async deleteSettledOAuthFlows(db: Queryable, expiredBefore: string, batch: number): Promise<number> {
    const { rowCount } = await db.query(
      `delete from connect.oauth_pending_flows where (organisation_id, state_hash) in (
         select organisation_id, state_hash from connect.oauth_pending_flows
          where (consumed_at is not null or expired_at is not null) and expires_at < $1 limit $2)`, [expiredBefore, batch]);
    return rowCount ?? 0;
  },

  /** Live subscriptions ended more than seven days ago (design: clone, decision 5). */
  async deleteEndedLiveSubscriptions(db: Queryable, endedBefore: string, batch: number): Promise<number> {
    const { rowCount } = await db.query(
      `delete from clone.live_subscriptions where id in (
         select id from clone.live_subscriptions where ended_at < $1 limit $2)`, [endedBefore, batch]);
    return rowCount ?? 0;
  },

  /**
   * View shares past their expiry, closed at it (revoked_at = expires_at, as invitations are),
   * so each is reported once; the workspace shows a share closed at its expiry as expired.
   */
  async expireViewShares(db: Queryable, batch: number): Promise<{ id: string; organisationId: string }[]> {
    const { rows } = await db.query(
      `update workspace.view_shares set revoked_at = expires_at where id in (
         select id from workspace.view_shares where revoked_at is null and expires_at is not null and expires_at <= now()
          limit $1 for update skip locked)
       returning id, organisation_id as "organisationId"`, [batch]);
    return rows as { id: string; organisationId: string }[];
  },

  /** Purpose sessions past their expiry, ended at it with reason expired (spec 58.5). */
  async expirePurposeSessions(db: Queryable, batch: number)
    : Promise<{ id: string; organisationId: string; membershipId: string | null }[]> {
    const { rows } = await db.query(
      `update gov.purpose_sessions set ended_at = expires_at, ended_reason = 'expired' where id in (
         select id from gov.purpose_sessions where ended_at is null and expires_at <= now() limit $1 for update skip locked)
       returning id, organisation_id as "organisationId", membership_id as "membershipId"`, [batch]);
    return rows as { id: string; organisationId: string; membershipId: string | null }[];
  },

  /** Live subscriptions whose holder stopped heartbeating, ended as expired (spec 30.5). */
  async expireLapsedLiveSubscriptions(db: Queryable, heartbeatBefore: string, batch: number): Promise<number> {
    const { rowCount } = await db.query(
      `update clone.live_subscriptions set ended_at = now(), end_reason = 'expired' where id in (
         select id from clone.live_subscriptions where ended_at is null and last_heartbeat_at < $1 limit $2 for update skip locked)`,
      [heartbeatBefore, batch]);
    return rowCount ?? 0;
  },

  /**
   * Pending approval chains past their time (spec 44), expired with the mutation awaiting
   * them, as the approvals service does when one is next touched.
   */
  async expireApprovalChains(db: Queryable, batch: number)
    : Promise<{ id: string; organisationId: string; mutationId: string | null; mutationExpired: boolean; rowCount: number }[]> {
    const { rows } = await db.query(
      `with due as (
         update action.approval_chains set status = 'expired', closed_at = now() where id in (
           select id from action.approval_chains where status = 'pending' and expires_at <= now() limit $1 for update skip locked)
         returning id, organisation_id, mutation_id),
       expired as (
         update action.mutations m set status = 'expired', completed_at = now()
           from due where m.organisation_id = due.organisation_id and m.id = due.mutation_id and m.status = 'awaiting_approval'
         returning m.id, m.row_count)
       select due.id, due.organisation_id as "organisationId", due.mutation_id as "mutationId",
              (expired.id is not null) as "mutationExpired", coalesce(expired.row_count, 0) as "rowCount"
         from due left join expired on expired.id = due.mutation_id`, [batch]);
    return rows as { id: string; organisationId: string; mutationId: string | null; mutationExpired: boolean; rowCount: number }[];
  },

  /** Layout precomputations past their expiry. */
  async deleteExpiredLayoutPrecomputations(db: Queryable, batch: number): Promise<number> {
    const { rowCount } = await db.query(
      `delete from clone.layout_precomputations where id in (
         select id from clone.layout_precomputations where expires_at < now() limit $1)`, [batch]);
    return rowCount ?? 0;
  },

  /** Bases of closed branches past their retention: purged (both values nulled by the table's trigger). */
  async purgeBranchBases(db: Queryable, batch: number): Promise<number> {
    const result = await db.query(
      `with due as (
         select b.organisation_id, b.id from simulation.staged_action_bases b
           join simulation.staged_actions s on s.organisation_id = b.organisation_id and s.id = b.staged_action_id
           join simulation.scenario_branches r on r.organisation_id = s.organisation_id and r.id = s.branch_id
          where r.bases_purge_at <= now() and r.bases_purged_at is null and b.purged_at is null
          limit $1)
       update simulation.staged_action_bases x set purged_at = now() from due where x.organisation_id = due.organisation_id and x.id = due.id`, [batch]);
    return result.rowCount ?? 0;
  },

  /** Branches whose bases are all purged: marked, and their staged parameter values nulled. */
  async closeOutPurgedBranches(db: Queryable, batch: number): Promise<number> {
    const result = await db.query(
      `with done as (
         update simulation.scenario_branches r set bases_purged_at = now()
          where (r.organisation_id, r.id) in (
            select r2.organisation_id, r2.id from simulation.scenario_branches r2
             where r2.bases_purge_at <= now() and r2.bases_purged_at is null
               and not exists (select 1 from simulation.staged_actions s
                                 join simulation.staged_action_bases b on b.organisation_id = s.organisation_id and b.staged_action_id = s.id
                                where s.organisation_id = r2.organisation_id and s.branch_id = r2.id and b.purged_at is null)
             limit $1)
          returning r.organisation_id, r.id)
       update simulation.staged_actions s set manifest_values = null from done where s.organisation_id = done.organisation_id and s.branch_id = done.id`, [batch]);
    return result.rowCount ?? 0;
  },

  /** Service principals whose expiry has passed and is not yet recorded: recorded now, once each (spec 60.8). */
  async recordExpiredPrincipals(db: Queryable, batch: number)
    : Promise<{ id: string; organisationId: string; ownerMembershipId: string; kind: string }[]> {
    const { rows } = await db.query(
      `update iam.service_principals set expiry_recorded_at = now() where id in (
         select id from iam.service_principals
          where expires_at <= now() and revoked_at is null and expiry_recorded_at is null limit $1 for update skip locked)
       returning id, organisation_id as "organisationId", owner_membership_id as "ownerMembershipId", kind`, [batch]);
    return rows as { id: string; organisationId: string; ownerMembershipId: string; kind: string }[];
  },

  /** Cron execute authorisations past their expiry, recorded once (spec 40.6; D70): the Cron proposes from now on. */
  async recordExpiredAuthorisations(db: Queryable, batch: number)
    : Promise<{ id: string; organisationId: string; automationId: string; authorisedBy: string }[]> {
    const { rows } = await db.query(
      `update automation.automation_authorisations set expiry_recorded_at = now() where id in (
         select id from automation.automation_authorisations
          where mode = 'execute' and expires_at <= now() and revoked_at is null and expiry_recorded_at is null limit $1 for update skip locked)
       returning id, organisation_id as "organisationId", automation_id as "automationId", authorised_by as "authorisedBy"`, [batch]);
    return rows as { id: string; organisationId: string; automationId: string; authorisedBy: string }[];
  },

  /** App shares past their expiry, ended at it (spec 35.x, as view shares). */
  async expireAppShares(db: Queryable, batch: number): Promise<{ id: string; organisationId: string; appId: string }[]> {
    const { rows } = await db.query(
      `update workspace.app_shares set revoked_at = expires_at where id in (
         select id from workspace.app_shares where revoked_at is null and expires_at is not null and expires_at <= now()
          limit $1 for update skip locked)
       returning id, organisation_id as "organisationId", app_id as "appId"`, [batch]);
    return rows as { id: string; organisationId: string; appId: string }[];
  },
};
