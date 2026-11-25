/*
 * 086 — an automation that watches the checks instead of a question.
 *
 * ── §3: "with no question to author at all" ────────────────────────────────
 *
 * "Finding condition... This is the most powerful of the three, because the
 * checks already run and the automation becomes 'tell me when this kind of
 * problem appears', with no question to author at all."
 *
 * 085 made `saved_view_id` NOT NULL, which forbids exactly that. The fix is not
 * to relax the column and hope: it is to say which of the two things an
 * automation is, so the shape is readable from the row.
 *
 * ── `source` RATHER THAN A NULLABLE COLUMN AND A CONVENTION ────────────────
 *
 * A nullable `saved_view_id` alone would leave "which kind is this" to be
 * inferred from whether a join found anything, and a bug that dropped the view
 * would look identical to a finding automation. The constraint below makes the
 * two states exclusive and checkable: a view automation has a view, a findings
 * automation has none, and neither can be half-configured.
 *
 * ── WHY THERE IS NO `automation_conditions` CHANGE ─────────────────────────
 *
 * The condition table already admits `kind = 'finding'` with a `target` and a
 * jsonb `value`. 085 built the column and refused to evaluate it; this
 * migration does not widen the schema, it widens what the engine will answer.
 */

ALTER TABLE automations
  ALTER COLUMN saved_view_id DROP NOT NULL;

ALTER TABLE automations
  ADD COLUMN source text NOT NULL DEFAULT 'view' CHECK (source IN ('view', 'findings'));

ALTER TABLE automations
  ADD CONSTRAINT automations_source_matches_view CHECK (
    (source = 'view'     AND saved_view_id IS NOT NULL) OR
    (source = 'findings' AND saved_view_id IS NULL)
  );

/*
 * The sweep reads these by detector and concept. Partial, because a findings
 * automation is the rarer of the two and the index should not be carried by
 * every view automation in the table.
 */
CREATE INDEX automations_watching_findings ON automations (organisation_id)
  WHERE source = 'findings';
