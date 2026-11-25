// The cell's synthetic organisation (spec 11.2; contracts/auth/synthetic.contract.ts): made once,
// on the enterprise plan so no plan limit holds the tests back, in UTC, with two members whose
// addresses can never receive mail (silo.invalid) and who cannot sign in (no password, SSO only
// with no provider), each granted Super admin by the definer
// function that grants only here. Their sessions are minted complete (no factor to verify: they
// never sign in) and last SYNTHETIC_SESSION_MINUTES.

import { SYNTHETIC_SESSION_MINUTES, type SyntheticMember } from '../../contracts/auth/synthetic.contract.ts';
import { inTransaction } from '../../infra/postgres.infra.ts';
import { membershipRepo, organisationRepo, roleAssignmentRepo, userRepo } from '../../repos/iam/index.repo.ts';
import { AppError, fromDatabaseError } from '../../utils/errors.util.ts';
import { uuidv7 } from '../../utils/id.util.ts';
import { recordAuthEvent } from './authEvents.service.ts';
import type { AuthDeps } from './deps.service.ts';

const emailOf = (cellId: string, member: SyntheticMember): string => `synthetic-${member}@${cellId}.silo.invalid`;

async function find(deps: AuthDeps) {
  const control = deps.databases.pool('control');
  return inTransaction(control, {}, async (db) => {
    const organisationId = await organisationRepo.syntheticOrganisationId(db);
    if (organisationId === undefined) return undefined;
    const members: Partial<Record<SyntheticMember, { membershipId: string; userId: string }>> = {};
    for (const m of await organisationRepo.syntheticMembers(db)) {
      if (m.member === 'proposer' || m.member === 'approver') members[m.member] = { membershipId: m.membershipId, userId: m.userId };
    }
    return { organisationId, members };
  }, { readOnly: true });
}

/** One member: its user and membership, in a transaction acting as that user (row-level security on users). */
async function addMember(deps: AuthDeps, organisationId: string, member: SyntheticMember, withOrganisation?: { slug: string }): Promise<void> {
  const cellId = deps.config.cell.id;
  const userId = uuidv7();
  await inTransaction(deps.databases.pool('control'), { organisationId, userId }, async (db) => {
    if (withOrganisation !== undefined) {
      await organisationRepo.insert(db, {
        id: organisationId, name: 'Silo synthetic checks', slug: withOrganisation.slug, plan: 'enterprise', cellId, calendarTimeZone: 'Etc/UTC', isSynthetic: true,
      });
    }
    await userRepo.insert(db, {
      id: userId, firstName: 'Silo', lastName: `synthetic ${member}`, email: emailOf(cellId, member), passwordHash: null, emailVerifiedAt: new Date().toISOString(),
      // No password and no provider: no one can sign in as it.
      ssoOnly: true,
    });
    await membershipRepo.insert(db, { id: uuidv7(), userId, organisationId, status: 'active', joinedAt: new Date().toISOString() });
  });
}

export async function provisionSyntheticTenant(deps: AuthDeps, correlationId: string) {
  let found = await find(deps);
  const created = found === undefined;
  const slug = `silo-synthetic-${deps.config.cell.id}`.slice(0, 63);
  try {
    // Made in steps, each resumed if a step before was cut short: the organisation with its proposer, then its approver.
    if (found === undefined) await addMember(deps, uuidv7(), 'proposer', { slug });
    found = (await find(deps))!;
    if (found.members.proposer === undefined) await addMember(deps, found.organisationId, 'proposer');
    if (found.members.approver === undefined) await addMember(deps, found.organisationId, 'approver');
  } catch (error) {
    // Another replica made it meanwhile: the one there stands.
    const mapped = fromDatabaseError(error);
    if (mapped.category !== 'conflict') throw mapped;
  }
  found = (await find(deps))!;
  const { proposer, approver } = found.members;
  if (proposer === undefined || approver === undefined) throw new AppError('integrity', 'the synthetic organisation is missing a member', { code: 'synthetic.incomplete' });
  await inTransaction(deps.databases.pool('control'), { organisationId: found.organisationId }, async (db) => {
    await roleAssignmentRepo.grantSyntheticMembers(db, found!.organisationId, proposer.membershipId, approver.membershipId);
    if (created) {
      await recordAuthEvent(db, { organisationId: found!.organisationId, correlationId, event: 'organisation_signed_up', membershipId: proposer.membershipId, detail: { plan: 'enterprise', synthetic: true } });
    }
  });
  return { organisationId: found.organisationId, slug, members: { proposer: proposer.membershipId, approver: approver.membershipId }, created };
}

export async function issueSyntheticSession(deps: AuthDeps, member: SyntheticMember, correlationId: string) {
  const found = await find(deps);
  const membershipId = found?.members[member];
  if (found === undefined || membershipId === undefined) {
    throw new AppError('not_found', 'this cell has no synthetic organisation yet', { code: 'synthetic.not_provisioned' });
  }
  const organisation = { id: found.organisationId };
  const control = deps.databases.pool('control');
  const issued = await inTransaction(control, { organisationId: organisation.id }, async (db) => {
    const session = await deps.sessions.issue(db, {
      // Its life is one round of the tests, whatever the cell's timeouts.
      organisation: { id: organisation.id, mfaRequired: false, sessionIdleMinutes: SYNTHETIC_SESSION_MINUTES, sessionAbsoluteMinutes: SYNTHETIC_SESSION_MINUTES },
      userId: found.members[member]!.userId, membershipId: membershipId.membershipId, mfa: 'satisfied', authMethod: 'synthetic', ipHash: undefined, userAgentHash: undefined,
    });
    await recordAuthEvent(db, { organisationId: organisation.id, correlationId, event: 'session_issued', membershipId: membershipId.membershipId, detail: { kind: 'synthetic', member } });
    return session;
  });
  await issued.cache();
  return { sessionToken: issued.token, organisationId: organisation.id, membershipId: membershipId.membershipId, expiresAt: issued.view.absoluteExpiresAt };
}
