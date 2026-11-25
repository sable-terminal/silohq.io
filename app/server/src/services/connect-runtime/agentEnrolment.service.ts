// Enrolling a Silo Agent (spec 10.2), at agent.<cell>: "The agent generates its key pair
// locally; the private key never leaves the host. It sends a signing request and the token
// ... The cell's agent certificate authority issues a client certificate bound to the
// agent's service principal (kind = agent, fingerprint recorded). The token is consumed;
// thereafter the agent authenticates by mTLS only."
//
// One transaction: the token is consumed (single use, unexpired, unrevoked; the database's
// connect.resolve_enrolment_token), which names the organisation, then the certificate is
// issued and the service principal and the agent recorded. A request the CA refuses rolls
// it all back, so a mistyped request does not spend the token. The agent starts offline; the
// tunnel marks it healthy.

import type { KeyObject } from 'node:crypto';
import type { AgentEnrolRequest, AgentEnrolResponse } from '../../contracts/connect-runtime/agentEndpoint.contract.ts';
import type { Logger } from '../../infra/logger.infra.ts';
import { inTransaction, type Databases } from '../../infra/postgres.infra.ts';
import { agentEnrolmentTokenRepo, agentPoolRepo, agentRepo } from '../../repos/connect/index.repo.ts';
import { servicePrincipalRepo } from '../../repos/iam/index.repo.ts';
import { AppError } from '../../utils/errors.util.ts';
import { uuidv7 } from '../../utils/id.util.ts';
import { hashToken, tokenKind } from '../../utils/token.util.ts';
import { recordConnectEvent } from '../connect-registry/connectEvents.service.ts';
import type { AgentCa } from './agentCa.service.ts';
import type { AgentTunnels } from './agentTunnels.service.ts';

export interface EnrolmentDeps {
  databases: Databases;
  ca: AgentCa;
  logger: Logger;
  now?: () => number;
  /** The key execution grants are checked against, which every agent pins (spec 10.4). */
  grantKey?: KeyObject | undefined;
  /** The key discovery scans are signed with; none in the sovereign build, which has no discovery. */
  discoveryKey?: KeyObject | undefined;
}

/** The keys the agent checks the cell's instructions against: execution grants (10.4) and discovery scans (10.5). */
const grantKeyOf = (deps: EnrolmentDeps): { grantKey?: string; discoveryKey?: string } => ({
  ...(deps.grantKey === undefined ? {} : { grantKey: deps.grantKey.export({ type: 'spki', format: 'pem' }).toString() }),
  ...(deps.discoveryKey === undefined ? {} : { discoveryKey: deps.discoveryKey.export({ type: 'spki', format: 'pem' }).toString() }),
});

const refused = (): AppError =>
  new AppError('unauthenticated', 'the enrolment token is unknown, used, revoked or expired: issue a new one', { code: 'agent.enrolment_token_invalid' });

/**
 * Renewing an agent's certificate (spec 10.7: "Valid 30 days, renewed at 20 with a new local key
 * pair"), asked over mutual TLS with the certificate it replaces. The agent and its service
 * principal take the new fingerprint in one transaction, but only while the old one is still
 * theirs, so two renewals racing cannot both win. The agent's live tunnel follows the new
 * fingerprint until it reconnects with the new certificate; the old certificate opens nothing
 * from then on.
 */
export async function renewAgent(deps: EnrolmentDeps & { tunnels?: AgentTunnels }, fingerprint: Buffer, csr: string, correlationId: string,
  sealingKey?: string) : Promise<AgentEnrolResponse> {
  const control = deps.databases.pool('control');
  const found = await inTransaction(control, {}, (db) => agentRepo.resolve(db, fingerprint), { readOnly: true });
  if (found === undefined) throw new AppError('unauthenticated', 'no agent holds this certificate', { code: 'agent.unknown' });
  if (found.status === 'revoked') throw new AppError('forbidden', 'the agent is revoked', { code: 'agent.revoked' });
  const issued = await deps.ca.issue(csr, { agentId: found.id, organisationId: found.organisationId }, new Date((deps.now ?? Date.now)()));
  // A heartbeat checked while the new fingerprint is committed must not take the tunnel for replaced.
  const renewal = deps.tunnels?.renewing(found.id);
  let renewed = false;
  try {
    await inTransaction(control, { organisationId: found.organisationId }, async (db) => {
      const agent = await agentRepo.findById(db, found.id);
      if (agent === undefined || !agent.certificateFingerprint.equals(fingerprint)) {
        throw new AppError('conflict', 'the certificate was renewed already: use the new one', { code: 'agent.renewed_already' });
      }
      await agentRepo.update(db, agent.id, {
        certificateFingerprint: issued.fingerprint, certificateSerial: issued.serial,
        certificateIssuedAt: issued.notBefore.toISOString(), certificateExpiresAt: issued.notAfter.toISOString(),
        // A new sealing key with the new certificate (spec 10.7: renewed with a new local key pair).
        ...(sealingKey === undefined ? {} : { sealingKey: Buffer.from(sealingKey, 'base64') }),
      });
      await servicePrincipalRepo.update(db, agent.servicePrincipalId, { certificateFingerprint: issued.fingerprint });
      await recordConnectEvent(db, {
        organisationId: found.organisationId, correlationId, event: 'agent_certificate_renewed', servicePrincipalId: agent.servicePrincipalId,
        resourceType: 'agent', resourceId: agent.id, detail: { expires_at: issued.notAfter.toISOString() },
      });
    });
    renewed = true;
  } finally {
    renewal?.done(renewed ? issued.fingerprint : undefined);
  }
  deps.logger.info('agent certificate renewed', { event: 'agent.certificate_renewed', organisationId: found.organisationId, resourceId: found.id });
  return { agentId: found.id, organisationId: found.organisationId, poolId: found.poolId, certificate: issued.certificatePem,
    caCertificate: deps.ca.certificatePem, expiresAt: issued.notAfter.toISOString(), ...grantKeyOf(deps) };
}

export async function enrolAgent(deps: EnrolmentDeps, input: AgentEnrolRequest, correlationId: string): Promise<AgentEnrolResponse> {
  if (tokenKind(input.token) !== 'agent_enrolment') throw refused();
  const agentId = uuidv7();
  const at = new Date((deps.now ?? Date.now)());
  const enrolled = await inTransaction(deps.databases.pool('control'), {}, async (db) => {
    const token = await agentEnrolmentTokenRepo.consume(db, hashToken(input.token), agentId);
    if (token === undefined) throw refused();
    const pool = await agentPoolRepo.findById(db, token.poolId);
    if (pool === undefined || pool.status !== 'active') throw new AppError('conflict', 'the pool is retired: it takes no agents', { code: 'agent.pool_retired' });
    const issued = await deps.ca.issue(input.csr, { agentId, organisationId: token.organisationId }, at);
    const principal = await servicePrincipalRepo.insert(db, {
      id: uuidv7(), organisationId: token.organisationId, kind: 'agent', name: `Silo Agent ${input.name}`, certificateFingerprint: issued.fingerprint,
      scopeId: null, ownerMembershipId: token.createdBy, createdBy: token.createdBy,
    });
    await agentRepo.insert(db, {
      id: agentId, organisationId: token.organisationId, poolId: token.poolId, name: input.name, servicePrincipalId: principal.id,
      certificateFingerprint: issued.fingerprint, certificateSerial: issued.serial, certificateIssuedAt: issued.notBefore.toISOString(),
      certificateExpiresAt: issued.notAfter.toISOString(), version: input.version, platform: input.platform, hostname: input.hostname,
      ...(input.sealingKey === undefined ? {} : { sealingKey: Buffer.from(input.sealingKey, 'base64') }),
      status: 'offline', enrolledBy: token.createdBy,
    });
    await recordConnectEvent(db, {
      organisationId: token.organisationId, correlationId, event: 'agent_enrolled', servicePrincipalId: principal.id,
      resourceType: 'agent', resourceId: agentId, detail: { pool_id: token.poolId, platform: input.platform, version: input.version },
    });
    return { agentId, organisationId: token.organisationId, poolId: token.poolId, certificate: issued.certificatePem, caCertificate: deps.ca.certificatePem,
      expiresAt: issued.notAfter.toISOString(), ...grantKeyOf(deps) };
  });
  deps.logger.info('agent enrolled', { event: 'agent.enrolled', organisationId: enrolled.organisationId, resourceType: 'agent', resourceId: agentId });
  return enrolled;
}
