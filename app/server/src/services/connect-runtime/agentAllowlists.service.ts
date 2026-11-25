// Delivering the signed actuation allow-lists to the Silo Agents (spec 47.4; agent/internal/
// actuation). Each heartbeat names the lists the agent holds by digest; this replica compares
// them with the current lists of the agent's pool's connections and sends a connection's whole
// list (its entries' canonical texts and signatures, the control plane's) where they differ: a
// changed list, a new connection's, or an empty one for a connection whose entries were all
// removed, which was revoked, or which left the pool. A list sent is sent again only if the
// agent still has not taken it some seconds later. When the agent's digest first matches what
// was sent, the delivery is recorded (allowlist_delivered_to_agent).

import { createHash } from 'node:crypto';
import type { DownFrame } from '../../contracts/connect-runtime/agentTunnel.contract.ts';
import type { Logger } from '../../infra/logger.infra.ts';
import { inTransaction, type Databases } from '../../infra/postgres.infra.ts';
import { actuationAllowlistRepo } from '../../repos/action/index.repo.ts';
import { uuidv7 } from '../../utils/id.util.ts';
import { allowlistEntryText } from '../actions/allowlist.service.ts';
import { recordConnectEvent } from '../connect-registry/connectEvents.service.ts';

export interface AllowlistAgent {
  agentId: string;
  organisationId: string;
  poolId: string;
}

type SignedEntry = { entry: string; keyId: string; signature: string };

/** A list's digest: SHA-256, hex, of its entries' signatures sorted and joined by newlines (as the agent's). */
export function allowlistDigest(signatures: readonly string[]): string {
  return createHash('sha256').update([...signatures].sort().join('\n'), 'utf8').digest('hex');
}

const RESEND_MS = 10_000;

export function createAgentAllowlists(deps: { databases: Databases; logger: Logger; resendMs?: number; now?: () => number }) {
  const control = deps.databases.pool('control');
  const resendMs = deps.resendMs ?? RESEND_MS;
  const now = deps.now ?? Date.now;
  // Per agent, per connection: the digest last sent and when.
  const sent = new Map<string, Map<string, { digest: string | undefined; at: number }>>();

  return {
    /** A heartbeat: send what differs, record what has arrived. */
    async beat(agent: AllowlistAgent, send: (frame: DownFrame) => void, reported: readonly { connectionId: string; digest: string }[]): Promise<void> {
      const current = await inTransaction(control, { organisationId: agent.organisationId }, async (db) => {
        const lists = new Map<string, SignedEntry[]>();
        for (const row of await actuationAllowlistRepo.liveForPool(db, agent.poolId)) {
          const list = lists.get(row.connectionId) ?? [];
          list.push({ entry: allowlistEntryText(row), keyId: row.signatureKeyRef, signature: Buffer.from(row.signature).toString('base64url') });
          lists.set(row.connectionId, list);
        }
        return lists;
      }, { readOnly: true });
      const held = new Map(reported.map((r) => [r.connectionId, r.digest]));
      const mine = sent.get(agent.agentId) ?? new Map<string, { digest: string | undefined; at: number }>();
      sent.set(agent.agentId, mine);
      const delivered: { connectionId: string; entries: number; digest: string | null }[] = [];
      // Those sent and not yet seen taken too: an emptied list leaves both the current lists and the agent's.
      for (const connectionId of new Set([...current.keys(), ...held.keys(), ...mine.keys()])) {
        const entries = current.get(connectionId) ?? [];
        const digest = entries.length === 0 ? undefined : allowlistDigest(entries.map((e) => e.signature));
        const last = mine.get(connectionId);
        if (held.get(connectionId) === digest) {
          // Arrived: recorded once, for what this replica sent.
          if (last !== undefined && last.digest === digest) {
            delivered.push({ connectionId, entries: entries.length, digest: digest ?? null });
            mine.delete(connectionId);
          }
          continue;
        }
        if (last !== undefined && last.digest === digest && now() - last.at < resendMs) continue;
        if (last !== undefined && last.digest === digest) {
          deps.logger.warn('an agent has not taken the actuation allow-list sent to it', {
            event: 'agent.allowlist_not_taken', organisationId: agent.organisationId, resourceId: agent.agentId, connectionId,
          });
        }
        send({ type: 'allowlist', connectionId, entries });
        mine.set(connectionId, { digest, at: now() });
      }
      if (delivered.length === 0) return;
      await inTransaction(control, { organisationId: agent.organisationId }, async (db) => {
        for (const d of delivered) {
          await recordConnectEvent(db, {
            service: 'connect-runtime', organisationId: agent.organisationId, correlationId: uuidv7(), event: 'allowlist_delivered_to_agent',
            resourceType: 'agent', resourceId: agent.agentId, detail: { connection_id: d.connectionId, entries: d.entries, ...(d.digest === null ? {} : { digest: d.digest }) },
          });
        }
      });
    },

    /** The agent's tunnel closed: what was sent to it is forgotten, and sent again when it is back. */
    forget(agentId: string): void {
      sent.delete(agentId);
    },
  };
}

export type AgentAllowlists = ReturnType<typeof createAgentAllowlists>;
