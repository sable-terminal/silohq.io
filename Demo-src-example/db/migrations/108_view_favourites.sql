/*
 * 108 — the views somebody put on their dashboard.
 *
 * ── §8: "Favouriting is what promotes a view" ─────────────────────────────
 *
 * "Console hides the conversation and shows favourited views as a grid.
 * Favouriting is what promotes a view, SO THE DASHBOARD IS CURATED RATHER THAN
 * AUTOMATIC. Otherwise it fills with everything and stops being useful by week
 * three."
 *
 * That paragraph is the whole design. A dashboard that filled itself from
 * recency, or from how often something was opened, would be right in week one
 * and noise by week three — and the fix for noise is always deletion, which
 * nobody does. An explicit act is the only thing that keeps a grid worth
 * looking at.
 *
 * ── A COLUMN, NOT A TABLE, AND NOT IN THE RENDER LAYER ────────────────────
 *
 * §10 lists the render layer's two tables and ends "Nothing else". Favouriting
 * is not a presentation decision: it is a property of the VIEW, which is §7 of
 * the product spec's object and belongs to one membership. A join table would
 * be the right shape the day a view can be shared and two people can favourite
 * it separately — and saved views are deliberately owner-only today, so it
 * would be a table with a unique index doing a column's job.
 *
 * ── A TIMESTAMP, NOT A BOOLEAN ────────────────────────────────────────────
 *
 * Null is not favourited. A `favourited boolean NOT NULL DEFAULT false` cannot
 * say WHEN, and the grid has to be ordered by something: newest-first is the
 * order somebody expects from a thing they just added, and `created_at` is the
 * order the view was saved in, which is a different fact.
 */

ALTER TABLE saved_views
  ADD COLUMN favourited_at timestamptz;

/*
 * The dashboard's own query: this person's favourites, newest first.
 *
 * NO `deleted_at` PREDICATE, because saved views have none — deleting one
 * removes the row. Writing the condition anyway would have been a habit
 * carried from every other table here, and it does not apply.
 */
CREATE INDEX saved_views_favourited
  ON saved_views (owner_membership_id, favourited_at DESC)
  WHERE favourited_at IS NOT NULL;
