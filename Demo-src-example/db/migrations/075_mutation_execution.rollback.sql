DROP TABLE mutation_receipts;
DROP TABLE mutation_verifications;
DROP TABLE mutation_executions;

ALTER TABLE mutations DROP COLUMN canary_confirmed_by;
ALTER TABLE mutations DROP COLUMN canary_confirmed_at;
ALTER TABLE mutations DROP COLUMN executed_by;
ALTER TABLE mutations DROP COLUMN claimed_at;

DELETE FROM mutations WHERE status IN ('executing', 'canary_paused', 'executed', 'partially_executed', 'failed');
ALTER TABLE mutations DROP CONSTRAINT mutations_status_check;
ALTER TABLE mutations ADD CONSTRAINT mutations_status_check
  CHECK (status IN ('previewed', 'awaiting_approval', 'approved', 'rejected'));

DELETE FROM role_permissions WHERE permission_id = 'mutation.execute';
DELETE FROM permissions WHERE id = 'mutation.execute';
