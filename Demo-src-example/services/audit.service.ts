import { withTransaction, type Executor } from '../infra/db.infra';
import { runWithTenant } from '../utils/tenantContext.util';
import { invalid } from '../utils/error.util';
import { assertCan, authorityOf } from './authorisation.service';
import type { Actor } from './scope.service';
import type { StoredEvent } from '../repos/authEvent.repo';
import { record, type AuditEntry, type AuditSink } from '../utils/audit.util';
import * as authEventRepo from '../repos/authEvent.repo';

/**
 * Binding the audit rule to the table.
 *
 * THE SINK TAKES THE TRANSACTION'S CLIENT, so the audit row and the thing it
 * records commit or roll back together. A separate transaction can commit while
 * the action fails, producing a trail describing something that never happened —
 * or succeed while the audit fails, which is worse: an unattributable privilege
 * change.
 *
 * `record` FROM UTILS IS WHAT VALIDATES. It throws when an event is missing the
 * detail that makes it reviewable — the granter's scope on a delegation, both
 * paths on a scope move — and that throw rolls the whole transaction back. An
 * audit row that cannot be interpreted is worse than none: it appears in the
 * count, satisfies the reviewer's filter and answers nothing.
 */

export function sinkFor(db: Executor): AuditSink {
  return {
    async write(entry: AuditEntry) {
      await authEventRepo.write(db, entry);
    },
  };
}

/** Write an audit row in the caller's transaction. */
export async function log(db: Executor, entry: Omit<AuditEntry, 'occurredAt'> & { occurredAt?: Date }): Promise<void> {
  await record(sinkFor(db), { ...entry, occurredAt: entry.occurredAt ?? new Date() });
}

/* ── Reading it back ─────────────────────────────────────────────────────── */

/**
 * The audit trail, for somebody who holds `audit.read`.
 *
 * ── Why this did not exist, and what that cost ─────────────────────────────
 *
 * `auth_events` has been written since the first migration: every sign-in,
 * every failed attempt, every lockout, every grant and every revocation, in the
 * same transaction as the thing it records. Nothing could read it back. There
 * was no service, no controller and no route — the trail accumulated, correctly
 * and completely, and no customer could look at a single row of it.
 *
 * That is a worse failure than a missing feature, because an audit trail nobody
 * can read is indistinguishable from one nobody is keeping, and this product
 * says on its public security page that it keeps one.
 *
 * ── What a reader is allowed to see ────────────────────────────────────────
 *
 * EVERY EVENT IN THEIR ORGANISATION, NOT ONLY THEIR OWN. An audit trail
 * filtered to the reader is not an audit trail — the whole point is that
 * somebody can review what OTHER people did, and a trail that only shows your
 * own actions cannot answer the one question it exists for. The bound is the
 * organisation, and row level security is what enforces it rather than a
 * predicate anybody here could forget.
 *
 * `detail` CROSSES WHOLE, AND THAT IS CONSIDERED RATHER THAN LAZY. It carries
 * connection ids, permission names, scope paths, attempt counts and the reasons
 * people typed — all facts about this organisation's own administration, which
 * is exactly what the reader is entitled to review. Two entries are worth
 * naming because they look like exceptions and are not: `lastFour` is the
 * trailing fragment of a credential, already shown to whoever set it and the
 * same fragment the interface renders as dots; and `ip_hash` is a keyed hash
 * rather than an address, which is what lets a reviewer say "the same source
 * tried eleven times" without the trail holding anybody's location.
 *
 * WHAT IS NOT IN HERE IS A CUSTOMER'S DATA. §3.2's line holds in the audit
 * trail as everywhere else: these rows describe acts of administration, never
 * the records those acts were about.
 */
export async function list(
  actor: Actor,
  filter: {
    event?: string;
    membershipId?: string;
    from?: Date;
    to?: Date;
    before?: string;
    limit?: number;
  } = {},
): Promise<{ events: StoredEvent[]; next: string | null }> {
  return runWithTenant(
    { organisationId: actor.organisationId, membershipId: actor.membershipId },
    () =>
      withTransaction(async (db) => {
        const authority = await authorityOf(db, actor.membershipId, actor.organisationId);
        assertCan(authority, 'audit.read');

        const limit = filter.limit ?? 100;

        const events = await authEventRepo.list(db, {
          /*
           * CAST, BECAUSE THE SET IS CLOSED IN THE TYPE AND OPEN AT THE DOOR.
           * `AuthEvent` is a union of sixty-odd names; a request naming
           * something outside it matches no row, which is the honest answer —
           * far better than a route that refuses a filter because the union
           * grew in a file the client has never seen.
           */
          event: filter.event as NonNullable<
            NonNullable<Parameters<typeof authEventRepo.list>[1]>['event']
          >,
          membershipId: filter.membershipId,
          from: filter.from,
          to: filter.to,
          before: parseCursor(filter.before),
          limit,
        });

        /*
         * A NEXT CURSOR ONLY WHERE THE PAGE WAS FULL. Handing one back on a
         * short page would make a client ask for a page that cannot exist, and
         * an empty result reads as "the trail ends here" — which is a claim
         * about the trail rather than about the paging.
         */
        const last = events.length === limit ? events[events.length - 1] : undefined;

        return {
          events,
          next: last ? `${last.occurredAt.toISOString()}_${last.id}` : null,
        };
      }),
  );
}

/**
 * The opaque cursor, back into the pair the repo pages on.
 *
 * REFUSED RATHER THAN IGNORED WHEN IT IS MALFORMED. Dropping an unparseable
 * cursor would silently return page one, and a client walking pages would loop
 * over the first hundred rows forever believing it had read the lot.
 */
function parseCursor(cursor?: string): { occurredAt: Date; id: string } | undefined {
  if (!cursor) return undefined;

  const split = cursor.lastIndexOf('_');
  const occurredAt = new Date(cursor.slice(0, split));
  const id = cursor.slice(split + 1);

  if (split < 0 || Number.isNaN(occurredAt.getTime()) || id === '') {
    throw invalid({ message: 'That is not a page cursor.', code: 'invalid.cursor' });
  }

  return { occurredAt, id };
}
