DROP FUNCTION IF EXISTS directory_record(text, text);
DROP TABLE IF EXISTS directory_entries;
DROP INDEX IF EXISTS organisations_by_cell;
ALTER TABLE organisations DROP COLUMN IF EXISTS cell_id;
