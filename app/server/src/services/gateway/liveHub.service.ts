// Live fan-out on one gateway pod (spec 7.3: "live clone fan-out"; 9.2). The pod listens
// on sub.<organisation>.* for each organisation with an open socket, once however many
// sockets it holds, and routes each group frame to the local subscriptions of that
// group, or, for a frame addressed to one subscription (its snapshot), to that one.
//
// A subscription is claimed before the state plane is asked for it, so a snapshot
// published while the call is in flight is routed rather than lost; it joins its group
// when the state plane names it. The subject is authoritative: a frame whose group is
// not the subject's is dropped. At most once (spec 9.1): a lost frame shows as a
// sequence gap, and the client asks for a resync.

import { liveGroupFrame, liveResyncRequest, type GroupFrame } from '../../contracts/gateway/live.contract.ts';
import { liveSubjects, type LiveBus } from '../../infra/bus.infra.ts';
import type { Logger } from '../../infra/logger.infra.ts';

export interface HubMember {
  readonly subscriptionId: string;
  deliver(frame: GroupFrame): void;
}

export interface Claim {
  join(groupId: string): void;
  release(): void;
}

export interface LiveHub {
  /** Receives the organisation's frames until released; resolves once the bus has the subscription. */
  watch(organisationId: string): Promise<() => void>;
  claim(organisationId: string, member: HubMember): Claim;
  requestResync(organisationId: string, groupId: string, subscriptionId: string, lastSeq: number | undefined): void;
  /** Organisations watched, for tests and metrics. */
  readonly watched: number;
}

interface Watched {
  refs: number;
  ready: Promise<void>;
  stop: () => void;
  bySubscription: Map<string, { member: HubMember; groupId: string | undefined }>;
  byGroup: Map<string, Set<HubMember>>;
}

export function createLiveHub(bus: LiveBus, logger: Logger): LiveHub {
  const organisations = new Map<string, Watched>();

  const deliver = (member: HubMember, frame: GroupFrame): void => {
    try {
      member.deliver(frame);
    } catch (error) {
      logger.failure('a live frame could not be delivered', error, { event: 'live.deliver_failed', subscriptionId: member.subscriptionId });
    }
  };

  return {
    async watch(organisationId) {
      let entry = organisations.get(organisationId);
      if (entry === undefined) {
        const bySubscription: Watched['bySubscription'] = new Map();
        const byGroup: Watched['byGroup'] = new Map();
        const stop = bus.subscribe(liveGroupFrame, liveSubjects.subscriptionsOf(organisationId), (message, subject) => {
          if (subject !== liveSubjects.subscription(organisationId, message.group)) return;
          if (message.subscription !== undefined) {
            const claimed = bySubscription.get(message.subscription);
            if (claimed !== undefined && (claimed.groupId === undefined || claimed.groupId === message.group)) deliver(claimed.member, message.frame);
            return;
          }
          for (const member of byGroup.get(message.group) ?? []) deliver(member, message.frame);
        });
        entry = { refs: 0, ready: bus.flush(), stop, bySubscription, byGroup };
        organisations.set(organisationId, entry);
      }
      const watched = entry;
      watched.refs += 1;
      await watched.ready;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        watched.refs -= 1;
        if (watched.refs === 0 && organisations.get(organisationId) === watched) {
          watched.stop();
          organisations.delete(organisationId);
        }
      };
    },

    claim(organisationId, member) {
      const entry = organisations.get(organisationId);
      if (entry === undefined) throw new TypeError('claim a subscription only while its organisation is watched');
      const claimed = { member, groupId: undefined as string | undefined };
      entry.bySubscription.set(member.subscriptionId, claimed);
      return {
        join(groupId) {
          claimed.groupId = groupId;
          const members = entry.byGroup.get(groupId) ?? new Set<HubMember>();
          members.add(member);
          entry.byGroup.set(groupId, members);
        },
        release() {
          if (entry.bySubscription.get(member.subscriptionId) === claimed) entry.bySubscription.delete(member.subscriptionId);
          if (claimed.groupId === undefined) return;
          const members = entry.byGroup.get(claimed.groupId);
          members?.delete(member);
          if (members?.size === 0) entry.byGroup.delete(claimed.groupId);
        },
      };
    },

    requestResync(organisationId, groupId, subscriptionId, lastSeq) {
      bus.publish(liveResyncRequest, liveSubjects.resync(organisationId, groupId), {
        group: groupId, subscription: subscriptionId, ...(lastSeq === undefined ? {} : { lastSeq }),
      });
    },

    get watched() {
      return organisations.size;
    },
  };
}
