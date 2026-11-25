DELETE FROM role_permissions WHERE permission_id = 'graph.propose';
DELETE FROM permissions WHERE id = 'graph.propose';
DROP TABLE IF EXISTS dependency_edges;
