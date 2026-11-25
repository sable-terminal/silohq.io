/*
 * 107 — which of the three a person wants for this view.
 *
 * ── §2: "The user's choice persists PER VIEW, NOT GLOBALLY" ───────────────
 *
 * "Someone who prefers rows for one thing may want the picture for another."
 *
 * So the key is the pair, and that is the whole design of this table. A single
 * column on `memberships` would be the global setting §2 rules out, and it
 * would be wrong in the ordinary case rather than the rare one: the person who
 * reads their reconciliation as a table and their pipeline as a chain is the
 * normal user, not an edge case.
 *
 * ── §10: "Nothing else" ───────────────────────────────────────────────────
 *
 * "view_preferences — view, membership, preferred representation." Three
 * columns and the housekeeping. No result, no archetype — the archetype is the
 * precedence's to decide from structure, and a preference that could pin one
 * would be an override by another name, recorded nowhere §4.3 can read it.
 */

CREATE TABLE view_preferences (
  organisation_id uuid        NOT NULL REFERENCES organisations(id) ON DELETE RESTRICT,
  view_id         uuid        NOT NULL REFERENCES saved_views(id) ON DELETE CASCADE,
  membership_id   uuid        NOT NULL REFERENCES memberships(id) ON DELETE RESTRICT,

  /* §2's three, and there is no fourth. */
  representation  text        NOT NULL CHECK (representation IN ('prose', 'view', 'data')),

  chosen_at       timestamptz NOT NULL DEFAULT now(),

  /*
   * ONE PREFERENCE PER PERSON PER VIEW, as the primary key rather than as a
   * unique index on a surrogate id. There is nothing else to identify a row
   * here by: a preference is not an event and keeping a history of what
   * somebody used to prefer is a table that grows with every tab switch.
   */
  PRIMARY KEY (view_id, membership_id)
);

CREATE INDEX view_preferences_by_member ON view_preferences (membership_id);

ALTER TABLE view_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE view_preferences FORCE  ROW LEVEL SECURITY;
CREATE POLICY view_preferences_tenant ON view_preferences
  USING (organisation_id = app_org_id()) WITH CHECK (organisation_id = app_org_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON view_preferences TO silo_app;
