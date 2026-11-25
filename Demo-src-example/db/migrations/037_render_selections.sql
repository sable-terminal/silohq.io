-- 037_render_selections — which archetype was chosen, and whether the person
-- disagreed.
--
-- ── Why this is worth a table ───────────────────────────────────────────────
--
-- §7.3 makes archetype selection a fixed precedence rather than a best guess, so
-- the same result always draws the same way. The corollary is that when the
-- precedence is wrong, it is wrong the same way every time — and the only
-- evidence of that is somebody reaching for the alternatives.
--
-- A RATE OF OVERRIDE IS THE ONLY SIGNAL THE PRECEDENCE IS MISORDERED. Without
-- this row, "people keep switching chains to hierarchies" is an anecdote
-- somebody mentions in a call. With it, it is a number.
--
-- ── It does not change the selection ───────────────────────────────────────
--
-- Nothing reads this table to pick an archetype, and nothing should. §7.3's
-- whole value is that selection is deterministic: a result that drew as a
-- ranking yesterday draws as a ranking today, and a learned override would make
-- the drawing depend on who had been looking at it. This records; the precedence
-- decides.
--
-- ── No values ──────────────────────────────────────────────────────────────
--
-- The archetype names, the result's reference, and who overrode it. Nothing
-- about what the result contained — the same line §6.1 draws, for the same
-- reason: this is the learned layer's neighbour and it must not become the
-- place data leaks into.

CREATE TABLE render_selections (
  id              uuid        PRIMARY KEY,
  organisation_id uuid        NOT NULL REFERENCES organisations(id) ON DELETE RESTRICT,

  /*
   * WHAT WAS DRAWN, BY REFERENCE. Text rather than a foreign key because a
   * result is not a row in this database — it is the answer to a question,
   * which exists for as long as somebody is looking at it. The caller's own
   * handle for it is the only durable thing there is to record.
   */
  result_ref      text        NOT NULL CHECK (length(trim(result_ref)) BETWEEN 1 AND 128),

  /*
   * THE TEN OF §7, AS A CHECK. The set is closed by the spec — `table` is the
   * floor and is always among the alternatives, which is what makes §7.4's
   * guarantee that any result renders true rather than hoped for.
   */
  chosen          text        NOT NULL CHECK (chosen IN (
                                'chain', 'network', 'hierarchy', 'series', 'ranking',
                                'distribution', 'comparison', 'composition', 'figure', 'table')),

  /*
   * THE OTHERS THAT ALSO FIT, in precedence order. §7.3 — results routinely fit
   * several, and the ones that did are what make an override interpretable: a
   * person choosing something that was offered is a preference, and choosing
   * something that was not is the structure having been read wrong.
   */
  alternatives    text[]      NOT NULL DEFAULT '{}',

  /** Null until somebody disagrees, which is the event worth waiting for. */
  overridden_to   text        CHECK (overridden_to IS NULL OR overridden_to IN (
                                'chain', 'network', 'hierarchy', 'series', 'ranking',
                                'distribution', 'comparison', 'composition', 'figure', 'table')),

  /*
   * §6.2's argument again: which drawing suits a question is a matter of what
   * somebody is looking for, and two people reading the same result want
   * different pictures of it.
   */
  membership_id   uuid        NOT NULL REFERENCES memberships(id) ON DELETE RESTRICT,

  selected_at     timestamptz NOT NULL DEFAULT now(),
  overridden_at   timestamptz,

  CONSTRAINT render_selections_override_pair CHECK (
    (overridden_to IS NULL) = (overridden_at IS NULL)
  ),
  /* An override to what was already chosen is not an override. */
  CONSTRAINT render_selections_override_differs CHECK (
    overridden_to IS NULL OR overridden_to <> chosen
  ),
  CONSTRAINT render_selections_one_per_result UNIQUE (membership_id, result_ref)
);

CREATE INDEX render_selections_overridden
  ON render_selections (organisation_id, chosen, overridden_to)
  WHERE overridden_to IS NOT NULL;

-- ── Row level security ──────────────────────────────────────────────────────

ALTER TABLE render_selections ENABLE ROW LEVEL SECURITY;
ALTER TABLE render_selections FORCE  ROW LEVEL SECURITY;

CREATE POLICY render_selections_tenant ON render_selections
  USING (organisation_id = app_org_id())
  WITH CHECK (organisation_id = app_org_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON render_selections TO silo_app;
