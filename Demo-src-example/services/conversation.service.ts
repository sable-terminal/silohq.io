import { withTransaction } from '../infra/db.infra';
import { runWithTenant } from '../utils/tenantContext.util';
import { generateId } from '../utils/tokens.util';
import { bounds, denial, notFound } from '../utils/error.util';
import { assertCan, authorityOf } from './authorisation.service';
import * as conversationRepo from '../repos/conversation.repo';
import { MAX_CONVERSATIONS_PER_MEMBER } from '../config/constants.config';
import type { Actor } from './scope.service';
import type { PoolClient } from 'pg';

/**
 * PRODUCT §2.2 — the thread, kept.
 *
 * ── THE WORDS, NEVER THE ANSWER ───────────────────────────────────────────
 *
 * §7's rule for a saved view is that the question is stored and the answer
 * never is, because the data is read fresh every time. A conversation is the
 * same object with more than one question in it: what comes back here is what
 * was asked and the one line that was said about it, and asking again is what
 * produces figures.
 *
 * ── AND NOT FOR EVER ──────────────────────────────────────────────────────
 *
 * Thirty days from last use, as a CHECK in migration 110 rather than a promise
 * kept by a job. Reads filter on expiry, so an unswept row is unreadable rather
 * than retained.
 *
 * ── OWNER-ONLY ───────────────────────────────────────────────────────────
 *
 * As saved views and dashboards are. Sharing a thread means sharing the
 * questions somebody asked, which is a decision with its own design.
 */

const tenantOf = (actor: Actor) => ({ organisationId: actor.organisationId, membershipId: actor.membershipId });

export type Conversation = conversationRepo.Conversation;
export type Turn = conversationRepo.Turn;

export async function mine(actor: Actor): Promise<Conversation[]> {
  return runWithTenant(tenantOf(actor), () =>
    withTransaction((db) => conversationRepo.listOwnedBy(db, actor.membershipId)),
  );
}

/** `query.run`, as saving a view is: keeping your own questions adds nothing you could not already do. */
export async function create(
  actor: Actor,
  input: { title: string; asked?: string },
): Promise<Conversation & { turns: number }> {
  return runWithTenant(tenantOf(actor), () =>
    withTransaction(async (db) => {
      const authority = await authorityOf(db, actor.membershipId, actor.organisationId);
      assertCan(authority, 'query.run');

      if ((await conversationRepo.countOwnedBy(db, actor.membershipId)) >= MAX_CONVERSATIONS_PER_MEMBER) {
        throw bounds({
          message: `You are keeping ${MAX_CONVERSATIONS_PER_MEMBER} conversations, which is the most one person can. Delete one to start another.`,
          code: 'bounds.conversations',
        });
      }

      const id = generateId();
      await conversationRepo.create(db, {
        id,
        organisationId: actor.organisationId,
        ownerMembershipId: actor.membershipId,
        title: input.title,
      });
      return (await conversationRepo.read(db, id))!;
    }),
  );
}

export async function open(actor: Actor, id: string): Promise<Conversation & { exchanges: Turn[] }> {
  return runWithTenant(tenantOf(actor), () =>
    withTransaction(async (db) => {
      const conversation = await mustOwn(db, actor, id);
      return { ...conversation, exchanges: await conversationRepo.turns(db, id) };
    }),
  );
}

export async function rename(actor: Actor, id: string, title: string): Promise<Conversation> {
  return runWithTenant(tenantOf(actor), () =>
    withTransaction(async (db) => {
      await mustOwn(db, actor, id);
      await conversationRepo.rename(db, { id, title });
      return (await conversationRepo.read(db, id))!;
    }),
  );
}

export async function remove(actor: Actor, id: string): Promise<{ removed: boolean }> {
  return runWithTenant(tenantOf(actor), () =>
    withTransaction(async (db) => {
      await mustOwn(db, actor, id);
      return { removed: await conversationRepo.remove(db, id) };
    }),
  );
}

/**
 * Append what was just asked and what came back.
 *
 * THE CLIENT SENDS THE LINE RATHER THAN THE SERVER KEEPING IT. The answer was
 * composed for that one asking and is not held anywhere — writing it here from
 * the compiler would mean keeping every answer on the chance somebody later
 * wanted the thread.
 */
export async function addTurn(
  actor: Actor,
  id: string,
  input: { asked: string; said: string; kind: conversationRepo.TurnKind },
): Promise<Turn> {
  return runWithTenant(tenantOf(actor), () =>
    withTransaction(async (db) => {
      await mustOwn(db, actor, id);
      return conversationRepo.addTurn(db, {
        id: generateId(),
        organisationId: actor.organisationId,
        conversationId: id,
        asked: input.asked,
        said: input.said,
        kind: input.kind,
      });
    }),
  );
}

/** Refused as a denial inside one organisation, as views and dashboards are. */
async function mustOwn(db: PoolClient, actor: Actor, id: string): Promise<Conversation> {
  const conversation = await conversationRepo.read(db, id);
  if (!conversation) {
    throw notFound({ message: 'That conversation does not exist, or it has expired.', code: 'missing.conversation' });
  }
  if (conversation.ownerMembershipId !== actor.membershipId) {
    throw denial({ message: 'That conversation belongs to somebody else.', code: 'denial.conversation_not_owned' });
  }
  return conversation;
}
