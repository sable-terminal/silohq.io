/*
 * 096 — a scheduled check that leaves a document behind.
 *
 * ── §4: "Produce an export and put it in Files, with the permissions of
 * whoever owns the automation" ─────────────────────────────────────────────
 *
 * §14 built this fourth and gated it on Files existing, which it now does. The
 * action writes nothing to a customer's systems: it produces a frozen result
 * and files it, which is the same act a person performs by hand.
 *
 * ── "WITH THE PERMISSIONS OF WHOEVER OWNS THE AUTOMATION" ─────────────────
 *
 * That phrase is already the export path's behaviour rather than something to
 * add here. Files §3 redacts an export to what the exporting person may see and
 * freezes their markings, policies and grants onto it — so running the export
 * AS THE OWNER is the whole of the requirement, and an automation cannot
 * produce a document containing anything its owner could not read.
 *
 * ── NO NEW PERMISSION ─────────────────────────────────────────────────────
 *
 * Automations §10 — `automation.create` covers "a notify or report action".
 * The owner still needs `file.export` at run time, checked inside the export
 * path against them as they are then, which is §6's rule: an owner who lost
 * that grant yesterday produces no report tonight.
 */

ALTER TABLE automation_actions
  DROP CONSTRAINT IF EXISTS automation_actions_kind_check;

ALTER TABLE automation_actions
  ADD CONSTRAINT automation_actions_kind_check
    CHECK (kind IN ('notify', 'mutate', 'escalate', 'report'));
