import { withTransaction } from '../infra/db.infra';
import { runWithTenant } from '../utils/tenantContext.util';
import { bounds, notFound, policy } from '../utils/error.util';
import { countSeats, type Seat, type SeatCounts } from '../models/seat.model';
import * as seatRepo from '../repos/seat.repo';
import * as organisationRepo from '../repos/organisation.repo';
import * as billing from './billing.service';
import { assertCan, authorityOf } from './authorisation.service';
import type { Actor } from './scope.service';
import { log } from './audit.service';

/**
 * Licences: how many there are, who is in them, and who may change that.
 *
 * TWO PERMISSIONS, AND THEY ARE NOT THE SAME DECISION. `seat.allocate` moves a
 * licence between people and is scopeable, so a department admin can seat their
 * own team from a pool. `seat.release` reduces what the organisation is paying
 * for and is deliberately organisation-wide — a department head should not be
 * able to shrink the company's bill.
 *
 * RUNNING OUT IS A `bounds` REFUSAL, NOT A DENIAL. Nobody is being kept from
 * anything: the answer is to buy more or reclaim one, and telling somebody to go
 * and ask an administrator for permission they already have is the wrong
 * instruction entirely.
 */

async function withAuthority<T>(
  actor: Actor,
  fn: (
    db: Parameters<Parameters<typeof withTransaction>[0]>[0],
    authority: Awaited<ReturnType<typeof authorityOf>>,
  ) => Promise<T>,
): Promise<T> {
  return runWithTenant(
    { organisationId: actor.organisationId, membershipId: actor.membershipId },
    async () =>
      withTransaction(async (db) => fn(db, await authorityOf(db, actor.membershipId, actor.organisationId))),
  );
}

export async function summary(actor: Actor): Promise<{ counts: SeatCounts; seats: Seat[] }> {
  return withAuthority(actor, async (db) => {
    const seats = await seatRepo.list(db);
    return { counts: countSeats(seats), seats };
  });
}

/**
 * The seats a new organisation starts with.
 *
 * CALLED FROM REGISTRATION, INSIDE THE SAME TRANSACTION. An organisation that
 * exists with no seats is one where the very first invitation is refused for
 * lack of capacity, which reads as the product being broken rather than as a
 * limit.
 */
export async function provisionIncluded(
  db: Parameters<Parameters<typeof withTransaction>[0]>[0],
  input: { organisationId: string; count: number; founderMembershipId: string },
): Promise<void> {
  const seats = await seatRepo.provision(db, {
    organisationId: input.organisationId,
    count: input.count,
    by: null,
  });

  /*
   * Billing §2 — ENTITLED FROM THE FIRST MINUTE. The pool and the subscription
   * that licenses it are created together, so nothing downstream has to treat
   * "no entitlements" as a state of its own.
   */
  const organisation = await organisationRepo.findById(db, input.organisationId);
  if (organisation) {
    await billing.provision(db, {
      organisationId: input.organisationId,
      plan: organisation.plan,
      seats: input.count,
    });
  }

  /*
   * THE FOUNDER TAKES ONE IMMEDIATELY. They are a member; a member occupies a
   * seat. Leaving them unseated makes the count wrong by one from the first
   * second, and the discrepancy is only noticed when the last seat is handed out
   * to somebody who then cannot be seated.
   */
  const first = seats[0];
  if (first) {
    await seatRepo.allocate(db, {
      membershipId: input.founderMembershipId,
      by: input.founderMembershipId,
    });
  }
}

/**
 * Reserve a seat for an invitation being sent.
 *
 * RESERVED RATHER THAN COUNTED. Checking "are there free seats" and then sending
 * the invitation is a read followed by a write, and two administrators inviting
 * at the same moment both read one-left and both send. The reservation is the
 * check.
 */
export async function reserveForInvitation(
  db: Parameters<Parameters<typeof withTransaction>[0]>[0],
  input: { invitationId: string; by: string },
): Promise<Seat | null> {
  const seat = await seatRepo.reserve(db, input);

  if (!seat) {
    throw bounds({
      message:
        'Every licence is in use. Reclaim a seat from someone who has left, or add more, then invite again.',
      code: 'bounds.no_free_seat',
    });
  }

  return seat;
}

/** An invitation was accepted: the reservation becomes an occupied seat. */
export async function claimForMembership(
  db: Parameters<Parameters<typeof withTransaction>[0]>[0],
  input: { invitationId: string; membershipId: string },
): Promise<void> {
  await seatRepo.claimReserved(db, input);
}

/** An invitation was revoked or expired: the seat goes back to the pool. */
export async function releaseReservation(
  db: Parameters<Parameters<typeof withTransaction>[0]>[0],
  invitationId: string,
): Promise<void> {
  await seatRepo.releaseReservation(db, invitationId);
}

export async function allocateTo(
  actor: Actor,
  input: { membershipId: string },
): Promise<Seat> {
  return withAuthority(actor, async (db, authority) => {
    assertCan(authority, 'seat.allocate');

    const seat = await seatRepo.allocate(db, {
      membershipId: input.membershipId,
      by: actor.membershipId,
    });

    if (!seat) {
      throw bounds({
        message: 'Every licence is in use. Reclaim one, or add more.',
        code: 'bounds.no_free_seat',
      });
    }

    await log(db, {
      event: 'seat_allocated',
      organisationId: actor.organisationId,
      membershipId: actor.membershipId,
      // The actor is a membership; the user behind it is not what a seat
      // change is about, and the membership already names them.
      userId: null,
      detail: { seatId: seat.id, to: input.membershipId },
    });

    return seat;
  });
}

export async function reclaim(actor: Actor, seatId: string): Promise<Seat> {
  return withAuthority(actor, async (db, authority) => {
    assertCan(authority, 'seat.allocate');

    const seat = await seatRepo.reclaim(db, seatId);
    if (!seat) throw notFound({ message: 'No such seat.', code: 'missing.seat' });

    await log(db, {
      event: 'seat_reclaimed',
      organisationId: actor.organisationId,
      membershipId: actor.membershipId,
      // The actor is a membership; the user behind it is not what a seat
      // change is about, and the membership already names them.
      userId: null,
      detail: { seatId },
    });

    return seat;
  });
}

/**
 * Give up a licence.
 *
 * REFUSED WHILE SOMEBODY IS SITTING IN IT, by the repository's own `WHERE`. The
 * alternative is a billing action that silently removes a person's access, and
 * the two decisions have different owners.
 */
export async function retire(actor: Actor, seatId: string): Promise<void> {
  await withAuthority(actor, async (db, authority) => {
    assertCan(authority, 'seat.release');

    const seat = await seatRepo.retire(db, { seatId, by: actor.membershipId });
    if (seat) await billing.scheduleReduction(db, { organisationId: actor.organisationId, by: 1 });
    if (!seat) {
      throw policy({
        message:
          'That seat is either occupied or already retired. Reclaim it from whoever holds it first.',
        code: 'policy.seat_occupied',
      });
    }

    await log(db, {
      event: 'seat_released',
      organisationId: actor.organisationId,
      membershipId: actor.membershipId,
      // The actor is a membership; the user behind it is not what a seat
      // change is about, and the membership already names them.
      userId: null,
      /*
       * `effectiveAt` IS REQUIRED BY THE AUDIT VOCABULARY and was missing, so
       * the validator threw and the successful retire returned a 500 — unnoticed
       * because the only test of `retire` asserted a refusal and never reached
       * this line.
       */
      detail: { seatId, effectiveAt: new Date().toISOString() },
    });
  });
}

export async function addSeats(actor: Actor, count: number): Promise<Seat[]> {
  /*
   * Billing §3 — BUYING SEATS IS A BILLING CHANGE, so it is priced, prorated,
   * entitled and audited there. This provisions nothing itself; it answers with
   * the pool as it stands afterwards, which is what the seat screen shows.
   */
  await billing.addSeats(actor, count);
  return (await summary(actor)).seats;
}
