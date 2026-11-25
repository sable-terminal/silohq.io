// The change-stream audit events (spec 18.10), as audit_event names: references and counts
// only. A reviewer reads cdc_slot_created first: a change Silo made to a customer database.

export const CHANGE_STREAM_EVENTS = [
  'stream_enabled', 'stream_disabled', 'stream_paused', 'stream_resumed', 'webhook_registered', 'webhook_secret_rotated',
  'webhook_signature_rejected', 'cdc_slot_created', 'cdc_slot_lost', 'cdc_slot_dropped', 'stream_delayed', 'stream_stale',
  'stream_recovered', 'stream_backfill_completed', 'stream_coalesced',
  // An admin letting a stream that is not subscribable be polled instead (decision 2026-11-15).
  'polling_fallback_enabled', 'polling_fallback_disabled',
] as const;
export type ChangeStreamEvent = (typeof CHANGE_STREAM_EVENTS)[number];

/**
 * The state plane's (spec 24.9, 30, 32.7). source_declared_stale is read first: each time clones
 * stopped being current, for which source, how many objects; source_recovered says how long.
 * subscription_projection_changed: a policy change narrowed (or ended) what a subscriber sees.
 */
export const STATE_PLANE_EVENTS = ['subscription_refused_bound', 'source_declared_stale', 'source_recovered', 'subscription_projection_changed',
  // The organisation's live bound changed with its contract (9.5: contractual on Enterprise), from and to.
  'live_bounds_changed'] as const;

/**
 * Per subscription (spec 32.7; the high-volume class, 63.4): a live subscription opened and
 * closed, naming its set, its source connection and object, and counts, never the set's
 * contents. The AI FDE's time to first live clone reads the first live one (54.1).
 */
export const STATE_PLANE_HIGH_VOLUME_EVENTS = ['subscription_opened', 'subscription_closed', 'subscription_resynced', 'subscription_snapshot_mode'] as const;
