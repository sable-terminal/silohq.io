/*
 * 084 — a question, kept.
 *
 * ── §7: "A result can be saved as a view" ──────────────────────────────────
 *
 * A saved view re-executes on demand or on schedule at no metered cost. That
 * sentence is the commercial model as much as the feature: compiling is
 * metered because a model runs; re-running is free because none does. Every
 * saved view therefore increases what an account is worth without increasing
 * what it costs to serve, and this table is where that becomes true.
 *
 * ── THE QUESTION, NOT THE ANSWER ───────────────────────────────────────────
 *
 * `query` is the compiled ConceptQuery — select, where, sort, limit, aggregate
 * — and nothing here holds a row, a value or a result. A view that cached its
 * answer would be a copy of customer data in the control plane, which is the
 * one thing this architecture says it does not keep, and it would go stale in
 * a way nobody could see.
 *
 * ── THE CONCEPT IS A FOREIGN KEY, AND RESTRICT IS THE POINT ────────────────
 *
 * A view whose concept was deleted is a question that can no longer be asked.
 * Cascading would delete somebody's saved work as a side effect of ontology
 * tidying; restricting makes retiring a concept say out loud what it would
 * break. §8 of Automations relies on this: an automation sits on a view, and a
 * concept being retired is named there as a failure the owner is told about.
 *
 * ── OWNER-ONLY, FOR NOW, AND DELIBERATELY ──────────────────────────────────
 *
 * §7 says a view is shareable on the same terms as maps. `map_shares` is the
 * precedent, `view.share` is already a catalogued permission, and the audit
 * catalogue already declares `view_shared`, `view_share_expired`,
 * `view_transferred`, `view_transfer_reviewed` and
 * `view_opened_with_reduced_permissions`. None of that is built here: sharing
 * brings expiry, transfer with review, and computing which elements a second
 * reader cannot see at the moment they open it, and that is a feature rather
 * than a column. What is here is what an automation needs — a question that
 * exists and can be re-run.
 */

CREATE TABLE saved_views (
  id                  uuid        PRIMARY KEY,
  organisation_id     uuid        NOT NULL REFERENCES organisations(id) ON DELETE RESTRICT,

  /* §6.2's rule, as maps already have it: a membership, not a user. */
  owner_membership_id uuid        NOT NULL REFERENCES memberships(id) ON DELETE RESTRICT,

  name                text        NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 128),

  concept_id          uuid        NOT NULL REFERENCES concepts(id) ON DELETE RESTRICT,

  /* The compiled question. Never an answer, never a row. */
  query               jsonb       NOT NULL,

  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),

  /* One name per person, so a sidebar of saved views has no two the same. */
  UNIQUE (owner_membership_id, name)
);

CREATE INDEX saved_views_by_owner ON saved_views (owner_membership_id, updated_at DESC);
CREATE INDEX saved_views_by_concept ON saved_views (concept_id);

ALTER TABLE saved_views ENABLE ROW LEVEL SECURITY;
ALTER TABLE saved_views FORCE  ROW LEVEL SECURITY;
CREATE POLICY saved_views_tenant ON saved_views
  USING (organisation_id = app_org_id()) WITH CHECK (organisation_id = app_org_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON saved_views TO silo_app;
