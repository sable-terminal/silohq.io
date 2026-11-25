DELETE FROM permissions WHERE id IN ('silo.create', 'silo.manage', 'silo.purge');
DROP TABLE IF EXISTS purge_receipts;
DROP TABLE IF EXISTS transitions;
DROP TABLE IF EXISTS silo_baselines;
DROP TABLE IF EXISTS silo_concepts;
DROP TABLE IF EXISTS siloes;
