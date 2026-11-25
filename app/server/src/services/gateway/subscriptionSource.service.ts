// Where live subscriptions are opened (spec 5.5, 30): the state plane, which resolves the
// set, joins or creates the subscription group for the viewer's permission fingerprint,
// takes the snapshot and publishes the group's frames on bus-live. The gateway names the
// subscription (so the snapshot addressed to it can be routed before the call returns)
// and fans the group's frames out to the sockets that hold it.
//
// statePlaneSource calls the state plane's subscription contracts with the holder's
// session as the request context. When the state plane cannot be reached the call fails,
// and the gateway refuses the subscription as unavailable: the canvas shows live updates
// paused (spec 7.4, state-plane "on failure"), never stale values as current.
// stateUnavailable refuses every subscription that way, for a cell without a state plane.

import type { SetReference } from '../../contracts/gateway/live.contract.ts';
import {
  closeLiveSubscription, openLiveSubscription, renewLiveSubscriptions, reportLiveBufferMode,
} from '../../contracts/state-plane/subscription.contract.ts';
import type { RequestContext } from '../../infra/postgres.infra.ts';
import type { ServiceClient } from '../../infra/serviceClient.infra.ts';
import { AppError } from '../../utils/errors.util.ts';

/** Whose subscription it is: from the session, never from the client. */
export interface LiveHolder {
  organisationId: string;
  membershipId: string;
  userId: string;
  sessionId: string;
}

export interface SubscribeRequest {
  /** Chosen by the gateway, unique in the cell. */
  subscriptionId: string;
  set: SetReference;
  properties: string[];
  /** The last sequence the client holds, for replay within the window (spec 30.6). */
  lastSeq: number | undefined;
}

export type SubscribeOutcome =
  | {
    outcome: 'subscribed';
    groupId: string;
    objectCount: number;
    sources: string[];
    fields: { granted: string[]; withheld: string[] };
    /** live; or polled by an admin's fallback, never live (decision 2026-11-15). */
    mode?: 'live' | 'polled' | undefined;
    refreshEverySeconds?: number | null | undefined;
  }
  | {
    outcome: 'refused';
    reason: 'bound' | 'unresolvable' | 'permission' | 'not_subscribable';
    bound?: string | undefined;
    limit?: number | undefined;
    count?: number | undefined;
  };

export interface SubscriptionSource {
  subscribe(holder: LiveHolder, request: SubscribeRequest, meta: { correlationId: string }): Promise<SubscribeOutcome>;
  unsubscribe(holder: LiveHolder, subscriptionId: string): Promise<void>;
  /**
   * Re-arms the subscribers (their TTL, spec 30) with the sequence each has applied, and
   * names those the state plane no longer holds (lapsed, or ended by a policy change).
   */
  renew(holder: LiveHolder, subscriptions: { subscriptionId: string; ackedSeq: number | undefined }[]): Promise<{ ended: string[] } | void>;
  /** A subscriber's buffer mode changed (spec 30.4); the state plane audits snapshot mode. */
  bufferMode?(holder: LiveHolder, subscriptionId: string, mode: 'snapshot' | 'live'): Promise<void>;
}

export const stateUnavailable: SubscriptionSource = {
  async subscribe() {
    throw new AppError('unavailable', 'live state is not available in this cell yet', { code: 'live.state_plane_unavailable', retryable: true });
  },
  async unsubscribe() {},
  async renew() {},
};

const contextOf = (holder: LiveHolder): RequestContext => ({
  organisationId: holder.organisationId, membershipId: holder.membershipId, userId: holder.userId, sessionId: holder.sessionId,
});

/** The state plane, over its contracts. */
export function statePlaneSource(services: ServiceClient): SubscriptionSource {
  return {
    async subscribe(holder, request, meta) {
      return services.call(openLiveSubscription, {
        body: {
          subscriptionId: request.subscriptionId, set: request.set, properties: request.properties,
          ...(request.lastSeq === undefined ? {} : { lastSeq: request.lastSeq }),
        },
      }, { request: contextOf(holder), correlationId: meta.correlationId, timeoutMs: 90_000 });
    },
    async unsubscribe(holder, subscriptionId) {
      await services.call(closeLiveSubscription, { params: { subscriptionId } }, { request: contextOf(holder) });
    },
    async bufferMode(holder, subscriptionId, mode) {
      await services.call(reportLiveBufferMode, { params: { subscriptionId }, body: { mode } }, { request: contextOf(holder) });
    },
    async renew(holder, subscriptions) {
      const ended: string[] = [];
      for (let i = 0; i < subscriptions.length; i += 100) {
        const reply = await services.call(renewLiveSubscriptions, {
          body: {
            subscriptions: subscriptions.slice(i, i + 100).map((s) => ({
              subscriptionId: s.subscriptionId, ...(s.ackedSeq === undefined ? {} : { ackedSeq: s.ackedSeq }),
            })),
          },
        }, { request: contextOf(holder) });
        ended.push(...reply.ended);
      }
      return { ended };
    },
  };
}
