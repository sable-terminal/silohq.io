REVOKE DELETE ON mutations FROM silo_app;

DELETE FROM approval_decisions WHERE request_id IN (SELECT id FROM approval_requests WHERE action = 'mutation.purge');
DELETE FROM approval_requests WHERE action = 'mutation.purge';
DELETE FROM approval_policies WHERE action = 'mutation.purge';

ALTER TABLE approval_requests DROP CONSTRAINT approval_requests_action_check;
ALTER TABLE approval_requests ADD CONSTRAINT approval_requests_action_check CHECK (action IN ('silo.purge'));

ALTER TABLE approval_policies DROP CONSTRAINT approval_policies_action_check;
ALTER TABLE approval_policies ADD CONSTRAINT approval_policies_action_check CHECK (action IN ('silo.purge'));

DELETE FROM role_permissions WHERE permission_id = 'mutation.purge';
DELETE FROM permissions WHERE id = 'mutation.purge';

ALTER TABLE organisations DROP COLUMN mutation_receipt_days;
