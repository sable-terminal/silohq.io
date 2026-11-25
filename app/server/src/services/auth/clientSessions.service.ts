// API client access sessions (spec 60.4, 60.5). An api_client service principal exchanges
// its secret, shown once at creation and stored as its SHA-256, for a session of at most
// CLIENT_SESSION_MINUTES that never outlives the principal. A wrong id, a wrong secret, a
// revoked or expired client and an inactive organisation are refused alike. Attempts are
// limited per client and per address. Each request then resolves the session in Postgres:
// live, unrevoked, and its principal still unrevoked and unexpired.

import { CLIENT_SESSION_MINUTES, type ClientSessionView } from '../../contracts/auth/clientSession.contract.ts';
import { inTransaction } from '../../infra/postgres.infra.ts';
import { organisationRepo, servicePrincipalRepo, sessionRepo } from '../../repos/iam/index.repo.ts';
import { constantTimeEqual } from '../../utils/crypto.util.ts';
import { AppError } from '../../utils/errors.util.ts';
import { uuidv7 } from '../../utils/id.util.ts';
import { hashToken, issueSessionToken, parseSessionToken } from '../../utils/token.util.ts';
import { recordAuthEvent } from './authEvents.service.ts';
import { refuseWhilePaused } from './sessions.service.ts';
import type { AuthDeps } from './deps.service.ts';

const refused = (): AppError => new AppError('unauthenticated', 'the client id or secret is not right, or the client is revoked or expired', {
  code: 'auth.client_invalid',
});
const invalidSession = (): AppError => new AppError('unauthenticated', 'the access token is not valid; exchange the client secret again', {
  code: 'auth.session_invalid',
});

export async function issueClientSession(deps: AuthDeps, input: {
  organisationId: string; clientId: string; clientSecret: string; client?: { address?: string | undefined; userAgent?: string | undefined } | undefined;
}, correlationId: string): Promise<{ accessToken: string; tokenType: 'Bearer'; expiresAt: string }> {
  const { security } = deps.config;
  const ipHash = deps.guard.addressHash(input.client?.address);
  const userAgentHash = deps.guard.userAgentHash(input.client?.userAgent);
  const window = security.rateLimits.windowSeconds;
  if (ipHash) await deps.guard.limit('client_session_address', ipHash, security.rateLimits.loginAttemptsPerAddress, window);
  await deps.guard.limit('client_session', input.clientId, security.rateLimits.loginAttemptsPerEmail, window);

  const control = deps.databases.pool('control');
  const now = Date.now();
  const found = await inTransaction(control, { organisationId: input.organisationId }, async (db) => ({
    organisation: await organisationRepo.findById(db, input.organisationId),
    principal: await servicePrincipalRepo.findById(db, input.clientId),
  }));
  const { organisation, principal } = found;
  const presented = hashToken(input.clientSecret);
  const matches = principal?.secretHash != null && constantTimeEqual(principal.secretHash, presented);
  if (!organisation || organisation.status !== 'active' || !principal || principal.kind !== 'api_client' || !matches
    || principal.revokedAt !== null || principal.expiresAt === null || Date.parse(principal.expiresAt) <= now) {
    throw refused();
  }
  const sessionId = uuidv7();
  const { token, hash } = issueSessionToken(input.organisationId, sessionId);
  const expiresAt = new Date(Math.min(now + CLIENT_SESSION_MINUTES * 60_000, Date.parse(principal.expiresAt))).toISOString();
  await inTransaction(control, { organisationId: input.organisationId }, async (db) => {
    await sessionRepo.insert(db, {
      id: sessionId, tokenHash: hash, userId: null, servicePrincipalId: principal.id, organisationId: input.organisationId, activeMembershipId: null,
      issuedAt: new Date(now).toISOString(), expiresAt, ipHash: ipHash ?? null, userAgentHash: userAgentHash ?? null, authMethod: 'agent',
      mfaSatisfiedAt: null,
    });
    await recordAuthEvent(db, {
      organisationId: input.organisationId, correlationId, event: 'session_issued', ipHash,
      detail: { kind: 'api_client', service_principal_id: principal.id },
    });
  });
  return { accessToken: token, tokenType: 'Bearer', expiresAt };
}

export async function resolveClientSession(deps: AuthDeps, accessToken: string, writes = false): Promise<ClientSessionView> {
  const parsed = parseSessionToken(accessToken);
  if (!parsed) throw invalidSession();
  const control = deps.databases.pool('control');
  const row = await inTransaction(control, {}, (db) => sessionRepo.resolvePrincipalByTokenHash(db, parsed.hash), { readOnly: true });
  if (!row || row.id !== parsed.sessionId || row.organisationId !== parsed.organisationId) throw invalidSession();
  const principal = await inTransaction(control, { organisationId: row.organisationId }, (db) => servicePrincipalRepo.findById(db, row.servicePrincipalId),
    { readOnly: true });
  if (!principal || principal.revokedAt !== null || (principal.expiresAt !== null && Date.parse(principal.expiresAt) <= Date.now())) throw invalidSession();
  if (writes) await refuseWhilePaused(deps.databases, row.organisationId);
  return { sessionId: row.id, organisationId: row.organisationId, servicePrincipalId: row.servicePrincipalId, expiresAt: row.expiresAt };
}
