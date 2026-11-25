/*
 * 088 — an automation may propose a change.
 *
 * ── §5: propose, and only propose ──────────────────────────────────────────
 *
 * "The automation prepares the mutation, computes the preview and diff, and
 * places it in the approvals queue. A person approves it before anything is
 * written. Default."
 *
 * So the CHECK admits `mutate` and the automation gains no ability to write.
 * Everything downstream of the proposal is the mutation path the product
 * already has: preview, diff, approval by a named person, receipt, undo. §1 —
 * "An automation removes the need to remember, not the need to approve."
 *
 * ── `automation_authorisations` IS STILL ABSENT ────────────────────────────
 *
 * That table belongs to execute-within-bounds, §14's last step and "the only
 * unattended write in the product". A proposal needs no authorisation to
 * record, because the authorisation IS the approval a person gives afterwards.
 *
 * ── TWO PERMISSIONS, AND §10 IS EXPLICIT ABOUT WHY ────────────────────────
 *
 * "Attaching a mutate action also requires mutation.propose on the connections
 * involved. The automation permission governs the schedule; the mutation
 * permission governs the change." `automation.mutate` is therefore not a way
 * to make changes somebody could not make by hand — it is permission to have
 * them made on a timer.
 */

ALTER TABLE automation_actions
  DROP CONSTRAINT IF EXISTS automation_actions_kind_check;

ALTER TABLE automation_actions
  ADD CONSTRAINT automation_actions_kind_check CHECK (kind IN ('notify', 'mutate'));

/*
 * §12 — the run record says what each action did. A proposal's outcome is the
 * mutation it queued, and that id is how somebody reading the history gets from
 * "it fired" to "here is what it wants to change".
 */
INSERT INTO permissions (id, category, description, scopeable) VALUES
  ('automation.mutate', 'automation', 'Attach a change to a scheduled check, for approval', true);

/*
 * NOT GRANTED TO `Member`, UNLIKE `automation.create`. Creating a check that
 * watches and tells is an ordinary thing to do; creating one that queues
 * changes for somebody else to approve puts work into another person's queue
 * on a schedule, which is an administrative act even though nothing it makes
 * can be written without a human.
 */
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, 'automation.mutate'
  FROM roles r
 WHERE r.system_role AND r.name IN ('Super admin', 'Admin')
ON CONFLICT DO NOTHING;
