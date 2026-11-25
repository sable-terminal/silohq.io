// Fleet's own events (spec 11.6): "release_built release_signed release_promoted
// release_expedited rollout_started rollout_gate_failed rollout_rolled_back rollout_completed
// migration_applied bundle_verified bundle_refused sovereign_release_countersigned
// change_freeze_set ... rollout_gate_failed is read first: it shows gates acted. Events
// affecting a single-tenant install are also written to its audit log."
//
// The global tier has no organisation's audit log to write to, so fleet-control keeps its own:
// fleet.events, appended in the transaction that made the change and never changed. Each
// event's hash covers the one before it, so an event altered, removed or inserted out of
// order breaks the chain from there; appends hold fleet-control's lock, so the chain has one
// order. Events about one dedicated cell carry its id, and its Fleet agent reads them
// (listCellEvents) to write into its customer's audit log.

import { createHash } from 'node:crypto';
import type { FleetEventName } from '../../contracts/fleet-control/events.contract.ts';
import { canonicalJson } from '../../utils/canonicalJson.util.ts';

export type FleetEvent = FleetEventName;

export interface FleetEventBody {
  event: FleetEvent;
  occurredAt: string;
  releaseId: string | null;
  rolloutId: string | null;
  cellId: string | null;
  channel: string | null;
  operatorId: string | null;
  /** References and counts only, scalars. */
  detail: Record<string, string | number | boolean | null>;
}

/** SHA-256 over the previous event's hash (none for the first) and the canonical JSON of this one. */
export function eventHash(previous: Buffer | null, body: FleetEventBody): Buffer {
  return createHash('sha256').update(previous ?? Buffer.alloc(0)).update(canonicalJson({
    event: body.event, occurredAt: new Date(Date.parse(body.occurredAt)).toISOString(), releaseId: body.releaseId, rolloutId: body.rolloutId,
    cellId: body.cellId, channel: body.channel, operatorId: body.operatorId, detail: body.detail,
  })).digest();
}

/**
 * Whether events, in sequence order, chain: each names the hash before it and its own hash is
 * what its content gives. The first is checked against what came before it (null: the start).
 */
export function chainBreak(events: readonly (FleetEventBody & { seq: number; previousHash: Buffer | null; hash: Buffer })[], before: Buffer | null)
  : number | null {
  let previous = before;
  for (const e of events) {
    const linked = previous === null ? e.previousHash === null : e.previousHash !== null && e.previousHash.equals(previous);
    if (!linked || !eventHash(e.previousHash, e).equals(e.hash)) return e.seq;
    previous = e.hash;
  }
  return null;
}
