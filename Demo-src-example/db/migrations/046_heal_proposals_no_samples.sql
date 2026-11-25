-- 046_heal_proposals_no_samples — the one place the no-data-stored claim broke.
--
-- ── What was being written ──────────────────────────────────────────────────
--
-- Self-heal re-reads a source to see whether its shape has drifted. To judge
-- whether two fields still MEAN the same thing it carries a few live values per
-- field — `sample: values.slice(0, 20)` — and that is legitimate: the samples
-- are the evidence, and they exist for the length of the comparison.
--
-- Then `handle()` wrote the whole `FieldShape` into `heal_proposals.proposed_diff`
-- for a type change, samples included. Up to twenty live values from the drifted
-- column — a salary, a balance, a patient identifier, whatever that field holds
-- — serialised into a jsonb column with no expiry, no bounding CHECK and no
-- sweep. They sat there permanently, and the table grew on its own every time a
-- source changed.
--
-- Every other branch of the same switch writes a path and a type and nothing
-- else. This was one branch, and it contradicted a claim made on a public page.
--
-- ── Two halves ─────────────────────────────────────────────────────────────
--
-- The service no longer puts samples in the diff. That fixes tomorrow. This
-- scrubs what is already written, and then makes it impossible to write again —
-- because a policy saying "do not store values" is a policy, and a schema with
-- nowhere to put them is a guarantee. 019 makes exactly this argument about
-- discovery, and self-heal was the subsystem that did not get the memo.

/*
 * SCRUB FIRST, THEN CONSTRAIN, because the CHECK is validated against existing
 * rows and would refuse to be added while any of them carries a sample.
 *
 * `#-` removes a path if present and is a no-op if not, so this is safe on rows
 * that never had one.
 */
UPDATE heal_proposals
   SET proposed_diff = (proposed_diff #- '{before,sample}') #- '{after,sample}'
 WHERE proposed_diff #> '{before,sample}' IS NOT NULL
    OR proposed_diff #> '{after,sample}' IS NOT NULL;

/*
 * `before` and `after` are the only keys that ever held a `FieldShape`, and a
 * shape is the only thing in this column that ever carried values. Naming the
 * two paths rather than walking the whole document keeps the constraint cheap
 * and keeps it readable — a reviewer can see exactly what is forbidden.
 */
ALTER TABLE heal_proposals
  ADD CONSTRAINT heal_proposals_no_samples CHECK (
    proposed_diff #> '{before,sample}' IS NULL
    AND proposed_diff #> '{after,sample}' IS NULL
  );
