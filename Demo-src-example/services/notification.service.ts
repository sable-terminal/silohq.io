import { withTransaction } from '../infra/db.infra';
import { runWithTenant } from '../utils/tenantContext.util';
import { generateId } from '../utils/tokens.util';
import { notFound } from '../utils/error.util';
import * as notificationRepo from '../repos/notification.repo';
import type { Actor } from './scope.service';
import type { Executor } from '../infra/db.infra';

/**
 * Something happened that you did not do.
 *
 * ── ADDRESSED, NEVER BROADCAST ────────────────────────────────────────────
 *
 * Every notification names one membership. Where an event concerns everybody —
 * a system halting — the place for it is Home, which says so to whoever opens
 * it, rather than a row per member written at the moment of the failure.
 *
 * ── AND NEVER TO THE PERSON WHO DID IT ────────────────────────────────────
 *
 * Telling somebody what they have just done is noise, and noise is how a bell
 * gets ignored. `tell` drops a notification addressed to whoever caused it.
 *
 * ── WRITTEN IN THE CALLER'S TRANSACTION ───────────────────────────────────
 *
 * `tell` takes the database handle the act is already using, so a notification
 * about something that did not commit does not exist. A bell that rings for a
 * change that rolled back is worse than a bell that stays quiet.
 */

export type Kind = notificationRepo.NotificationKind;

export async function tell(
  db: Executor,
  input: {
    organisationId: string;
    /** Who is being told. */
    membershipId: string;
    /** Who did it, where somebody did: they are not told about their own act. */
    byMembershipId?: string | null;
    kind: Kind;
    title: string;
    body?: string | null;
    href: string;
  },
): Promise<void> {
  if (input.byMembershipId && input.byMembershipId === input.membershipId) return;

  await notificationRepo.create(db, {
    id: generateId(),
    organisationId: input.organisationId,
    membershipId: input.membershipId,
    kind: input.kind,
    title: input.title.slice(0, 200),
    body: input.body ? input.body.slice(0, 500) : null,
    href: input.href.slice(0, 512),
  });
}

export async function mine(
  actor: Actor,
): Promise<{ notifications: notificationRepo.Notification[]; unread: number }> {
  return runWithTenant({ organisationId: actor.organisationId, membershipId: actor.membershipId }, () =>
    withTransaction(async (db) => ({
      notifications: await notificationRepo.listFor(db, actor.membershipId),
      unread: await notificationRepo.unreadCount(db, actor.membershipId),
    })),
  );
}

/** Reading one marks it. A second read does not move the time it was first read. */
export async function markRead(actor: Actor, id: string): Promise<{ read: boolean }> {
  return runWithTenant({ organisationId: actor.organisationId, membershipId: actor.membershipId }, () =>
    withTransaction(async (db) => {
      const marked = await notificationRepo.markRead(db, { id, membershipId: actor.membershipId });
      if (!marked) throw notFound({ message: 'That notification is not there.', code: 'missing.notification' });
      return { read: true };
    }),
  );
}

export async function markAllRead(actor: Actor): Promise<{ read: number }> {
  return runWithTenant({ organisationId: actor.organisationId, membershipId: actor.membershipId }, () =>
    withTransaction(async (db) => ({ read: await notificationRepo.markAllRead(db, actor.membershipId) })),
  );
}
