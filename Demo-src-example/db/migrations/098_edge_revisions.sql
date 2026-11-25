/*
 * 098 — a decision a person made, and what it replaced.
 *
 * ── §2.3: "Edges are revisable, with revisions recorded" ───────────────────
 *
 * "A lead time that was true in March may not be in September."
 *
 * So a confirmed edge is not immutable — it is REVISABLE, which is a different
 * and harder thing. Immutability would be easy and wrong: the graph describes
 * an operation that changes, and an edge nobody can correct becomes an edge
 * everybody works around.
 *
 * What makes revision safe rather than corrosive is that the old state does not
 * disappear. §5 — "An edge confirmed differently since means the two results
 * are not comparable, and the product says so rather than letting someone
 * compare them." That sentence needs a row to rest on, and this is it.
 *
 * ── WHY A REASON IS REQUIRED ON A REVISION AND NOT ON A CONFIRMATION ──────
 *
 * Confirming a proposal replaces nothing: §2.2 says structure proposes
 * "candidate edges and their direction" and no lead time at all, so there is no
 * earlier judgement to explain. Revising replaces somebody's judgement with
 * yours, and retiring removes it. The CHECK below says exactly that, rather
 * than leaving it to whichever service writes the row.
 *
 * ── STATE AS JSONB, NOT AS COLUMNS ─────────────────────────────────────────
 *
 * §8 — "edge_revisions — edge, previous state, new state, reason, revised by,
 * revised at." A snapshot pair mirrors that and survives the columns growing
 * when step seven adds contention. It holds concept ids, a kind and durations:
 * the edge's own fields, no entity and no value from any customer system.
 */

CREATE TABLE edge_revisions (
  id              uuid        PRIMARY KEY,
  organisation_id uuid        NOT NULL REFERENCES organisations(id) ON DELETE RESTRICT,
  edge_id         uuid        NOT NULL REFERENCES dependency_edges(id) ON DELETE CASCADE,

  /*
   * WHICH OF THE THREE THIS WAS, stored rather than inferred. §7 gives
   * `graph.confirm` three verbs — "Confirm, revise or retire an edge" — and §9
   * gives each its own audit event. Deriving the verb from whether the previous
   * state had a `confirmed_at` would work until it didn't.
   */
  change          text        NOT NULL CHECK (change IN ('confirmed', 'revised', 'retired')),

  /* Null on a confirmation: a proposal is not a state anybody decided. */
  previous_state  jsonb,
  new_state       jsonb       NOT NULL,

  reason          text        CHECK (reason IS NULL OR length(trim(reason)) BETWEEN 1 AND 1000),

  revised_by      uuid        NOT NULL REFERENCES memberships(id) ON DELETE RESTRICT,
  revised_at      timestamptz NOT NULL DEFAULT now(),

  /* §2.3 — replacing a judgement requires saying why; making one does not. */
  CONSTRAINT edge_revisions_reason_when_replacing CHECK (
    change = 'confirmed' OR reason IS NOT NULL
  ),
  CONSTRAINT edge_revisions_previous_when_replacing CHECK (
    (change = 'confirmed') = (previous_state IS NULL)
  )
);

CREATE INDEX edge_revisions_by_edge ON edge_revisions (edge_id, revised_at DESC);

ALTER TABLE edge_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE edge_revisions FORCE  ROW LEVEL SECURITY;
CREATE POLICY edge_revisions_tenant ON edge_revisions
  USING (organisation_id = app_org_id()) WITH CHECK (organisation_id = app_org_id());

/*
 * INSERT AND SELECT, NEVER UPDATE OR DELETE. A revisable edge is the point; a
 * revisable history of revisions is not, and the whole value of §5's
 * comparability claim is that the record behind it cannot be tidied up.
 */
GRANT SELECT, INSERT ON edge_revisions TO silo_app;

/*
 * §7 — `graph.confirm`: "Confirm, revise or retire an edge."
 *
 * ── SUPER ADMIN ONLY, AND THAT IS THE SPEC'S POINT RATHER THAN CAUTION ────
 *
 * "graph.confirm is consequential. A confirmed edge changes what every future
 * simulation concludes, and a wrong lead time is a wrong answer that looks
 * computed. It should sit with the people who understand the operation, not
 * with whoever administers the system."
 *
 * `Admin` IS whoever administers the system, so putting it there would be the
 * exact arrangement that sentence rules out. The people who understand the
 * operation do not have a system role, because no product can guess which of a
 * customer's people those are — they get a role the customer builds, and this
 * permission is what the customer attaches to it.
 *
 * It is catalogued against `Super admin` so it is reachable at all: a
 * permission no role holds refuses everybody, including the person who would
 * create that role. That is the same reasoning `automation.execute` carries,
 * and the permission catalogue check is what found it both times.
 */
INSERT INTO permissions (id, category, description, scopeable) VALUES
  ('graph.confirm', 'simulation', 'Confirm, revise or retire a dependency edge', false);

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, 'graph.confirm'
  FROM roles r
 WHERE r.system_role AND r.name = 'Super admin'
ON CONFLICT DO NOTHING;
