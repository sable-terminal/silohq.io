DROP INDEX IF EXISTS simulation_results_by_severity;
ALTER TABLE simulation_results DROP CONSTRAINT IF EXISTS simulation_results_degraded_has_a_cost;
ALTER TABLE simulation_results DROP COLUMN IF EXISTS degraded_costs;
ALTER TABLE simulation_results DROP COLUMN IF EXISTS severity;
ALTER TABLE dependency_edges DROP CONSTRAINT IF EXISTS dependency_edges_soft_states_its_cost;
ALTER TABLE dependency_edges DROP COLUMN IF EXISTS degraded_cost;
