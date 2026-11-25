import { randomBytes } from 'node:crypto';
import { withTransaction, withoutTenant } from '../infra/db.infra';
import { runUntenanted, runWithTenant } from '../utils/tenantContext.util';
import { hashToken } from '../utils/hash.util';
import { bounds, invalid, notFound, refusal } from '../utils/error.util';
import { childLogger } from '../config/logger.config';
import { env } from '../config/env.config';
import { recordFromEmail, recordsFromWebhook } from '../engine/read/inbound.read';
import { acceptsEvents, isInboundTransport, type IntakeTarget } from '../models/inbound.model';
import * as inboundRepo from '../repos/inbound.repo';
import * as connectorService from './connector.service';
import type { Actor } from './scope.service';

const log = childLogger('inbound');

/**
 * Where a webhook and a forwarded email arrive.
 *
 * THE ADDRESS IS THE CREDENTIAL. Both endpoints are reached by a system that
 * cannot hold a session — a customer's ERP posting a webhook, a mail provider
 * relaying a forward — so what authenticates them is that the URL is
 * unguessable. It is random, and stored only as a hash, for the same reasons a
 * session token is.
 *
 * NOTHING HERE IS TENANTED ON THE WAY IN. The request arrives with no session
 * and no organisation; the token is what says which connection it belongs to,
 * and everything after that runs inside that organisation's tenant context.
 */

const MAX_PAYLOAD_BYTES = 1024 * 1024;

/* ── Minting an address ─────────────────────────────────────────────────── */

export async function mintIntake(
  actor: Actor,
  connectionId: string,
  retentionHours?: number,
): Promise<{ url: string; retentionHours: number }> {
  const connection = await connectorService.readableConnection(actor, connectionId);

  const kind = connection.manifest.transport.kind;
  if (!isInboundTransport(kind)) {
    throw refusal({
      message: 'This connector does not receive anything. Only webhook and email connectors do.',
      code: 'refusal.not_an_inbound_connector',
    });
  }

  /*
   * NO ADDRESS WHERE NOTHING DELIVERS. A deployment without inbound mail
   * configured would otherwise hand somebody an address that silently receives
   * nothing, which looks exactly like a working one until they wonder why no
   * data has arrived.
   */
  if (kind === 'email_fallback' && !env.INBOUND_EMAIL_DOMAIN) {
    throw refusal({
      message: 'Inbound email is not configured for this deployment.',
      code: 'refusal.inbound_email_unavailable',
    });
  }

  const token = randomBytes(24).toString('base64url');

  return runWithTenant(
    { organisationId: actor.organisationId, membershipId: actor.membershipId },
    () =>
      withTransaction(async (db) => {
        /*
         * MINTING REPLACES. There is one address per connection, and issuing a
         * new one must invalidate the old — otherwise "rotate this because it
         * leaked" leaves the leaked one working.
         */
        const retained = await inboundRepo.mintAddress(db, {
          connectionId,
          tokenHash: hashToken(token),
          retentionHours: retentionHours ?? null,
        });

        return {
          url:
            kind === 'email_fallback'
              ? `in-${token}@${env.INBOUND_EMAIL_DOMAIN}`
              : `${env.API_URL}/api/connections/inbound/${token}`,
          retentionHours: retained,
        };
      }),
  );
}

/* ── Receiving ──────────────────────────────────────────────────────────── */

/**
 * Which connection a token belongs to.
 *
 * UNTENANTED, AND NARROW BY CONSTRUCTION. This runs before any organisation is
 * known — the token is what identifies one — so it reads across tenants and does
 * exactly one thing with what it finds. Looked up BY HASH, so the table never
 * holds a value that would let somebody post as this connection.
 */
async function targetFor(token: string): Promise<IntakeTarget> {
  const found = await runUntenanted('login-lookup', async () =>
    withoutTenant(async (db) => inboundRepo.findByIntakeTokenHash(db, hashToken(token))),
  );

  if (!found) {
    /*
     * THE SAME ANSWER FOR A WRONG TOKEN AS FOR A REVOKED ONE. Anything more
     * specific tells whoever is guessing whether they are close.
     */
    throw notFound({ message: 'Unknown address.', code: 'missing.intake' });
  }

  return found;
}

export async function receiveWebhook(input: {
  token: string;
  body: Record<string, unknown>;
  objectName?: string;
  sourceLabel?: string;
}): Promise<{ accepted: boolean; object: string }> {
  const target = await targetFor(input.token);

  if (target.manifest.transport.kind !== 'inbound_webhook') {
    throw notFound({ message: 'Unknown address.', code: 'missing.intake' });
  }

  const size = Buffer.byteLength(JSON.stringify(input.body), 'utf8');
  if (size > MAX_PAYLOAD_BYTES) {
    throw bounds({
      message: 'That payload is larger than Silo will accept from a webhook.',
      code: 'bounds.payload',
    });
  }

  /*
   * A HALTED CONNECTION STOPS ACCEPTING. Self-heal halts when a field changed
   * meaning, and continuing to store events against a manifest known to be wrong
   * would fill the window with records that will be read incorrectly.
   */
  if (!acceptsEvents(target.status)) {
    throw refusal({
      message: 'This connection is not accepting events.',
      code: 'refusal.connection_halted',
    });
  }

  const object =
    target.manifest.objects.find((o) => o.name === input.objectName) ?? target.manifest.objects[0];

  if (!object) {
    throw invalid({
      message: 'This connector does not describe anything to receive.',
      code: 'invalid.no_objects',
    });
  }

  /* One event may carry several records — a batch webhook — and each is stored as its own. */
  for (const record of await recordsFromWebhook(object, input.body)) {
    await store(target, object.name, record, input.sourceLabel);
  }

  return { accepted: true, object: object.name };
}

export async function receiveEmail(input: {
  token: string;
  from: string;
  subject: string;
  body: string;
}): Promise<{ accepted: boolean; object: string }> {
  const target = await targetFor(input.token);

  if (target.manifest.transport.kind !== 'email_fallback') {
    throw notFound({ message: 'Unknown address.', code: 'missing.intake' });
  }
  if (!acceptsEvents(target.status)) {
    throw refusal({
      message: 'This connection is not accepting events.',
      code: 'refusal.connection_halted',
    });
  }

  const object = target.manifest.objects[0];
  if (!object) {
    throw invalid({
      message: 'This connector does not describe anything to receive.',
      code: 'invalid.no_objects',
    });
  }

  const record = recordFromEmail(object, {
    from: input.from,
    subject: input.subject,
    body: input.body.slice(0, MAX_PAYLOAD_BYTES),
    receivedAt: new Date(),
  });

  await store(target, object.name, record, input.from);

  return { accepted: true, object: object.name };
}

async function store(
  target: IntakeTarget,
  objectName: string,
  payload: Record<string, unknown>,
  sourceLabel?: string,
): Promise<void> {
  await runWithTenant(
    { organisationId: target.organisationId, membershipId: null },
    () =>
      withTransaction(async (db) => {
        await inboundRepo.recordEvent(db, {
          organisationId: target.organisationId,
          connectionId: target.connectionId,
          objectName,
          payload,
          sourceLabel: sourceLabel ?? null,
          retentionHours: target.retentionHours,
        });

        await inboundRepo.noteSeen(db, target.connectionId);
      }),
  );

  log.info(
    { connectionId: target.connectionId, object: objectName, retentionHours: target.retentionHours },
    'Stored an inbound event',
  );
}

/* ── Sweeping ───────────────────────────────────────────────────────────── */

/**
 * Reclaim what has expired, for the organisation asking.
 *
 * IT IS NOT WHAT ENFORCES RETENTION. Reads already exclude expired rows, so an
 * unswept row is unreadable rather than retained — this reclaims space, and a
 * sweep that fails to run is a storage problem rather than a broken promise.
 * Driven from outside the process, like the weekly re-check: Cloud Run scales to
 * zero and an in-process interval fires only if an instance happens to be alive.
 *
 * TENANTED, BECAUSE THE CALLER IS A MEMBER AND NOT THE PLATFORM. It used to run
 * untenanted through `sweep_inbound_events()`, which deletes across every
 * organisation on the cell and returns one total — so a member of one
 * organisation got back a count of everybody's expired webhook and email events,
 * and could difference two calls into an activity signal for other customers.
 * There is no cross-tenant caller on this server: every route below `requireAuth`
 * acts inside one organisation, so this one does too. A cell-wide sweep would be
 * an operator's job against the function directly, not an endpoint a member can
 * press.
 */
export async function sweep(actor: Actor): Promise<{ removed: number }> {
  const removed = await runWithTenant(
    { organisationId: actor.organisationId, membershipId: actor.membershipId },
    () => withTransaction(async (db) => inboundRepo.sweepExpired(db)),
  );

  if (removed > 0) {
    log.info({ organisationId: actor.organisationId, removed }, 'Swept expired inbound events');
  }
  return { removed };
}
