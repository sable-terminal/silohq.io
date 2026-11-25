// The simulation audit events (spec 39.12). References, counts and statistics only.
// simulation_crossed_unconfirmed_edge matters most: its rate is the only measure of
// whether the dependency graph is complete enough to trust.

export const SIMULATION_EVENTS = [
  'graph_edge_proposed', 'graph_edge_confirmed', 'graph_edge_revised', 'graph_edge_retired', 'simulation_run', 'simulation_bounded',
  'simulation_crossed_unconfirmed_edge', 'scenario_saved', 'scenario_shared', 'scenario_compared', 'branch_created', 'action_staged',
  'branch_staleness_detected', 'branch_compared', 'staged_action_promoted',
  // 30.9 (D208): promoted from a canvas view overlaying the scenario.
  'staged_action_promoted_from_canvas',
] as const;
export type SimulationEventName = (typeof SIMULATION_EVENTS)[number];
