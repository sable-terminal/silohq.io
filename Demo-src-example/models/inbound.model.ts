import type { Manifest } from '../schemas/manifest.schema';
import type { ConnectionStatus } from './connection.model';

/**
 * The two transports that arrive rather than being fetched.
 *
 * THE ADDRESS IS THE CREDENTIAL, which is what shapes everything in here. A
 * webhook and a forwarded email are posted at us by a system that holds no
 * session, so the token in the URL is the whole authorisation — and the only
 * thing a token can be resolved to before any tenant is known is the row it
 * points at. `IntakeTarget` is that row, and it is deliberately the minimum
 * needed to route an event: no payload, no credential, no grant.
 */

/** §5 — the two kinds nothing reaches out for. */
export type InboundTransportKind = Extract<
  Manifest['transport']['kind'],
  'inbound_webhook' | 'email_fallback'
>;

/**
 * Whether a connector receives rather than fetches.
 *
 * DERIVED IN ONE PLACE BECAUSE THREE ASK. Minting an address refuses anything
 * else, the query path skips the credential requirement for these two, and the
 * receiving endpoints check the kind matches the door they arrived at. Written
 * out at each of those, the list of inbound kinds is three copies that agree
 * until a third inbound transport exists — and the one that is missed is a
 * connector that can never be queried, because it is asked for a credential it
 * is not supposed to have.
 */
export function isInboundTransport(
  kind: Manifest['transport']['kind'],
): kind is InboundTransportKind {
  return kind === 'inbound_webhook' || kind === 'email_fallback';
}

/**
 * Where an event belongs, resolved from the address it was posted to.
 *
 * THE MANIFEST IS PARSED, NOT CARRIED AS A DOCUMENT. The route it arrived on
 * says nothing about which object the payload is; only the manifest does, and a
 * document this process cannot parse is one whose fields it would place wrongly.
 * `connector.repo` owns that refusal and this reuses it.
 */
export interface IntakeTarget {
  connectionId: string;
  organisationId: string;
  /** Per connection, and capped by a CHECK in 025 rather than by intention. */
  retentionHours: number;
  status: ConnectionStatus;
  manifest: Manifest;
}

/**
 * Whether a connection is still taking what is sent to it.
 *
 * A HALTED CONNECTION STOPS ACCEPTING, and that is not the same as a closed
 * door. §8 halts when a field changed meaning, so events still arriving would be
 * stored against a manifest known to be wrong and read incorrectly for as long
 * as the retention window lasts. A revoked one has no standing at all.
 *
 * DERIVED RATHER THAN A SECOND COLUMN, for the reason `seat.model` gives: an
 * `accepting` flag beside `status` is wrong the first time one is set without
 * the other, and the wrong one is the one the intake path reads.
 */
export function acceptsEvents(status: ConnectionStatus): boolean {
  return status !== 'halted' && status !== 'revoked';
}
