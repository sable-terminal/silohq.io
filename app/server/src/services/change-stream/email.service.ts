// Email fallback's intake (spec 14.4): a notification forwarded to the address minted for a
// connection, posted by the cell's mail relay (the provider's inbound route, or the
// self-managed SMTP relay) to the gateway, signed with the cell's inbound secret.
//
// 1. The relay's signature: HMAC-SHA256 under the cell's secret over the recipient, a dot and
//    the message. Otherwise refused (401), and the message is never parsed.
// 2. The recipient routes: c-<token>@<the cell's inbound domain>; the token's SHA-256 names one
//    live address (connect.resolve_email_address), in the organisation that minted it.
// 3. The message is parsed (utils/mime.util.ts) and read by the connector's rules
//    (emailRules.service.ts) into one change, published as any source's (publish.service).
//    A message set aside changes nothing and is counted; its text is never logged or kept.

import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { inTransaction } from '../../infra/postgres.infra.ts';
import { emailAddressRepo } from '../../repos/connect/index.repo.ts';
import { AppError } from '../../utils/errors.util.ts';
import { parseMessage } from '../../utils/mime.util.ts';
import type { ChangeStreamDeps } from './deps.service.ts';
import { extractNotification, type SetAside } from './emailRules.service.ts';
import { publishChanges } from './publish.service.ts';
import type { SourceCatalogue } from './sources.service.ts';
import type { StreamHealthStore } from './status.service.ts';

export const ADDRESS_TOKEN = /^c-([a-z2-7]{26})@(.+)$/;

export const emailTokenHash = (token: string): Buffer => createHash('sha256').update(token, 'utf8').digest();

/** The relay's signature over a recipient and a message, as the gateway receives it. */
export const relaySignature = (secret: string, recipient: string, message: string): string =>
  `v1=${createHmac('sha256', secret).update(`${recipient}.${message}`, 'utf8').digest('hex')}`;

const notFound = () => new AppError('not_found', 'no such address', { code: 'route.not_found' });

export async function receiveEmail(deps: ChangeStreamDeps, catalogue: SourceCatalogue, health: StreamHealthStore,
  input: { recipient: string; message: string; signature: string }, correlationId: string)
  : Promise<{ accepted: number; discarded: number; setAside: SetAside | null }> {
  if (deps.inboundEmail === undefined) {
    throw new AppError('configuration', 'this cell takes no email: INBOUND_EMAIL_DOMAIN and INBOUND_EMAIL_SECRET are not set', { code: 'config.inbound_email' });
  }
  const expected = Buffer.from(relaySignature(deps.inboundEmail.secret, input.recipient, input.message));
  const given = Buffer.from(input.signature);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
    deps.logger.warn('an inbound email was not signed by the relay', { event: 'stream.email_rejected' });
    throw new AppError('unauthenticated', 'the message is not signed by the cell\'s mail relay', { code: 'stream.email_signature' });
  }
  const recipient = /<([^>]+)>/.exec(input.recipient)?.[1] ?? input.recipient;
  const m = ADDRESS_TOKEN.exec(recipient.trim().toLowerCase());
  if (m === null || m[2] !== deps.inboundEmail.domain) throw notFound();
  const control = deps.databases.pool('control');
  const address = await inTransaction(control, {}, (db) => emailAddressRepo.resolve(db, emailTokenHash(m[1]!)), { readOnly: true });
  if (address === undefined) throw notFound();
  const request = { organisationId: address.organisationId };
  const sources = await catalogue.load(request, address.connectionId);
  const block = sources.manifest.changeStream?.email;
  if (block === undefined || sources.connection.status !== 'active') throw notFound();

  const extracted = extractNotification(block, sources.manifest.objects, parseMessage(input.message));
  if ('setAside' in extracted) {
    await inTransaction(control, request, (db) => emailAddressRepo.countMessage(db, address.id, false));
    deps.logger.info('an inbound email was set aside', { event: 'stream.email_set_aside', connectionId: address.connectionId, reason: extracted.setAside });
    return { accepted: 0, discarded: 1, setAside: extracted.setAside };
  }
  const outcome = await publishChanges(deps, sources, 'email', [extracted.draft]);
  await inTransaction(control, request, (db) => emailAddressRepo.countMessage(db, address.id, true));
  await health.report(address.organisationId, address.connectionId, { status: 'live', source: 'email', delivered: true, deltas: outcome.objects.size > 0 });
  deps.logger.info('an inbound email was taken', { event: 'stream.email_taken', connectionId: address.connectionId, count: outcome.accepted });
  return { accepted: outcome.accepted, discarded: outcome.discarded, setAside: null };
}
