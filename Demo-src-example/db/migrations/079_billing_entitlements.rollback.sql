DELETE FROM role_permissions WHERE permission_id = 'billing.view';
DELETE FROM permissions WHERE id = 'billing.view';

DROP TRIGGER entitlements_closed_once ON entitlements;
DROP FUNCTION entitlements_closed_once();
DROP TABLE entitlements;

DROP TABLE subscriptions;
