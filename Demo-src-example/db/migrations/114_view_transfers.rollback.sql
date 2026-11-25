/* Inheritance goes away, and the suspended shares go live again with it. */
DROP TABLE IF EXISTS view_transfer_flags;
ALTER TABLE view_shares DROP COLUMN IF EXISTS suspended_at;
ALTER TABLE saved_views DROP COLUMN IF EXISTS archived_at;
