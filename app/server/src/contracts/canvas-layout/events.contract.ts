// The Clone Canvas and rendering audit events (spec 31.9, 32.7) that canvas-layout raises.
// They travel as the audit service's audit_event (contracts/audit/auditEvent.contract.ts),
// whose catalogue lists these names. References and counts only: a canvas view is named
// by id, a state rule by id and version, never by a property value.
//
// Live subscription events (subscription_*, source_declared_stale, source_recovered) are
// the state plane's and listed with it. canvas_view_updated, canvas_view_archived and
// clone_layout_set are not in spec 32.7: each is a change a reviewer must be able to see.

export const CLONE_EVENTS = [
  // Canvas views (29.10)
  'canvas_view_saved', 'canvas_view_updated', 'canvas_view_archived', 'canvas_view_shared', 'canvas_view_share_revoked',
  'canvas_view_opened_with_reduced_permissions', 'canvas_exported',
  // Layouts (29.2, 29.8)
  'layout_overridden', 'layout_precomputed', 'clone_layout_set',
  // State rules and staleness (28.4, 28.5)
  'state_rule_proposed', 'state_rule_confirmed', 'state_rule_revised', 'state_rule_retired', 'staleness_threshold_changed',
  // Estate map (32.4)
  'estate_snapshot_taken',
  // Rendering (31.9)
  'archetype_overridden',
  // Spatial plans, 3D asset models and anchors (29.4, 29.5, 32.x; D208)
  'spatial_plan_uploaded', 'spatial_plan_purged', 'asset_model_uploaded', 'asset_model_rejected', 'asset_model_purged', 'spatial_anchor_set', 'spatial_anchor_removed',
  // Compare two times (30.8; D208): over Capture, or refused without it
  'time_compared', 'time_compare_refused_no_capture',
  // A scenario overlaid on a view its opener may see (30.9; D208)
  'scenario_overlaid',
] as const;
export type CloneEventName = (typeof CLONE_EVENTS)[number];

/** Frequent, per open or per selection (spec 63.4, the high-volume class). */
export const CLONE_HIGH_VOLUME_EVENTS = [
  'clone_opened', 'clone_set_opened', 'layout_selected', 'archetype_selected', 'representation_switched', 'element_drilled',
  'flag_opened', 'estate_map_opened',
] as const;
export type CloneHighVolumeEventName = (typeof CLONE_HIGH_VOLUME_EVENTS)[number];
