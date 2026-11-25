import { withTransaction } from '../infra/db.infra';
import { runWithTenant } from '../utils/tenantContext.util';
import { childLogger } from '../config/logger.config';
import { recordsFromWebhook } from '../engine/read/inbound.read';
import { resolveTls } from '../engine/read/context.read';
import { applyAuth } from '../engine/auth/apply.auth';
import { text } from '../engine/expression/evaluate.expression';
import { seal } from '../engine/relay/seal.relay';
import type { AuthSurface, SocketAuth } from '../engine/transports/contract.transport';
import type { TapWire } from '../engine/transports/tap.transport';
import { acceptsEvents } from '../models/inbound.model';
import type { ConnectionStatus } from '../models/connection.model';
import * as agentRepo from '../repos/agent.repo';
import * as connectorRepo from '../repos/connector.repo';
import * as inboundRepo from '../repos/inbound.repo';
import { withConnection } from './connectorRuntime.service';

const log = childLogger('agent-tap');

/**
 * Queue taps: what an agent should be listening to, and what it heard.
 *
 * ── THE TAP IS CONFIGURED HERE AND OPENED THERE ──────────────────────────
 *
 * When an agent connects it is sent, sealed to its key, each `queue_tap`
 * connection routed through it: the broker, what to listen to, and the
 * credential placed where the protocol takes it. The credential is opened
 * through the same runtime a question uses, and audited the same way, on the
 * authority of the admin who confirmed the connection's route.
 *
 * ── WHAT IT HEARS IS STORED LIKE A WEBHOOK'S EVENTS ──────────────────────
 *
 * Each message runs through the object's `records` expression and is kept for
 * the connection's intake window, then read by questions like any inbound
 * source. A message from an agent the connection is not routed through is
 * refused, whatever it claims.
 */

const inOrganisation = <T>(organisationId: string, fn: Parameters<typeof withTransaction<T>>[0]) =>
  runWithTenant({ organisationId, membershipId: null }, () => withTransaction(fn));

const refuse = (where: string): never => {
  throw new Error(`A tap takes its credential on the connection, not at ${where}.`);
};

const socketOnly = (socket: SocketAuth): AuthSurface => ({
  setHeader: (n) => refuse(`header:${n}`),
  setQuery: (n) => refuse(`query:${n}`),
  setBodyPath: (p) => refuse(`body:${p}`),
  setCookie: (n) => refuse(`cookie:${n}`),
  setForm: (n) => refuse(`form:${n}`),
  setSoapHeader: (p) => refuse(`soap:${p}`),
  socket,
});

/** Every tap an agent should hold open, each sealed to it. */
export async function tapsFor(agentId: string, organisationId: string, agentKey: string): Promise<Array<{ connectionId: string; sealed: Buffer }>> {
  const ids = await inOrganisation(organisationId, (db) => agentRepo.tapsFor(db, agentId));
  const out: Array<{ connectionId: string; sealed: Buffer }> = [];
  for (const connectionId of ids) {
    try {
      out.push({ connectionId, sealed: await tapConfig(organisationId, connectionId, agentKey) });
    } catch (error) {
      log.warn({ err: error, agentId, connectionId }, 'A tap could not be configured');
    }
  }
  return out;
}

async function tapConfig(organisationId: string, connectionId: string, agentKey: string): Promise<Buffer> {
  const { connection, credential, membershipId } = await inOrganisation(organisationId, async (db) => {
    const [loaded] = await connectorRepo.load(db, [connectionId]);
    const stored = await connectorRepo.credentialsFor(db, [connectionId]);
    return { connection: loaded!, credential: stored.get(connectionId), membershipId: await agentRepo.confirmedBy(db, connectionId) };
  });
  const transport = connection.manifest.transport;
  if (transport.kind !== 'queue_tap' || !membershipId) throw new Error('Not a tap routed through an agent.');

  return withConnection({
    actor: { organisationId, membershipId },
    connection,
    credential,
    forTap: true,
    use: async (open) => {
      const ctx = await open(connection.manifest.objects[0]!.name);
      const socket: SocketAuth = { tls: await resolveTls(transport, ctx.params) };
      if (ctx.strategy) {
        await applyAuth({
          strategy: ctx.strategy,
          credential: ctx.credential,
          params: ctx.params,
          kind: 'queue_tap',
          req: {},
          surface: socketOnly(socket),
          isWrite: false,
          route: { via: 'agent', agentId: 'tap', connectionId },
          cacheKey: ctx.cacheKey,
          origin: null,
          deps: ctx.auth,
        });
      }
      const wire: TapWire = {
        protocol: transport.protocol,
        url: (await text(transport.url, { params: ctx.params })) ?? '',
        source: (await text(transport.source, { params: ctx.params })) ?? '',
      };
      return seal(agentKey, Buffer.from(JSON.stringify({ connectionId, wire, socket })), `tap:${connectionId}`);
    },
  });
}

/** What an agent heard on a tap, stored for the connection's intake window. */
export async function receiveTapped(
  agentId: string,
  organisationId: string,
  connectionId: string,
  messages: Array<{ subject: string; headers: Record<string, string>; value: unknown; receivedAt: string }>,
): Promise<number> {
  return inOrganisation(organisationId, async (db) => {
    if ((await agentRepo.agentOf(db, connectionId)) !== agentId) {
      log.warn({ agentId, connectionId }, 'An agent forwarded messages for a connection it does not serve');
      return 0;
    }
    const [connection] = await connectorRepo.load(db, [connectionId]);
    if (!connection || connection.manifest.transport.kind !== 'queue_tap' || !acceptsEvents(connection.status as ConnectionStatus)) return 0;
    const object = connection.manifest.objects[0];
    const retentionHours = await inboundRepo.retentionOf(db, connectionId);
    if (!object || retentionHours === null) return 0;
    let stored = 0;
    for (const message of messages.slice(0, 1_000)) {
      for (const record of await recordsFromWebhook(object, message)) {
        await inboundRepo.recordEvent(db, { organisationId, connectionId, objectName: object.name, payload: record, sourceLabel: String(message.subject).slice(0, 200), retentionHours });
        stored += 1;
      }
    }
    if (stored > 0) await inboundRepo.noteSeen(db, connectionId);
    return stored;
  });
}
