DELETE FROM role_permissions WHERE permission_id IN ('simulation.run', 'simulation.share');
DELETE FROM permissions WHERE id IN ('simulation.run', 'simulation.share');
DROP TABLE IF EXISTS simulation_results;
DROP TABLE IF EXISTS simulation_runs;
DROP TABLE IF EXISTS scenarios;
DROP INDEX IF EXISTS dependency_edges_walkable;
CREATE INDEX dependency_edges_walkable
  ON dependency_edges (from_concept_id)
  WHERE confirmed_at IS NOT NULL AND retired_at IS NULL;
