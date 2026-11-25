import { withTransaction } from '../infra/db.infra';
import { childLogger } from '../config/logger.config';
import { log as writeAudit } from '../services/audit.service';
import type { AccessLog } from './mediator.util';
import { requireTenant } from './tenantContext.util';
import type { Actor } from '../services/scope.service';

const secretLog = childLogger('secret-access');

/**
 * The access log for connector credentials, writing to the audit trail.
 *
 * `credential_unwrapped` IS THE EVENT A SECURITY REVIEW READS FIRST — "who
 * opened this customer's Salesforce credential, when, and what for". It was
 * going to a log line, which is not an audit trail: log lines are not append
 * only, are not retained on the same terms, and are not what anybody produces
 * when asked to evidence access to a system of record.
 *
 * THE HIGHEST-VOLUME EVENT HERE, at one row per source per query, which is what
 * it should be. A trail that records only unusual access cannot show that access
 * was ordinary.
 *
 * ITS OWN TRANSACTION, BECAUSE THE CALLER USUALLY HAS NONE. A credential is
 * opened during fan-out, after the loading transaction has deliberately been
 * released — holding one open across six network calls to third parties is how a
 * pool of ten runs out under four concurrent questions.
 */
/**
 * The actor is optional because some callers genuinely do not have one to hand.
 * `accessTokenFor` is given a connection id and nothing else — it is reached
 * from a refresh as readily as from a query — and the tenant context it already
 * runs inside carries both fields the trail needs.
 */
export function credentialAccessLog(actor?: Actor): AccessLog {
  return {
    async record(entry) {
      const who = actor ?? requireTenant('credential-access-log');
      await withTransaction((db) =>
        writeAudit(db, {
          event: 'credential_unwrapped',
          organisationId: who.organisationId,
          membershipId: who.membershipId ?? null,
          userId: null,
          detail: {
            connectionId: entry.subject,
            reason: entry.reason,
            outcome: entry.outcome,
          },
          occurredAt: entry.at,
        }),
      );
    },
  };
}

/**
 * The access log for secrets that are not a customer's connector credential:
 * an MFA factor, an identity provider's client secret.
 *
 * ── WHY IT IS NOT `credentialAccessLog` ───────────────────────────────────
 *
 * `auth_events.organisation_id` is NOT NULL, and an MFA factor belongs to a
 * USER rather than to an organisation. The moment it is opened is the middle of
 * a login, before anybody has chosen which organisation they are acting in —
 * `sessions.active_membership_id` is null until exactly that step. There is no
 * organisation to write, and inventing one would put a security event in the
 * wrong tenant's trail.
 *
 * So where an organisation is known — an identity provider has one — this
 * writes the same `credential_unwrapped` row everything else writes. Where it
 * genuinely is not, it records to the structured log and says so rather than
 * silently writing nothing.
 *
 * ── THE POINT IS THE MEDIATOR, NOT THE SINK ───────────────────────────────
 *
 * §14.4 — "Single mediator for plaintext access, which hands the value to a
 * callback rather than returning it." These three call sites used to unseal
 * directly, which made that sentence false and meant a failed unwrap of an MFA
 * secret left no trace anywhere. Routing them through `withSecret` is the fix;
 * this is what it logs to.
 */
export function secretAccessLog(subjectOrganisationId: string | null): AccessLog {
  return {
    async record(entry) {
      if (subjectOrganisationId === null) {
        /* A login, before an organisation is chosen. The trail this belongs in
           does not accept a row without one. */
        secretLog.info(
          { reason: entry.reason, subject: entry.subject, outcome: entry.outcome },
          'Secret opened',
        );
        return;
      }

      await withTransaction((db) =>
        writeAudit(db, {
          event: 'credential_unwrapped',
          organisationId: subjectOrganisationId,
          membershipId: null,
          userId: null,
          detail: {
            connectionId: entry.subject,
            reason: entry.reason,
            outcome: entry.outcome,
          },
          occurredAt: entry.at,
        }),
      );
    },
  };
}
