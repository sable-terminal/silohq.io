DELETE FROM role_permissions WHERE permission_id = 'graph.confirm';
DELETE FROM permissions WHERE id = 'graph.confirm';
DROP TABLE IF EXISTS edge_revisions;
