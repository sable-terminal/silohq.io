DROP TABLE mutation_reverts;

DELETE FROM role_permissions WHERE permission_id = 'mutation.revert';
DELETE FROM permissions WHERE id = 'mutation.revert';
