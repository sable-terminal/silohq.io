// The periodic session check behind open WebSockets (spec 60: revocation takes effect on
// the next request; for a socket, within LIMITS.statePlane.revocationCloseSeconds). The
// check is keep-alive traffic, so it does not move the idle clock: a person who does
// nothing is signed out on time however many sockets stay open. Sockets of one session
// on a pod share one check per interval.

import type { ServiceClient } from '../../infra/serviceClient.infra.ts';
import { uuidv7 } from '../../utils/id.util.ts';
import { resolveEdgeSession } from './forwarding.service.ts';

export interface SessionChecks {
  /** Rejects as the auth service does: auth.session_invalid once the session has ended. */
  check(sessionId: string, token: string): Promise<void>;
}

export function createSessionChecks(services: ServiceClient, shareMs: number): SessionChecks {
  const recent = new Map<string, { at: number; result: Promise<void> }>();
  return {
    check(sessionId, token) {
      const now = Date.now();
      for (const [id, entry] of recent) if (now - entry.at >= shareMs) recent.delete(id);
      const shared = recent.get(sessionId);
      if (shared !== undefined) return shared.result;
      const result = resolveEdgeSession(services, token, 'websocket_heartbeat', { correlationId: uuidv7() }).then(() => undefined);
      recent.set(sessionId, { at: now, result });
      result.catch(() => recent.delete(sessionId));
      return result;
    },
  };
}
