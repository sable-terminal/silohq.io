// Reading the audit ledger (spec 63.5, 63.7). Decided by the policy service; deny wins.
//
// A grant of audit.read on a scope lets its holder read the events about that scope and
// the scopes beneath it: the reader names the scope, the policy service decides there, and
// only events within it are returned. Reading without a scope (the whole organisation,
// the auth events, the chain, the seals) needs the permission organisation-wide: the
// decision must allow it and the membership must hold it in a grant on no scope.
//
// Not yet: rows whose resource the reader's markings hide are to be returned with the
// resource withheld and counted (spec 63.5); markings join with the governance service.

import type { AuditEventView, AuthEventView, CredentialUnwrapView } from '../../contracts/audit/read.contract.ts';
import { authorise } from '../../contracts/policy/decision.contract.ts';
import { requireOperatorSession } from '../admin-portal/sessionCheck.service.ts';
import type { HandlerContext } from '../../infra/http.infra.ts';
import { inTransaction, type Databases } from '../../infra/postgres.infra.ts';
import type { ServiceClient } from '../../infra/serviceClient.infra.ts';
import type { AuditEvent } from '../../models/audit/auditEvent.model.ts';
import type { AuthEvent } from '../../models/audit/authEvent.model.ts';
import { auditEventRepo, authEventRepo, chainHeadRepo, partitionSealRepo } from '../../repos/audit/index.repo.ts';
import type { PartitionSeal } from '../../models/audit/partitionSeal.model.ts';
import { credentialUnwrapRepo, roleAssignmentRepo } from '../../repos/iam/index.repo.ts';
import type { CredentialUnwrap } from '../../models/iam/credentialUnwrap.model.ts';
import { auditGenesisHash, verifyAuditChain } from '../../utils/auditChain.util.ts';
import { AppError } from '../../utils/errors.util.ts';

export interface AuditReadDeps {
  databases: Databases;
  /** Calls the policy service as audit. */
  services: ServiceClient;
}

type Permission = 'audit.read' | 'audit.export';

const denied = (permission: Permission): AppError =>
  new AppError('forbidden', `${permission} is not granted here`, { code: 'audit.not_permitted', details: { permission } });

export const encodeCursor = (row: { occurredAt: string; id: string }): string =>
  Buffer.from(`${row.occurredAt}|${row.id}`, 'utf8').toString('base64url');

function decodeCursor(cursor: string | undefined): { occurredAt: string; id: string } | undefined {
  if (cursor === undefined) return undefined;
  const [occurredAt, id] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
  if (!occurredAt || !id || !/^\d+$/.test(id) || Number.isNaN(Date.parse(occurredAt))) {
    throw new AppError('validation', 'the cursor is not one this service issued', { code: 'audit.cursor_invalid' });
  }
  return { occurredAt, id };
}

export function auditEventToView(row: AuditEvent): AuditEventView {
  const { ipHash: _ip, prevHash, rowHash, ...rest } = row;
  return { ...rest, prevHash: prevHash.toString('hex'), rowHash: rowHash.toString('hex') };
}

function authEventToView(row: AuthEvent): AuthEventView {
  const { ipHash: _ip, ...rest } = row;
  return rest;
}

const sealToView = (seal: PartitionSeal) => ({ ...seal, runningHash: seal.runningHash.toString('hex') });

function unwrapToView(row: CredentialUnwrap): CredentialUnwrapView {
  const credential = row.connectionCredentialId !== null ? { kind: 'connection_credential' as const, id: row.connectionCredentialId }
    : row.identityProviderId !== null ? { kind: 'identity_provider' as const, id: row.identityProviderId } : { kind: 'mfa_factor' as const, id: row.mfaFactorId! };
  return {
    id: row.id, event: 'credential_unwrapped', occurredAt: new Date(row.occurredAt).toISOString(), credential, reason: row.reason, callingService: row.callingService,
    correlationId: row.correlationId, membershipId: row.membershipId, servicePrincipalId: row.servicePrincipalId, keyVersionId: row.keyVersionId,
    dekCacheHit: row.dekCacheHit, outcome: row.outcome,
  };
}



export function createAuditReader(deps: AuditReadDeps) {
  const control = deps.databases.pool('control');
  const contextOf = (ctx: HandlerContext) => ({
    organisationId: ctx.request.organisationId!,
    ...(ctx.request.membershipId === undefined ? {} : { membershipId: ctx.request.membershipId }),
    ...(ctx.request.operatorSessionId === undefined ? {} : { operatorSessionId: ctx.request.operatorSessionId }),
  });

  /**
   * The policy decision, then, without a scope, that the grant is organisation-wide. Silo
   * staff come through admin-portal under a running break-glass session instead (spec 13.3):
   * the audit log is references and counts, so metadata_read reads it whole.
   */
  async function decide(ctx: HandlerContext, permission: Permission, scopeId?: string): Promise<void> {
    if (ctx.caller === 'admin-portal') {
      await inTransaction(control, contextOf(ctx), (db) => requireOperatorSession(db, ctx.request, 'metadata_read'), { readOnly: true });
      return;
    }
    if (ctx.request.membershipId === undefined) throw denied(permission);
    const decision = await deps.services.call(authorise, { body: { permission, ...(scopeId ? { scopeId } : {}) } },
      { request: ctx.request, correlationId: ctx.correlationId });
    if (decision.decision !== 'allow') {
      throw new AppError('forbidden', `${permission} is not granted here`, { code: 'audit.not_permitted', details: { permission, reason: decision.reason } });
    }
    if (scopeId !== undefined) return;
    const grants = await inTransaction(control, contextOf(ctx), (db) => roleAssignmentRepo.liveGrants(db, ctx.request.membershipId!));
    if (!grants.some((g) => g.scopePath === null && g.resourceType === null && g.permissions.includes(permission))) {
      throw new AppError('forbidden', `${permission} is held on a scope: name the scope to read`, {
        code: 'audit.scope_required', details: { permission },
      });
    }
  }

  return {
    async listEvents(ctx: HandlerContext, query: {
      from?: string | undefined; to?: string | undefined; event?: string | undefined; membershipId?: string | undefined;
      scopeId?: string | undefined; resourceType?: string | undefined; resourceId?: string | undefined; cursor?: string | undefined; limit: number;
    }) {
      if ((query.resourceType === undefined) !== (query.resourceId === undefined)) {
        throw new AppError('validation', 'name a resource by its type and id together', { code: 'audit.resource_incomplete' });
      }
      await decide(ctx, 'audit.read', query.scopeId);
      const rows = await inTransaction(control, contextOf(ctx), (db) => auditEventRepo.list(db, {
        organisationId: ctx.request.organisationId!, from: query.from, to: query.to, event: query.event, membershipId: query.membershipId,
        resource: query.resourceType === undefined ? undefined : { type: query.resourceType, id: query.resourceId! },
        withinScopeId: query.scopeId, before: decodeCursor(query.cursor), limit: query.limit + 1,
      }), { readOnly: true });
      const page = rows.slice(0, query.limit);
      return { events: page.map(auditEventToView), nextCursor: rows.length > query.limit ? encodeCursor(page.at(-1)!) : null };
    },

    /** credential_unwrapped: the organisation's unwraps, for an organisation-wide holder of audit.read (spec 61.9). */
    async listCredentialUnwraps(ctx: HandlerContext, query: {
      from?: string | undefined; to?: string | undefined; reason?: string | undefined; credentialId?: string | undefined; cursor?: string | undefined; limit: number;
    }): Promise<{ unwraps: CredentialUnwrapView[]; nextCursor: string | null }> {
      await decide(ctx, 'audit.read');
      const rows = await inTransaction(control, contextOf(ctx), (db) => credentialUnwrapRepo.list(db, {
        from: query.from, to: query.to, reason: query.reason, credentialId: query.credentialId, before: decodeCursor(query.cursor), limit: query.limit + 1,
      }), { readOnly: true });
      const page = rows.slice(0, query.limit);
      return { unwraps: page.map(unwrapToView), nextCursor: rows.length > query.limit ? encodeCursor(page.at(-1)!) : null };
    },

    async listAuthEvents(ctx: HandlerContext, query: {
      from?: string | undefined; to?: string | undefined; event?: string | undefined; userId?: string | undefined;
      membershipId?: string | undefined; cursor?: string | undefined; limit: number;
    }) {
      await decide(ctx, 'audit.read');
      const rows = await inTransaction(control, contextOf(ctx), (db) => authEventRepo.list(db, {
        organisationId: ctx.request.organisationId!, from: query.from, to: query.to, event: query.event, userId: query.userId,
        membershipId: query.membershipId, before: decodeCursor(query.cursor), limit: query.limit + 1,
      }), { readOnly: true });
      const page = rows.slice(0, query.limit);
      return { events: page.map(authEventToView), nextCursor: rows.length > query.limit ? encodeCursor(page.at(-1)!) : null };
    },

    async listChainHeads(ctx: HandlerContext, query: { before?: string | undefined; limit: number }) {
      await decide(ctx, 'audit.read');
      const heads = await inTransaction(control, contextOf(ctx), (db) =>
        chainHeadRepo.list(db, ctx.request.organisationId!, query.limit, query.before), { readOnly: true });
      return { heads: heads.map((h) => ({ ...h, headHash: h.headHash.toString('hex') })) };
    },

    async readChain(ctx: HandlerContext, query: { afterChainSeq: string; limit: number }) {
      await decide(ctx, 'audit.export');
      const organisationId = ctx.request.organisationId!;
      const { anchor, rows } = await inTransaction(control, contextOf(ctx), (db) =>
        auditEventRepo.chainRun(db, organisationId, query.afterChainSeq, query.limit), { readOnly: true });
      if (query.afterChainSeq !== '0' && anchor === undefined) {
        throw new AppError('not_found', 'no event has that chain position', { code: 'audit.chain_position_unknown' });
      }
      const from = anchor
        ? { prevHash: anchor.rowHash, chainSeq: BigInt(anchor.chainSeq) }
        : { prevHash: auditGenesisHash(organisationId), chainSeq: 0n };
      const verdict = verifyAuditChain(organisationId, rows, from);
      return {
        anchor: { chainSeq: String(from.chainSeq), rowHash: from.prevHash.toString('hex') },
        events: rows.map(auditEventToView),
        verification: verdict.ok
          ? { ok: true as const, count: verdict.count, lastHash: verdict.lastHash.toString('hex') }
          : { ok: false as const, chainSeq: verdict.chainSeq, reason: verdict.reason },
      };
    },

    async listSeals(ctx: HandlerContext, query: { ledger?: PartitionSeal['ledger'] | undefined; from?: string | undefined; to?: string | undefined; limit: number }) {
      await decide(ctx, 'audit.export');
      const seals = await inTransaction(control, contextOf(ctx), (db) => partitionSealRepo.list(db, query), { readOnly: true });
      return { seals: seals.map(sealToView) };
    },
  };
}

export type AuditReader = ReturnType<typeof createAuditReader>;
