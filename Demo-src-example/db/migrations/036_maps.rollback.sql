DROP TABLE IF EXISTS thresholds;
DROP TABLE IF EXISTS map_connector_relevance;
DROP TABLE IF EXISTS map_detector_weights;
DROP TABLE IF EXISTS map_links;
DROP TABLE IF EXISTS map_shares;
DROP TABLE IF EXISTS maps;
ALTER TABLE organisations DROP COLUMN IF EXISTS sharing_policy;
