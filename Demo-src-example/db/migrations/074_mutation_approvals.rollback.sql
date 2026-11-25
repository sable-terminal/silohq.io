DROP TRIGGER mutation_approvals_self ON mutation_approvals;
DROP FUNCTION mutation_approvals_self();
DROP TABLE mutation_approvals;

DROP TRIGGER mutation_chains_snapshot ON mutation_chains;
DROP FUNCTION mutation_chains_snapshot();
DROP TABLE mutation_chains;

DELETE FROM mutations WHERE status <> 'previewed';
ALTER TABLE mutations DROP CONSTRAINT mutations_status_check;
ALTER TABLE mutations ADD CONSTRAINT mutations_status_check CHECK (status IN ('previewed'));

DROP TABLE mutation_policy_floors;
DROP TABLE mutation_policies;

DELETE FROM role_permissions WHERE permission_id = 'mutation.policy';
DELETE FROM permissions WHERE id = 'mutation.policy';
