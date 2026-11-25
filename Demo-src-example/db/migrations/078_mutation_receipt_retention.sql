/*
 * 078 — how long a change's receipt is kept, and deleting one sooner.
 *
 * ── Its own retention, independent of storage ──────────────────────────────
 *
 * A receipt holds what every record it changed held before and after. That is
 * stored customer data, kept whether or not storage is switched on, because a
 * write that cannot be reviewed or reverted is the thing the mutation path
 * exists to prevent. So it is bounded the way stored data is: a window the
 * organisation chooses, never past 730 days, enforced by the retention sweep
 * and by every read, which treats a receipt past its window as gone.
 *
 * SHORTENING REACHES RECEIPTS ALREADY KEPT. `mutation_receipts.retain_until`
 * is the bound the receipt was written with; the organisation's window applies
 * on top of it, so a window cut from a year to a month ends every receipt older
 * than a month at once. Lengthening does not extend a receipt already written.
 *
 * ── Deleting one sooner ────────────────────────────────────────────────────
 *
 * `mutation.purge`, super admin only, like `silo.purge`: deleting a receipt
 * ends the ability to review or revert a change to somebody's systems. It
 * routes through the approval chain where the organisation has configured one
 * for it, which is the chain 066 built for exactly this kind of action.
 */

ALTER TABLE organisations
  ADD COLUMN mutation_receipt_days integer NOT NULL DEFAULT 365
    CHECK (mutation_receipt_days BETWEEN 1 AND 730);

INSERT INTO permissions (id, category, description, scopeable) VALUES
  ('mutation.purge', 'mutation', 'Delete the receipt of a change, and decide how long receipts are kept', false);

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, 'mutation.purge'
  FROM roles r
 WHERE r.system_role AND r.name = 'Super admin'
ON CONFLICT DO NOTHING;

ALTER TABLE approval_policies DROP CONSTRAINT approval_policies_action_check;
ALTER TABLE approval_policies ADD CONSTRAINT approval_policies_action_check
  CHECK (action IN ('silo.purge', 'mutation.purge'));

ALTER TABLE approval_requests DROP CONSTRAINT approval_requests_action_check;
ALTER TABLE approval_requests ADD CONSTRAINT approval_requests_action_check
  CHECK (action IN ('silo.purge', 'mutation.purge'));

/*
 * THE APPLICATION MAY NOW DELETE A MUTATION, and only for a purge. 073 kept
 * DELETE from it so that nothing but the sweep could make a change disappear;
 * a purge is the governed exception, checked and audited in the service, and
 * the row it removes takes its targets, prior state, chain, verifications and
 * receipt with it.
 */
GRANT DELETE ON mutations TO silo_app;
