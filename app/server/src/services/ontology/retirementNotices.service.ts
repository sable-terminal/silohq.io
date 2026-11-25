// Owners of dependants told about a deprecation (spec 25.7): at deprecation, and seven days
// before retirement. The dependants are the dependency index's live rows naming the element
// (an object type's include those naming its properties); their owners are the people
// accountable for each. Notices are best effort: a failure is logged and never undoes the
// deprecation. Each owner is told once per element and kind (the notification's own
// uniqueness), so a sweep run twice tells no one twice.
//
// The reminder is kept in the deprecation's transaction and sent by the sweep on its day. On
// that day the element must still be deprecated with the same retirement date on main's
// head: one retired first, or brought back by a rollback, cancels it instead.

import { raiseNotification } from '../../contracts/notify/notification.contract.ts';
import type { ElementKind } from '../../contracts/ontology/proposal.contract.ts';
import { inTransaction, type Queryable } from '../../infra/postgres.infra.ts';
import { ontologyBranchRepo, ontologyDependencyRepo, retirementReminderRepo } from '../../repos/ontology/index.repo.ts';
import { uuidv7 } from '../../utils/id.util.ts';
import { findById, type AnyEntry, type Content } from './content.service.ts';
import type { OntologyDeps } from './deps.service.ts';
import { readContent } from './store.service.ts';

/** How long before retirement the reminder goes. */
export const REMIND_DAYS_BEFORE = 7;
const BATCH = 200;

type Notice = 'element_deprecated' | 'element_retiring';

const daysBefore = (date: string, days: number): string =>
  new Date(Date.parse(`${date}T00:00:00Z`) - days * 86_400_000).toISOString().slice(0, 10);

/** The element and, for an object type, its properties: what a dependant can name. */
export function elementRefs(kind: ElementKind, entry: AnyEntry): string[] {
  return [entry.id, ...(kind === 'object_type' ? (entry as Content['objectTypes'][number]).properties.map((p) => p.identityId) : [])];
}

/** In the deprecation's transaction: the reminder for seven days before retirement, replacing an open one. */
export async function keepReminder(db: Queryable, organisationId: string, kind: ElementKind, elementId: string, retireAfter: string): Promise<void> {
  await retirementReminderRepo.cancelOpen(db, elementId);
  await retirementReminderRepo.insert(db, {
    id: uuidv7(), organisationId, elementKind: kind, elementId, retireAfter, remindOn: daysBefore(retireAfter, REMIND_DAYS_BEFORE),
  });
}

/** In the retirement's transaction: the reminder is not sent. */
export async function dropReminder(db: Queryable, elementId: string): Promise<void> {
  await retirementReminderRepo.cancelOpen(db, elementId);
}

/** Tells the owners of the element's dependants; returns how many were told. Never throws. */
export async function tellOwners(deps: OntologyDeps, organisationId: string, correlationId: string, kind: Notice, elementId: string,
  refs: readonly string[]): Promise<number> {
  const request = { organisationId };
  let owners: string[];
  try {
    owners = await inTransaction(deps.databases.pool('control'), request, (db) => ontologyDependencyRepo.ownersOf(db, refs), { readOnly: true });
  } catch (error) {
    deps.logger.failure('the owners of a deprecated element\'s dependants could not be found', error, { event: 'ontology.notice_failed', organisationId });
    return 0;
  }
  let told = 0;
  for (const recipientMembershipId of owners) {
    try {
      await deps.services.call(raiseNotification, { body: { recipientMembershipId, kind, source: { ontologyElementId: elementId } } }, { request, correlationId });
      told += 1;
    } catch (error) {
      deps.logger.failure('an owner of a dependant was not told about a deprecation', error, { event: 'ontology.notice_failed', organisationId });
    }
  }
  return told;
}

async function sendOne(deps: OntologyDeps, organisationId: string, reminderId: string, correlationId: string, now: Date): Promise<'sent' | 'cancelled' | 'skipped'> {
  const pool = deps.databases.pool('control');
  const request = { organisationId };
  const found = await inTransaction(pool, request, async (db) => {
    const reminder = await retirementReminderRepo.findById(db, reminderId);
    if (reminder === undefined || reminder.sentAt !== null || reminder.cancelledAt !== null) return undefined;
    const main = await ontologyBranchRepo.findMain(db);
    const content = main?.headVersionId ? await readContent(db, organisationId, main.headVersionId) : undefined;
    const kind = reminder.elementKind as ElementKind;
    return { reminder, kind, entry: content === undefined ? undefined : findById(content, kind, reminder.elementId) as AnyEntry | undefined };
  }, { readOnly: true });
  if (found === undefined) return 'skipped';
  const { reminder, kind, entry } = found;
  const standing = entry !== undefined && entry.status === 'deprecated' && (entry as { retireAfter?: string }).retireAfter === reminder.retireAfter;
  if (standing) await tellOwners(deps, organisationId, correlationId, 'element_retiring', reminder.elementId, elementRefs(kind, entry));
  const at = now.toISOString();
  await inTransaction(pool, request, (db) => retirementReminderRepo.update(db, reminder.id, standing ? { sentAt: at } : { cancelledAt: at }));
  return standing ? 'sent' : 'cancelled';
}

/** The sweep: every reminder due by today, across organisations, each under its own organisation. */
export async function sendDueReminders(deps: OntologyDeps, correlationId: string): Promise<{ sent: number; cancelled: number }> {
  const now = (deps.now ?? (() => new Date()))();
  const due = await inTransaction(deps.databases.pool('control'), {}, (db) => retirementReminderRepo.due(db, now.toISOString().slice(0, 10), BATCH),
    { readOnly: true });
  const out = { sent: 0, cancelled: 0 };
  for (const d of due) {
    try {
      const outcome = await sendOne(deps, d.organisationId, d.id, correlationId, now);
      if (outcome === 'sent') out.sent += 1;
      else if (outcome === 'cancelled') out.cancelled += 1;
    } catch (error) {
      deps.logger.failure('a retirement reminder could not be sent; it is tried again', error, { event: 'ontology.reminder_failed', organisationId: d.organisationId });
    }
  }
  return out;
}

export interface RetirementReminders {
  sendDue(correlationId: string): Promise<{ sent: number; cancelled: number }>;
}

export function createRetirementReminders(deps: OntologyDeps): RetirementReminders {
  return { sendDue: (correlationId) => sendDueReminders(deps, correlationId) };
}
