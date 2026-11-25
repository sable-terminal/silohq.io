/*
 * 109 — dashboards: named, several per person, each a grid of saved views.
 *
 * ── WHAT 108 COULD NOT SAY ────────────────────────────────────────────────
 *
 * 108 made the dashboard a column on `saved_views`: favourited or not. That is
 * one grid per person, in the order things were added, every tile the size its
 * archetype chose. Somebody who watches cash in the morning and the pipeline on
 * Fridays wants two grids, and somebody who wants the headline figure large
 * wants to say so. Neither fits in a timestamp.
 *
 * ── STILL CURATED ─────────────────────────────────────────────────────────
 *
 * Rendering §8's point survives the change: nothing reaches a dashboard except
 * by somebody putting it there. A widget is an explicit act, exactly as a
 * favourite was.
 *
 * ── OWNER-ONLY, AS THE VIEWS ON IT ARE ────────────────────────────────────
 *
 * A dashboard of views only its owner can run would show a colleague a grid
 * of refusals, so it belongs to one membership until views can be shared.
 */

CREATE TABLE dashboards (
  id                  uuid        PRIMARY KEY,
  organisation_id     uuid        NOT NULL REFERENCES organisations(id) ON DELETE RESTRICT,
  owner_membership_id uuid        NOT NULL REFERENCES memberships(id) ON DELETE RESTRICT,

  name                text        NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 80),

  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),

  /* The dropdown lists them by name, so no two of one person's share one. */
  UNIQUE (owner_membership_id, name)
);

CREATE INDEX dashboards_by_owner ON dashboards (owner_membership_id, created_at);

ALTER TABLE dashboards ENABLE ROW LEVEL SECURITY;
ALTER TABLE dashboards FORCE  ROW LEVEL SECURITY;
CREATE POLICY dashboards_tenant ON dashboards
  USING (organisation_id = app_org_id()) WITH CHECK (organisation_id = app_org_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON dashboards TO silo_app;

/*
 * A saved view placed on a dashboard, and the room it takes.
 *
 * ── A FLOW, NOT COORDINATES ───────────────────────────────────────────────
 *
 * Widgets are kept in order and flow into a twelve-column grid, each spanning
 * `width` columns and `height` rows. Free x/y placement would let two widgets
 * claim the same cell and leave holes nobody meant, and it would have to be
 * redone for every screen width; an order and a size read the same on a phone.
 *
 * ── NULL SIZE IS "WHATEVER SUITS IT" ──────────────────────────────────────
 *
 * Until somebody resizes a widget it takes the size its archetype suits — a
 * figure small, a series wide — which is what the grid did before. Storing that
 * guess would freeze it: a view whose answer changes shape would keep the size
 * of the shape it used to be.
 */
CREATE TABLE dashboard_widgets (
  id              uuid        PRIMARY KEY,
  organisation_id uuid        NOT NULL REFERENCES organisations(id) ON DELETE RESTRICT,
  dashboard_id    uuid        NOT NULL REFERENCES dashboards(id) ON DELETE CASCADE,

  /* Deleting a view takes it off every dashboard; a widget of nothing is not kept. */
  view_id         uuid        NOT NULL REFERENCES saved_views(id) ON DELETE CASCADE,

  position        integer     NOT NULL CHECK (position >= 0),
  width           smallint    CHECK (width BETWEEN 1 AND 12),
  height          smallint    CHECK (height BETWEEN 1 AND 8),

  created_at      timestamptz NOT NULL DEFAULT now(),

  /* A view once per dashboard: the same figure twice on one grid says nothing twice. */
  UNIQUE (dashboard_id, view_id),

  /* Both or neither — a width without a height is half a decision. */
  CHECK ((width IS NULL) = (height IS NULL))
);

CREATE INDEX dashboard_widgets_by_dashboard ON dashboard_widgets (dashboard_id, position);
CREATE INDEX dashboard_widgets_by_view ON dashboard_widgets (view_id);

ALTER TABLE dashboard_widgets ENABLE ROW LEVEL SECURITY;
ALTER TABLE dashboard_widgets FORCE  ROW LEVEL SECURITY;
CREATE POLICY dashboard_widgets_tenant ON dashboard_widgets
  USING (organisation_id = app_org_id()) WITH CHECK (organisation_id = app_org_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON dashboard_widgets TO silo_app;

/*
 * ── WHAT WAS FAVOURITED BECOMES A DASHBOARD ───────────────────────────────
 *
 * Everybody with favourites gets one dashboard, "My dashboard", holding them in
 * the order the grid showed them — newest first — at the size their archetype
 * suits. Nothing somebody chose is lost, and then the column goes: two ways to
 * put a view on a grid is one too many.
 */
INSERT INTO dashboards (id, organisation_id, owner_membership_id, name)
SELECT gen_random_uuid(), organisation_id, owner_membership_id, 'My dashboard'
  FROM saved_views
 WHERE favourited_at IS NOT NULL
 GROUP BY organisation_id, owner_membership_id;

INSERT INTO dashboard_widgets (id, organisation_id, dashboard_id, view_id, position)
SELECT gen_random_uuid(),
       v.organisation_id,
       d.id,
       v.id,
       (row_number() OVER (PARTITION BY v.owner_membership_id ORDER BY v.favourited_at DESC) - 1)::integer
  FROM saved_views v
  JOIN dashboards d
    ON d.owner_membership_id = v.owner_membership_id AND d.name = 'My dashboard'
 WHERE v.favourited_at IS NOT NULL;

DROP INDEX IF EXISTS saved_views_favourited;
ALTER TABLE saved_views DROP COLUMN favourited_at;
