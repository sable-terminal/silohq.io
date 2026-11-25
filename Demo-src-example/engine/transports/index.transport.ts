import type { TransportKindV2 } from '../../schemas/manifest.schema';
import { refusal } from '../../utils/error.util';
import type { Transport } from './contract.transport';
import { graphql, rest, soap } from './https.transport';
import { sql } from './database.transport';
import { ftp, sftp, smb } from './files.transport';
import { emailFallback, inboundWebhook, queueTap, siloImport } from './local.transport';
import { grpcTransport } from './grpc.transport';
import { imap } from './mail.transport';
import { kafka } from './stream.transport';

/**
 * Every protocol Silo speaks, by name.
 *
 * A NEW SYSTEM NEVER ADDS A LINE HERE. A new PROTOCOL does — once, for every
 * connector on it. A kind the schema accepts but no transport serves yet is a
 * refusal naming the gap, never an empty answer.
 */
const TRANSPORTS: Partial<Record<TransportKindV2, Transport>> = {
  https_rest: rest as Transport,
  graphql: graphql as Transport,
  soap: soap as Transport,
  sql: sql as Transport,
  sftp: sftp as Transport,
  ftp: ftp as Transport,
  smb: smb as Transport,
  imap: imap as Transport,
  grpc: grpcTransport as Transport,
  kafka: kafka as Transport,
  queue_tap: queueTap as Transport,
  inbound_webhook: inboundWebhook as Transport,
  email_fallback: emailFallback as Transport,
  silo_import: siloImport as Transport,
};

export function transportFor(kind: TransportKindV2): Transport {
  const found = TRANSPORTS[kind];
  if (!found) {
    throw refusal({
      message: `Silo cannot speak ${kind} to a source yet. This is a gap in the product, not a problem with your system.`,
      code: 'refusal.transport_pending',
      detail: { kind },
    });
  }
  return found;
}
