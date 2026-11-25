CREATE TABLE hmac_canonicalisations (name text PRIMARY KEY, description text NOT NULL);
INSERT INTO hmac_canonicalisations (name, description) VALUES ('rfc9421', 'HTTP Message Signatures');
CREATE TABLE pagination_strategies (strategy text PRIMARY KEY, description text NOT NULL);
INSERT INTO pagination_strategies (strategy, description) VALUES
  ('offset_limit', 'An offset and a limit parameter'), ('page_number', 'A page number and a page size'),
  ('cursor', 'A cursor returned in the response body'), ('link_header', 'RFC 5988 Link header. Nothing to configure.'),
  ('body_token', 'A continuation token in the body'), ('scroll', 'A scroll id held open for a stated window'),
  ('none', 'Everything comes back at once');
CREATE TABLE response_envelopes (envelope text PRIMARY KEY, description text NOT NULL);
INSERT INTO response_envelopes (envelope, description) VALUES
  ('array', 'The records are the whole body'), ('enveloped', 'The records sit under a named path'),
  ('jsonapi', 'JSON:API'), ('hal', 'HAL'), ('xml', 'XML requiring extraction'), ('csv', 'CSV');
DROP TABLE signing_algorithms;
UPDATE connector_auth_strategies SET user_selectable = true WHERE strategy IN ('jwt_bearer_assertion','session_cookie','hmac_signed');
UPDATE connector_auth_strategies SET user_selectable = false
 WHERE strategy IN ('none','oauth2_password','ssh_key','placed','session','jwt_assertion','signed','ws_security','ntlm','negotiate','all_of');
UPDATE connector_transports SET routes = '{prebuilt,discovery}' WHERE kind IN ('sql_odbc', 'sql_jdbc');
UPDATE connector_transports SET routes = '{prebuilt,visual}' WHERE kind = 'sftp_file';
DELETE FROM connector_transports WHERE kind IN ('sql','sftp','ftp','smb','imap','grpc','kafka','queue_tap','silo_import');
