// The recognition audit events (spec 38.13). References, counts and statistics only.

export const RECOGNITION_EVENTS = [
  'detector_run', 'finding_raised', 'finding_dispositioned', 'threshold_tuned', 'associations_computed', 'outcome_designated',
  'ranking_produced', 'lens_created', 'lens_shared', 'lens_share_revoked',
  // Not named in 38.13: configuring a detector changes what every later run examines.
  'detector_configured',
] as const;
export type RecognitionEventName = (typeof RECOGNITION_EVENTS)[number];
