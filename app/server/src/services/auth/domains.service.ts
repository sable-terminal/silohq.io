// An organisation's email domains (decision 2026-11-14; D79). Adding one gives a token to
// publish as a TXT record at _silo-verification.<domain>; verifying looks it up there now.
// A verified domain is claimed: one organisation per domain in the cell, and sign-up refuses
// a new organisation for an address at it. Removing a domain ends its claim.

import type { HandlerContext } from '../../infra/http.infra.ts';
import { inTransaction } from '../../infra/postgres.infra.ts';
import type { OrganisationDomain } from '../../models/iam/organisationDomain.model.ts';
import { organisationDomainRepo } from '../../repos/iam/index.repo.ts';
import { authorise } from '../../contracts/policy/decision.contract.ts';
import { base64url, randomBytes } from '../../utils/crypto.util.ts';
import { AppError, fromDatabaseError, isAppError } from '../../utils/errors.util.ts';
import { uuidv7 } from '../../utils/id.util.ts';
import { recordAuthEvent } from './authEvents.service.ts';
import type { AuthDeps } from './deps.service.ts';

export const TXT_PREFIX = '_silo-verification';

const view = (d: OrganisationDomain) => ({
  id: d.id, domain: d.domain, status: d.status as 'pending' | 'verified', txtName: `${TXT_PREFIX}.${d.domain}`,
  txtValue: `silo-verification=${d.verificationToken}`, createdAt: d.createdAt, verifiedAt: d.verifiedAt,
});

/** The domain of an address, lower case. */
export const domainOf = (email: string): string => email.slice(email.lastIndexOf('@') + 1).trim().toLowerCase();

async function demand(deps: AuthDeps, ctx: HandlerContext): Promise<string> {
  const decision = await deps.services.call(authorise, { body: { permission: 'org.sso.manage' } }, { request: ctx.request, correlationId: ctx.correlationId });
  if (decision.decision !== 'allow' || ctx.request.membershipId === undefined) {
    throw new AppError('forbidden', 'you may not manage the organisation\'s domains', { code: 'auth.not_permitted' });
  }
  return ctx.request.membershipId;
}

async function load(deps: AuthDeps, ctx: HandlerContext, domainId: string): Promise<OrganisationDomain> {
  const domain = await inTransaction(deps.databases.pool('control'), ctx.request, (db) => organisationDomainRepo.findById(db, domainId), { readOnly: true });
  if (!domain || domain.status === 'removed') throw new AppError('not_found', 'no such domain', { code: 'domain.not_found' });
  return domain;
}

export async function listDomains(deps: AuthDeps, ctx: HandlerContext) {
  await demand(deps, ctx);
  const rows = await inTransaction(deps.databases.pool('control'), ctx.request, (db) => organisationDomainRepo.listLive(db), { readOnly: true });
  return { domains: rows.map(view) };
}

export async function addDomain(deps: AuthDeps, ctx: HandlerContext, input: { domain: string }) {
  const membershipId = await demand(deps, ctx);
  const organisationId = ctx.request.organisationId!;
  return inTransaction(deps.databases.pool('control'), ctx.request, async (db) => {
    const existing = (await organisationDomainRepo.listLive(db)).find((d) => d.domain === input.domain);
    if (existing) return view(existing);
    const row = await organisationDomainRepo.insert(db, {
      id: uuidv7(), organisationId, domain: input.domain, verificationToken: base64url(randomBytes(24)), createdBy: membershipId,
    });
    await recordAuthEvent(db, { organisationId, correlationId: ctx.correlationId, event: 'domain_added', membershipId, detail: { domain_id: row.id } });
    return view(row);
  });
}

export async function verifyDomain(deps: AuthDeps, ctx: HandlerContext, domainId: string) {
  const membershipId = await demand(deps, ctx);
  const organisationId = ctx.request.organisationId!;
  const domain = await load(deps, ctx, domainId);
  if (domain.status === 'verified') return view(domain);
  const expected = `silo-verification=${domain.verificationToken}`;
  const records = await deps.dns.txt(`${TXT_PREFIX}.${domain.domain}`);
  if (!records.some((r) => r.trim() === expected)) {
    throw new AppError('conflict', `no TXT record at ${TXT_PREFIX}.${domain.domain} carries the value yet; DNS changes can take a while`, {
      code: 'domain.not_verified',
    });
  }
  try {
    return await inTransaction(deps.databases.pool('control'), ctx.request, async (db) => {
      if (await organisationDomainRepo.markVerified(db, domainId)) {
        await recordAuthEvent(db, { organisationId, correlationId: ctx.correlationId, event: 'domain_verified', membershipId, detail: { domain_id: domainId } });
      }
      return view((await organisationDomainRepo.findById(db, domainId))!);
    });
  } catch (error) {
    const mapped = isAppError(error) ? error : fromDatabaseError(error);
    if (mapped.category === 'conflict') {
      throw new AppError('conflict', 'another organisation on this cell has claimed that domain', { code: 'domain.claimed_elsewhere' });
    }
    throw error;
  }
}

export async function removeDomain(deps: AuthDeps, ctx: HandlerContext, domainId: string): Promise<void> {
  const membershipId = await demand(deps, ctx);
  const organisationId = ctx.request.organisationId!;
  await inTransaction(deps.databases.pool('control'), ctx.request, async (db) => {
    if (await organisationDomainRepo.markRemoved(db, domainId, membershipId)) {
      await recordAuthEvent(db, { organisationId, correlationId: ctx.correlationId, event: 'domain_removed', membershipId, detail: { domain_id: domainId } });
    }
  });
}
