ALTER TABLE simulation_results DROP CONSTRAINT IF EXISTS simulation_results_probability_is_complete;
ALTER TABLE simulation_results DROP COLUMN IF EXISTS estimated;
ALTER TABLE simulation_results DROP COLUMN IF EXISTS delay_p90_hours;
ALTER TABLE simulation_results DROP COLUMN IF EXISTS delay_p10_hours;
ALTER TABLE scenarios DROP CONSTRAINT IF EXISTS scenarios_probabilistic_is_complete;
ALTER TABLE scenarios DROP COLUMN IF EXISTS iterations;
ALTER TABLE scenarios DROP COLUMN IF EXISTS horizon_hours;
ALTER TABLE edge_observations DROP COLUMN IF EXISTS quantiles;
