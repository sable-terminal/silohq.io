/*
 * Back to one grid per person. Every view on any of somebody's dashboards is
 * favourited again, newest widget first; names, order and sizes are lost,
 * because 108 had nowhere to keep them.
 */
ALTER TABLE saved_views ADD COLUMN favourited_at timestamptz;

UPDATE saved_views v
   SET favourited_at = w.created_at
  FROM (SELECT view_id, max(created_at) AS created_at FROM dashboard_widgets GROUP BY view_id) w
 WHERE w.view_id = v.id;

CREATE INDEX saved_views_favourited
  ON saved_views (owner_membership_id, favourited_at DESC)
  WHERE favourited_at IS NOT NULL;

DROP TABLE IF EXISTS dashboard_widgets;
DROP TABLE IF EXISTS dashboards;
