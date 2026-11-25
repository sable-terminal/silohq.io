import { childLogger } from '../config/logger.config';
import * as siloKeep from './siloKeep.service';
import * as siloLearned from './siloLearned.service';
import * as siloShare from './siloShare.service';
import type { Holding } from '../repos/siloHolding.repo';
import type { Actor } from './scope.service';

const log = childLogger('silo-sync');

/**
 * Siloes — keeping a concept, from the choice to the copy to what follows from it.
 *
 * ── ONE PLACE THAT KNOWS THE ORDER ────────────────────────────────────────
 *
 * `siloKeep` copies. `siloLearned` works out, from the copies, which records
 * are the same and which values are written two ways. Each is whole without
 * the other; this is what runs them in turn, so that a route and the scheduler
 * cannot do half.
 *
 * ── THE COPY IS THE THING THAT MUST NOT FAIL ──────────────────────────────
 *
 * Everything after it is worked out FROM it. A failure there is logged and
 * leaves the copy served, with whatever was worked out last time still
 * standing: a question is never refused because a table beside the copy could
 * not be remade.
 */

/**
 * Bring the views other tools read up to date with what these Siloes now keep.
 *
 * NOTHING FOR A SILO NOBODY READS, which is nearly all of them. And never the
 * reason a copy, a choice to keep or a choice to stop is reported as failed:
 * the views are remade at the next copy in any case.
 */
async function show(organisationId: string, siloIds: Iterable<string>): Promise<void> {
  for (const siloId of new Set(siloIds)) {
    try {
      await siloShare.refresh(organisationId, siloId);
    } catch (error) {
      log.warn({ siloId, err: error }, 'The views other tools read of a Silo could not be brought up to date');
    }
  }
}

/** Keep a concept in a Silo, or change whether its past copies are kept. */
export async function keep(actor: Actor, input: Parameters<typeof siloKeep.keep>[1]): Promise<Holding[]> {
  const holdings = await siloKeep.keep(actor, input);
  /* Past copies stopped are past copies no longer shown. */
  await show(actor.organisationId, [input.siloId]);
  return holdings;
}

/** Copy a kept concept across now, and remake what is worked out from it. */
export async function copy(actor: Actor, conceptId: string): Promise<Holding[]> {
  const holdings = await siloKeep.sync(actor, conceptId);

  /* Only from copies that are all whole: a matching of half a concept is not one. */
  if (holdings.length > 0 && holdings.every((one) => one.state === 'synced')) {
    try {
      await siloLearned.learn(actor, conceptId);
    } catch (error) {
      log.warn({ conceptId, err: error }, 'What a copy shows could not be worked out; the copy is served without it');
    }
  }

  /* After what is worked out, so the views of it show this copy's and not the last one's. */
  await show(actor.organisationId, holdings.map((one) => one.siloId));

  return holdings;
}

/**
 * Copy one kept concept on schedule, as the person who asked for it to be kept.
 *
 * FOR THE SCHEDULER (`silo:sync`). Nothing here decides what is kept; it makes
 * today's copy of what somebody already chose, with their reach and no more.
 */
export async function copyAs(input: { organisationId: string; keptBy: string; conceptId: string }): Promise<Holding[]> {
  return copy({ organisationId: input.organisationId, membershipId: input.keptBy }, input.conceptId);
}

/** Stop keeping a concept: its copies go, and so does everything worked out from them. */
export async function stop(actor: Actor, conceptId: string): Promise<void> {
  const kept = await siloKeep.status(actor, conceptId);
  await siloKeep.release(actor, conceptId);

  try {
    await siloLearned.forget(actor.organisationId, conceptId);
  } catch (error) {
    /* Unread without the copies, and unreadable past the Silo's window; the sweep takes what this could not. */
    log.warn({ conceptId, err: error }, 'What was worked out from a released concept could not be removed now');
  }

  await show(actor.organisationId, kept.map((one) => one.siloId));
}
