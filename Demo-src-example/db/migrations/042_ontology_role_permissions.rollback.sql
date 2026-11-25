DELETE FROM role_permissions
 WHERE permission_id IN ('concept.confirm', 'marking.apply', 'outcome.designate');
