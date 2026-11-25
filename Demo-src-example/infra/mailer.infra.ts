import { env, isProd } from '../config/env.config';
import { childLogger } from '../config/logger.config';

const log = childLogger('mailer');

/**
 * Outbound email.
 *
 * IN DEVELOPMENT IT PRINTS RATHER THAN SENDS, and prints the whole message
 * including any link. Development that silently drops mail means an invitation
 * flow nobody can test without a real inbox; development that really sends means
 * a test run emailing a customer.
 *
 * EVERY MESSAGE IS BOTH TEXT AND HTML. Clients choose, some readers force text,
 * and an HTML-only message with no alternative is a mild negative signal at every
 * major provider. The two halves must say the same thing.
 */

export interface Mail {
  to: string;
  subject: string;
  text: string;
  html?: string;
  replyTo?: string;
}

export interface SendResult {
  sent: boolean;
  providerId?: string;
  error?: string;
}

/**
 * What development and test runs would have sent.
 *
 * THE ONLY WAY TO READ AN INVITATION TOKEN THE WAY AN INVITEE DOES. The token is
 * generated, hashed, and the hash is stored — the plaintext exists in exactly one
 * place, the email, and there is no endpoint that returns it, deliberately: an
 * administrator who could read an invitation token could accept on somebody
 * else's behalf. So a test that wants to follow an invitation link has to read
 * the link, and this is where the link is.
 *
 * BOUNDED, AND NEVER POPULATED IN PRODUCTION. The array is only appended to on
 * the branch that runs when no mail provider is configured, which
 * `assertProductionReady` refuses to boot with. It cannot become a place where
 * production accumulates the contents of everybody's email.
 */
export interface SentMail extends Mail {
  at: Date;
}

const outbox: SentMail[] = [];
const OUTBOX_LIMIT = 100;

/** Everything the development sink has swallowed, oldest first. */
export function sent(): readonly SentMail[] {
  return outbox;
}

/** The most recent message to an address, or the most recent of any. */
export function lastSent(to?: string): SentMail | undefined {
  const matching = to ? outbox.filter((mail) => mail.to === to) : outbox;
  return matching[matching.length - 1];
}

export function clearSent(): void {
  outbox.length = 0;
}

export async function send(mail: Mail): Promise<SendResult> {
  if (!env.RESEND_API_KEY) {
    if (isProd) {
      // Not a throw: a failed invitation should not take down the request that
      // created the membership. It is recorded, and the row shows it unsent.
      log.error({ to: redactAddress(mail.to) }, 'No mail provider configured; message dropped');
      return { sent: false, error: 'No mail provider configured' };
    }

    outbox.push({ ...mail, at: new Date() });
    // A long-running development server would otherwise hold every message it
    // ever printed.
    if (outbox.length > OUTBOX_LIMIT) outbox.splice(0, outbox.length - OUTBOX_LIMIT);
    log.info(
      { to: mail.to, subject: mail.subject },
      `\n─── mail (not sent) ───\nTo: ${mail.to}\nSubject: ${mail.subject}\n\n${mail.text}\n───\n`,
    );
    return { sent: true, providerId: 'dev-console' };
  }

  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${env.RESEND_API_KEY}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        from: env.MAIL_FROM,
        to: [mail.to],
        subject: mail.subject,
        text: mail.text,
        ...(mail.html ? { html: mail.html } : {}),
        ...(mail.replyTo ? { reply_to: mail.replyTo } : {}),
      }),
      signal: AbortSignal.timeout(15_000),
    });

    if (!response.ok) {
      const detail = await response.text();
      log.error({ status: response.status, detail: detail.slice(0, 200) }, 'Mail send failed');
      return { sent: false, error: `Provider returned ${response.status}` };
    }

    const body = (await response.json()) as { id?: string };
    return { sent: true, providerId: body.id };
  } catch (error) {
    log.error({ err: error }, 'Mail send failed');
    return { sent: false, error: error instanceof Error ? error.message : 'unknown' };
  }
}

/**
 * An address reduced to something loggable.
 *
 * A FULL ADDRESS IN A LOG IS PERSONAL DATA IN A SYSTEM WITH A DIFFERENT
 * RETENTION POLICY FROM THE DATABASE. Enough survives to correlate two lines
 * about the same person; not enough to be a mailing list.
 */
function redactAddress(address: string): string {
  const [local, domain] = address.split('@');
  if (!domain) return '***';
  return `${local!.slice(0, 2)}***@${domain}`;
}
