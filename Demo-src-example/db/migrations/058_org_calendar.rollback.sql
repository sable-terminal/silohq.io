ALTER TABLE organisations
  DROP COLUMN IF EXISTS time_zone,
  DROP COLUMN IF EXISTS year_starts_in_month;
