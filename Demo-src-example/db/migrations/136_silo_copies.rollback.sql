/* Past copies go with the table that lists them; the one being served stays, as 135 left it. */
DELETE FROM silo_kept_rows r
 USING silo_holdings h
 WHERE h.id = r.holding_id AND (h.batch_id IS NULL OR r.batch_id <> h.batch_id);

DROP TABLE silo_copies;

ALTER TABLE silo_holdings
  DROP COLUMN sync_started_at,
  DROP COLUMN history;
