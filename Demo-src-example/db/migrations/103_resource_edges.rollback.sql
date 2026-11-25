ALTER TABLE simulation_results DROP CONSTRAINT IF EXISTS simulation_results_contention_is_complete;
ALTER TABLE simulation_results DROP COLUMN IF EXISTS clearance_hours;
ALTER TABLE simulation_results DROP COLUMN IF EXISTS contending_records;
ALTER TABLE dependency_edges DROP CONSTRAINT IF EXISTS dependency_edges_resource_states_capacity;
ALTER TABLE dependency_edges DROP CONSTRAINT IF EXISTS dependency_edges_capacity_has_unit;
ALTER TABLE dependency_edges DROP COLUMN IF EXISTS capacity_unit;
ALTER TABLE dependency_edges DROP COLUMN IF EXISTS capacity_value;
