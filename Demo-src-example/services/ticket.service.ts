import { env } from '../config/env.config';
import { withTransaction } from '../infra/db.infra';
import { runWithTenant } from '../utils/tenantContext.util';
import { generateId } from '../utils/tokens.util';
import { notFound } from '../utils/error.util';
import { childLogger } from '../config/logger.config';
import { fullName } from '../models/user.model';
import * as mailer from '../infra/mailer.infra';
import * as ticketRepo from '../repos/ticket.repo';
import * as membershipRepo from '../repos/membership.repo';
import * as userRepo from '../repos/user.repo';
import type { Actor } from './scope.service';

/**
 * Asking for help.
 *
 * ── NOBODY IS EVER TOLD THEY MAY NOT ASK ──────────────────────────────────
 *
 * There is no permission in front of any of this beyond having a session, and
 * that is a decision rather than an omission. A role that could not raise a
 * support ticket would mean somebody watching the product fail with no way to
 * say so — and the ticket is usually ABOUT being unable to do something, so
 * gating it behind the same authority that is already refusing them is circular.
 * A cancelled account can raise one too, for the same reason it can still read
 * the last thing it was told: it is the account most likely to need to.
 *
 * ── WHO IT IS FROM IS THE SESSION'S, NEVER THE REQUEST'S ──────────────────
 *
 * The compose box has one field because there is only one thing we do not
 * already know. The name and the address are read from the membership here, so
 * a request cannot raise a ticket in somebody else's name, and a second client
 * cannot disagree with the first about the format of a name.
 *
 * ── AND NO AUDIT ROW ──────────────────────────────────────────────────────
 *
 * The audit trail answers "what was done to this organisation's data and its
 * configuration". Writing to the vendor is neither; a row per ticket would put
 * correspondence with us into the record a customer's own reviewer reads.
 */

const log = childLogger('tickets');

/** Long enough to be a heading, short enough for the panel's row. Matches the CHECK. */
const SUBJECT_MAX = 120;

/**
 * The heading, taken from the first line of the message.
 *
 * AS A CONVERSATION'S TITLE IS TAKEN FROM ITS FIRST QUESTION. Asking for a
 * subject separately would be a second field in a box whose whole argument is
 * that it has one — and the first thing somebody writes is what the ticket is
 * about, which is the definition of a subject.
 */
function subjectOf(body: string): string {
  const firstLine = body.split('\n').find((line) => line.trim().length > 0) ?? body;
  const collapsed = firstLine.replace(/\s+/g, ' ').trim();

  return collapsed.length > SUBJECT_MAX ? `${collapsed.slice(0, SUBJECT_MAX - 1).trimEnd()}…` : collapsed;
}

/** What each kind is called in the email's subject line, in the panel's own words. */
const KIND_LABEL: Record<ticketRepo.TicketKind, string> = {
  support: 'Support ticket',
  feature: 'Feature request',
  security: 'Security issue',
  partnership: 'Partner with us',
};

/**
 * Raise one.
 *
 * ── STORED FIRST, EMAILED AFTER, AND THE ORDER IS THE WHOLE POINT ─────────
 *
 * The send happens outside the transaction and its failure is logged rather
 * than thrown. A ticket that is stored but not emailed is recoverable — the row
 * is there, it is in the panel, and somebody can be told to go and look. A
 * ticket refused because the mail provider was down is lost: the person is
 * shown a failure, and the words they wrote are gone with the form.
 *
 * Emailing after the commit rather than inside it is the same argument from the
 * other side: mail cannot be rolled back, so a message sent from inside a
 * transaction that then fails announces a ticket nobody can find.
 */
export async function raise(
  actor: Actor,
  input: { kind: ticketRepo.TicketKind; body: string },
): Promise<{ ticket: ticketRepo.Ticket }> {
  const { ticket, from } = await runWithTenant(
    { organisationId: actor.organisationId, membershipId: actor.membershipId },
    () =>
      withTransaction(async (db) => {
        const membership = await membershipRepo.findById(db, actor.membershipId);
        const user = membership ? await userRepo.findById(db, membership.userId) : null;
        /* A session naming a membership that is not there is not a ticket
           problem; it is a session problem, and it stops here rather than
           raising a ticket signed by nobody. */
        if (!user) throw notFound({ message: 'That membership is not there.', code: 'missing.membership' });

        const ticket = await ticketRepo.create(db, {
          id: generateId(),
          organisationId: actor.organisationId,
          raisedByMembershipId: actor.membershipId,
          kind: input.kind,
          subject: subjectOf(input.body),
          body: input.body,
        });

        return { ticket, from: { name: fullName(user), email: user.email } };
      }),
  );

  const sent = await mailer.send({
    to: env.SUPPORT_EMAIL,
    subject: `[${ticket.reference}] ${KIND_LABEL[ticket.kind]}: ${ticket.subject}`,
    /*
     * `replyTo` IS THE PERSON, NOT US. Support answers by pressing reply, which
     * is the whole mechanism by which a ticket gets answered at all — there is
     * no thread in the product to reply into yet.
     */
    replyTo: from.email,
    text: [
      `${from.name} <${from.email}> raised ${KIND_LABEL[ticket.kind].toLowerCase()} ${ticket.reference}.`,
      '',
      ticket.body,
      '',
      '—',
      `Organisation ${actor.organisationId}`,
      `Membership ${actor.membershipId}`,
    ].join('\n'),
  });

  if (!sent.sent) {
    /*
     * LOGGED AND NOT THROWN. The row is the ticket; the email is how somebody
     * finds out about it quickly. Losing the second is a thing to go and fix,
     * and telling the person their message failed when it is safely stored
     * would have them write it again.
     */
    log.error(
      { ticketId: ticket.id, reference: ticket.reference, error: sent.error },
      'Ticket stored but not emailed',
    );
  }

  return { ticket };
}

/** Mine, newest first. Nobody else's: a ticket is between one person and us. */
export async function mine(actor: Actor): Promise<{ tickets: ticketRepo.Ticket[] }> {
  return runWithTenant({ organisationId: actor.organisationId, membershipId: actor.membershipId }, () =>
    withTransaction(async (db) => ({
      tickets: await ticketRepo.listRaisedBy(db, actor.membershipId),
    })),
  );
}

/**
 * One of mine.
 *
 * SOMEBODY ELSE'S AND NOT THERE GIVE THE SAME ANSWER. Row level security already
 * keeps another organisation out; this is the line inside one, and it is a real
 * one — a ticket can say "I think Priya deleted it" or carry a password somebody
 * pasted by mistake, and an administrator is not a party to it. Distinguishing
 * the two would turn a list of uuids into a way to count a colleague's tickets.
 */
export async function open(actor: Actor, id: string): Promise<{ ticket: ticketRepo.Ticket }> {
  return runWithTenant({ organisationId: actor.organisationId, membershipId: actor.membershipId }, () =>
    withTransaction(async (db) => {
      const ticket = await ticketRepo.read(db, id);
      if (!ticket || ticket.raisedByMembershipId !== actor.membershipId) {
        throw notFound({ message: 'That ticket is not there.', code: 'missing.ticket' });
      }
      return { ticket };
    }),
  );
}
