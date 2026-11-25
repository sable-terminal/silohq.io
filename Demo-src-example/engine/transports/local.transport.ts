import { refusal } from '../../utils/error.util';
import type { AuthSurface, SocketAuth, Transport, WireRequest } from './contract.transport';

/**
 * The transports that reach no network: what was pushed AT Silo — a webhook, a
 * forwarded email, the messages an agent tapped from a queue — and a copy Silo
 * holds of another Silo's data.
 *
 * THE ENGINE REACHES NO STORE ITSELF. The service that opened the connection
 * hands the read context a `local` reader; these transports only describe what
 * is wanted, and the runner passes it there. They are never sent through an
 * agent and never carry a credential, because there is nobody to present one to.
 *
 * A SILO IMPORT PLANS LIKE A DATABASE: the row store takes every filter, the
 * order, the field list and the limit, so its pushdown is derived rather than
 * declared. The inbound store takes only the limit — what arrived is read
 * newest first, inside its retention window, and filtered here.
 */

export interface LocalWire extends WireRequest {
  kind: 'inbound_webhook' | 'email_fallback' | 'queue_tap' | 'silo_import';
  limit: number;
  where: Array<{ column: string; operator: string; value: unknown }>;
  order: Array<{ field: string; direction: 'asc' | 'desc' }>;
  fields: string[];
}

const nothing = (): never => {
  throw refusal({ message: 'Nothing is sent to a source Silo holds itself.', code: 'refusal.auth_place_unsupported' });
};

const surface = (socket: SocketAuth): AuthSurface => ({
  setHeader: nothing,
  setQuery: nothing,
  setBodyPath: nothing,
  setCookie: nothing,
  setForm: nothing,
  setSoapHeader: nothing,
  socket,
});

function local(kind: LocalWire['kind']): Transport<LocalWire> {
  return {
    kind,
    writes: false,
    local: true,
    prepare: ({ request }) => ({
      kind,
      limit: request.limit ?? 10_000,
      where: request.where,
      order: request.order,
      fields: request.fields ?? [],
    }),
    authSurface: (_wire, socket) => surface(socket),
    send() {
      throw refusal({ message: 'A local source is read by the service that holds it.', code: 'refusal.local_unreadable' });
    },
    floor: () => null,
  };
}

export const inboundWebhook = local('inbound_webhook');
export const emailFallback = local('email_fallback');
/* What the agent's tap forwarded from a queue or a topic, read like a webhook's events. */
export const queueTap = local('queue_tap');
export const siloImport = local('silo_import');
