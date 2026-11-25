/*
 * 120 — the builder's vocabulary, as v2 says it.
 *
 * The builder form now writes version 2 documents, so what its dropdowns offer
 * is what a v2 document can say:
 *
 *   TRANSPORTS BY PROTOCOL, NOT BY BRAND OF DRIVER. `sql` is every database —
 *   the driver and grammar are chosen inside it — and the file drops are three
 *   protocols. The v1 kinds stay as rows, offered on no route, because a
 *   discovery finding may still name one.
 *
 *   EVERY V2 STRATEGY IS OFFERED, and the four v1 names that v2 renamed or
 *   retired are not: they stay as rows because connections made before v2 are
 *   recorded under them.
 *
 *   SIGNING IS AN ALGORITHM, NOT A PROVIDER. `signing_algorithms` replaces
 *   `hmac_canonicalisations`; what to sign is an expression the form writes.
 *
 *   PAGING AND ENVELOPES ARE PRESETS, NOT ENUMERATIONS. A v2 document says how
 *   to page and where the records are as expressions; the builder offers the
 *   common shapes as presets that write them. `pagination_strategies` and
 *   `response_envelopes` described v1's fixed branches and go.
 */

INSERT INTO connector_transports (kind, protocol, routes, description) VALUES
  ('sql',       'sql',    '{prebuilt,discovery,ai,visual}', 'A database — Postgres, MySQL, SQL Server, Oracle, or others through the Silo agent'),
  ('sftp',      'file',   '{prebuilt,discovery,ai,visual}', 'Files on an SFTP server'),
  ('ftp',       'file',   '{prebuilt,ai,visual}',           'Files on an FTP or FTPS server'),
  ('smb',       'file',   '{prebuilt,discovery,visual}',    'Files on a Windows share, through the Silo agent'),
  ('imap',      'email',  '{}',                             'A mailbox, read over IMAP'),
  ('grpc',      'grpc',   '{}',                             'A gRPC service'),
  ('kafka',     'stream', '{}',                             'A Kafka topic, read from its offsets'),
  ('queue_tap', 'queue',  '{}',                             'An AMQP or MQTT queue, received through the Silo agent'),
  ('silo_import','silo',  '{}',                             'A Silo import')
ON CONFLICT (kind) DO NOTHING;

UPDATE connector_transports SET routes = '{prebuilt,discovery,ai,visual}' WHERE kind = 'https_rest';
UPDATE connector_transports SET routes = '{prebuilt,ai,visual}' WHERE kind IN ('graphql', 'soap');
UPDATE connector_transports SET routes = '{}' WHERE kind IN ('sql_odbc', 'sql_jdbc', 'sftp_file');

UPDATE connector_auth_strategies SET user_selectable = true
 WHERE strategy IN ('none','oauth2_authorization_code','oauth2_pkce','oauth2_client_credentials','oauth2_password',
                    'api_key_header','api_key_query','bearer','basic','ssh_key','mtls','placed','session',
                    'jwt_assertion','signed','ws_security','ntlm','negotiate','all_of');
UPDATE connector_auth_strategies SET user_selectable = false
 WHERE strategy IN ('oauth2_refresh','jwt_bearer_assertion','session_cookie','hmac_signed');

CREATE TABLE signing_algorithms (
  name        text PRIMARY KEY,
  description text NOT NULL
);

INSERT INTO signing_algorithms (name, description) VALUES
  ('sigv4',              'AWS Signature Version 4 — every S3-compatible store and signed cloud API'),
  ('oauth1_hmac_sha1',   'OAuth 1.0a, HMAC-SHA1'),
  ('oauth1_hmac_sha256', 'OAuth 1.0a, HMAC-SHA256'),
  ('hmac_sha1',          'HMAC-SHA1 over a canonical string'),
  ('hmac_sha256',        'HMAC-SHA256 over a canonical string'),
  ('hmac_sha512',        'HMAC-SHA512 over a canonical string'),
  ('rsa_sha256',         'An RSA-SHA256 signature over a canonical string'),
  ('ed25519',            'An Ed25519 signature over a canonical string');

DROP TABLE hmac_canonicalisations;
DROP TABLE pagination_strategies;
DROP TABLE response_envelopes;
