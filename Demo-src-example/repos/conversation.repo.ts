import type { Executor } from '../infra/db.infra';
import { CONVERSATION_DAYS } from '../config/constants.config';

/**
 * A conversation and its turns — see migration 110.
 *
 * EVERY READ FILTERS ON EXPIRY. An unswept row is unreadable rather than
 * retained: the sweep is housekeeping, not the guarantee.
 */

export type TurnKind = 'answered' | 'refused' | 'ambiguous' | 'change' | 'view';

export interface Conversation {
  id: string;
  ownerMembershipId: string;
  title: string;
  turns: number;
  createdAt: Date;
  updatedAt: Date;
  expiresAt: Date;
}

export interface Turn {
  id: string;
  position: number;
  asked: string;
  said: string;
  kind: TurnKind;
  createdAt: Date;
}

type ConversationRow = {
  id: string;
  owner_membership_id: string;
  title: string;
  turns: string | number;
  created_at: Date;
  updated_at: Date;
  expires_at: Date;
};

type TurnRow = { id: string; position: number; asked: string; said: string; kind: TurnKind; created_at: Date };

const COLUMNS = `c.id, c.owner_membership_id, c.title, c.created_at, c.updated_at, c.expires_at,
  (SELECT count(*) FROM conversation_turns t WHERE t.conversation_id = c.id) AS turns`;

/*
 * THE EXPIRY IS COMPUTED BY THE DATABASE, NOT BY THIS PROCESS. `now()` inside a
 * transaction is the transaction's START, and a date worked out in JavaScript
 * after a few queries have run is later than that — which lands the other side
 * of `updated_at + 30 days` and is refused by the CHECK. It is also the honest
 * thing: the clock that enforces the bound should be the clock that sets it.
 */
const EXPIRES = `now() + make_interval(days => ${CONVERSATION_DAYS})`;

const map = (row: ConversationRow): Conversation => ({
  id: row.id,
  ownerMembershipId: row.owner_membership_id,
  title: row.title,
  turns: Number(row.turns),
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  expiresAt: row.expires_at,
});

export async function listOwnedBy(db: Executor, membershipId: string): Promise<Conversation[]> {
  const { rows } = await db.query<ConversationRow>(
    `SELECT ${COLUMNS} FROM conversations c
      WHERE c.owner_membership_id = $1 AND c.expires_at > now()
      ORDER BY c.updated_at DESC`,
    [membershipId],
  );
  return rows.map(map);
}

export async function read(db: Executor, id: string): Promise<Conversation | null> {
  const { rows } = await db.query<ConversationRow>(
    `SELECT ${COLUMNS} FROM conversations c WHERE c.id = $1 AND c.expires_at > now()`,
    [id],
  );
  return rows[0] ? map(rows[0]) : null;
}

export async function create(
  db: Executor,
  input: { id: string; organisationId: string; ownerMembershipId: string; title: string },
): Promise<void> {
  await db.query(
    `INSERT INTO conversations (id, organisation_id, owner_membership_id, title, expires_at)
     VALUES ($1, $2, $3, $4, ${EXPIRES})`,
    [input.id, input.organisationId, input.ownerMembershipId, input.title],
  );
}

export async function rename(db: Executor, input: { id: string; title: string }): Promise<void> {
  await db.query(`UPDATE conversations SET title = $2, updated_at = now(), expires_at = ${EXPIRES} WHERE id = $1`, [
    input.id,
    input.title,
  ]);
}

export async function remove(db: Executor, id: string): Promise<boolean> {
  const { rowCount } = await db.query(`DELETE FROM conversations WHERE id = $1`, [id]);
  return (rowCount ?? 0) > 0;
}

/** Using a conversation moves its expiry along; abandoning one lets it go. */
export async function touch(db: Executor, id: string): Promise<void> {
  await db.query(`UPDATE conversations SET updated_at = now(), expires_at = ${EXPIRES} WHERE id = $1`, [id]);
}

export async function turns(db: Executor, conversationId: string): Promise<Turn[]> {
  const { rows } = await db.query<TurnRow>(
    `SELECT t.id, t.position, t.asked, t.said, t.kind, t.created_at
       FROM conversation_turns t
       JOIN conversations c ON c.id = t.conversation_id
      WHERE t.conversation_id = $1 AND c.expires_at > now()
      ORDER BY t.position`,
    [conversationId],
  );
  return rows.map((row) => ({
    id: row.id,
    position: row.position,
    asked: row.asked,
    said: row.said,
    kind: row.kind,
    createdAt: row.created_at,
  }));
}

export async function addTurn(
  db: Executor,
  input: {
    id: string;
    organisationId: string;
    conversationId: string;
    asked: string;
    said: string;
    kind: TurnKind;
  },
): Promise<Turn> {
  const { rows } = await db.query<TurnRow>(
    `INSERT INTO conversation_turns (id, organisation_id, conversation_id, position, asked, said, kind)
     VALUES ($1, $2, $3,
             (SELECT coalesce(max(position) + 1, 0) FROM conversation_turns WHERE conversation_id = $3),
             $4, $5, $6)
     RETURNING id, position, asked, said, kind, created_at`,
    [input.id, input.organisationId, input.conversationId, input.asked, input.said, input.kind],
  );
  await touch(db, input.conversationId);
  const row = rows[0]!;
  return {
    id: row.id,
    position: row.position,
    asked: row.asked,
    said: row.said,
    kind: row.kind,
    createdAt: row.created_at,
  };
}

/** Housekeeping for what the CHECK already made unreadable. Turns cascade with it. */
export async function discardExpired(db: Executor): Promise<Array<{ id: string; organisationId: string }>> {
  const { rows } = await db.query<{ id: string; organisation_id: string }>(
    `DELETE FROM conversations WHERE expires_at <= now() RETURNING id, organisation_id`,
  );
  return rows.map((row) => ({ id: row.id, organisationId: row.organisation_id }));
}

export async function countOwnedBy(db: Executor, membershipId: string): Promise<number> {
  const { rows } = await db.query<{ count: string }>(
    `SELECT count(*) FROM conversations WHERE owner_membership_id = $1 AND expires_at > now()`,
    [membershipId],
  );
  return Number(rows[0]?.count ?? 0);
}
