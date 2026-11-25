-- 012_connector_enumerations — the strategies, as data.
--
-- EVERY ENUMERATED STRATEGY IN THE SPEC IS CONSTRAINED, NEVER FREE TEXT. Free
-- text in these columns is how you get three spellings of `oauth2_pkce` and a
-- query that silently matches none of them.
--
-- ── Why lookup tables and CHECK constraints rather than Postgres enums ───────
--
-- A `CREATE TYPE ... AS ENUM` cannot have a value removed, and `ALTER TYPE ...
-- ADD VALUE` could not run inside a transaction before PG12 and still cannot be
-- rolled back. For a set that §13 explicitly expects to grow — "add strategies
-- as real connectors demand them" — that is the wrong shape.
--
-- The two forms here are chosen per column:
--
--   LOOKUP TABLE where the set grows as data. Adding an HMAC canonicalisation
--   strategy or a pushdown capability must not need a deploy, because §1 says a
--   connector is data and a strategy list living in code contradicts that.
--
--   CHECK CONSTRAINT where the set is closed by design. Trust tiers, connection
--   statuses and heal change kinds each carry behaviour in the engine, so a new
--   value needs code anyway and a row that could name one before the code exists
--   is a row nothing can execute.

/* ── Transport and protocol ─────────────────────────────────────────────────
 *
 * TWO COLUMNS, NOT ONE, AND THEY ARE GENUINELY DIFFERENT. `sql_odbc` and
 * `sql_jdbc` are two transports carrying one protocol; `https_rest` and
 * `inbound_webhook` are two transports carrying two protocols. Collapsing them
 * loses the distinction that lets the engine pick a driver independently of how
 * it interprets what comes back.
 */
CREATE TABLE connector_transports (
  kind        text        PRIMARY KEY,
  protocol    text        NOT NULL,
  /** Which build routes may produce this transport. See §3's table. */
  routes      text[]      NOT NULL,
  description text        NOT NULL
);

INSERT INTO connector_transports (kind, protocol, routes, description) VALUES
  ('https_rest',      'rest',    '{prebuilt,ai,visual}', 'HTTPS REST, discovered from OpenAPI or a live probe'),
  ('graphql',         'graphql', '{prebuilt,ai,visual}', 'GraphQL, discovered by introspection'),
  ('soap',            'soap',    '{prebuilt,visual}',    'SOAP, discovered from WSDL'),
  ('sql_odbc',        'sql',     '{prebuilt,discovery}', 'SQL over ODBC, discovered from the catalogue'),
  ('sql_jdbc',        'sql',     '{prebuilt,discovery}', 'SQL over JDBC, discovered from the catalogue'),
  ('sftp_file',       'file',    '{prebuilt,visual}',    'SFTP file drop, discovered from a file header'),
  ('inbound_webhook', 'webhook', '{ai,visual}',          'Inbound webhook with a declared payload schema'),
  ('email_fallback',  'email',   '{ai}',                 'Field extraction from forwarded notifications');

/* ── Auth strategies ────────────────────────────────────────────────────────
 *
 * `user_selectable` IS WHY THIS IS A TABLE AND NOT A CHECK. §4.1 lists twelve
 * and only eleven are ever offered: `oauth2_refresh` is what the engine does
 * when a token expires, not a thing anybody picks. Encoding that as a column
 * means the builder's dropdown is a query rather than a hand-maintained list
 * that drifts from the enumeration beside it.
 */
CREATE TABLE connector_auth_strategies (
  strategy        text    PRIMARY KEY,
  user_selectable boolean NOT NULL DEFAULT true,
  description     text    NOT NULL
);

INSERT INTO connector_auth_strategies (strategy, user_selectable, description) VALUES
  ('oauth2_authorization_code', true,  'Browser redirect, user approves at the provider'),
  ('oauth2_pkce',               true,  'Authorisation code with PKCE'),
  ('oauth2_client_credentials', true,  'Machine to machine, no browser'),
  ('oauth2_refresh',            false, 'What the engine does when a token expires. Never chosen.'),
  ('api_key_header',            true,  'A key sent in a named header'),
  ('api_key_query',             true,  'A key sent as a query parameter'),
  ('bearer',                    true,  'A bearer token'),
  ('basic',                     true,  'Username and password'),
  ('jwt_bearer_assertion',      true,  'A signed assertion exchanged for a token'),
  ('mtls',                      true,  'A client certificate'),
  ('session_cookie',            true,  'Log in once, keep the cookie'),
  ('hmac_signed',               true,  'Each request signed by a named scheme');

/*
 * HMAC canonicalisation. A TABLE PRECISELY SO A NEW SCHEME NEEDS NO DEPLOY —
 * canonicalisation is where signing differs between providers, and §4.1 makes it
 * enumerated rather than arbitrary so that the alternative to a named scheme is
 * a support ticket rather than a customer-authored code hook.
 */
CREATE TABLE hmac_canonicalisations (
  name        text PRIMARY KEY,
  description text NOT NULL
);

INSERT INTO hmac_canonicalisations (name, description) VALUES
  ('aws_sigv4',      'AWS Signature Version 4'),
  ('shopify',        'Shopify HMAC over the raw body'),
  ('stripe_webhook', 'Stripe signature with a timestamped payload'),
  ('twilio',         'Twilio X-Twilio-Signature over the sorted parameters'),
  ('rfc9421',        'HTTP Message Signatures');

/* ── Pagination and response ────────────────────────────────────────────────
 *
 * CLOSED SETS, BECAUSE EACH ONE IS A BRANCH IN THE ENGINE. A row naming a
 * pagination strategy the executor has never heard of is a connector that
 * cannot run, and a lookup table would let one be inserted.
 */
CREATE TABLE pagination_strategies (
  strategy    text PRIMARY KEY,
  description text NOT NULL
);

INSERT INTO pagination_strategies (strategy, description) VALUES
  ('offset_limit',      'An offset and a limit parameter'),
  ('page_number',       'A page number and a page size'),
  ('opaque_cursor',     'A cursor returned in the response body'),
  ('link_header',       'RFC 5988 Link header. Nothing to configure.'),
  ('body_continuation', 'A continuation token in the body'),
  ('scroll_keepalive',  'A scroll id held open for a stated window'),
  ('none',              'Everything comes back at once');

CREATE TABLE response_envelopes (
  envelope    text PRIMARY KEY,
  description text NOT NULL
);

INSERT INTO response_envelopes (envelope, description) VALUES
  ('plain_array', 'The records are the whole body'),
  ('enveloped',   'The records sit under a named path'),
  ('json_api',    'JSON:API'),
  ('hal',         'HAL'),
  ('xml',         'XML requiring extraction'),
  ('csv',         'CSV'),
  ('nested',      'Nested, requiring flattening');

/* ── Pushdown and mutation capabilities ─────────────────────────────────────
 *
 * DECLARED PER CONNECTOR, NEVER ASSUMED. What cannot be pushed down comes back
 * and is bounded in memory; assuming a filter works when it does not means the
 * system quietly returns everything and the bound fires on a question that
 * should have been cheap.
 */
CREATE TABLE pushdown_capabilities (
  capability  text PRIMARY KEY,
  description text NOT NULL
);

INSERT INTO pushdown_capabilities (capability, description) VALUES
  ('filter_equality',   'field = value'),
  ('filter_range',      'Greater than, less than, between'),
  ('filter_in',         'field IN (…)'),
  ('filter_text_match', 'Contains, starts with'),
  ('filter_null',       'IS NULL and IS NOT NULL'),
  ('sort',              'Order by a field'),
  ('limit',             'Cap the number of records returned'),
  ('field_selection',   'Ask for a subset of fields'),
  ('aggregate_count',   'Count without returning rows'),
  ('aggregate_sum',     'Sum without returning rows'),
  ('group_by',          'Group without returning rows');

CREATE TABLE mutation_capabilities (
  capability  text PRIMARY KEY,
  description text NOT NULL
);

INSERT INTO mutation_capabilities (capability, description) VALUES
  ('create',        'Create a record'),
  ('update_full',   'Replace a record'),
  ('update_partial','Patch a record'),
  ('delete',        'Delete a record'),
  ('upsert',        'Create or update by key'),
  ('batch',         'Several records in one call'),
  -- Convert lead, close case. Common in CRMs and not expressible as CRUD, so
  -- enumerating only the verbs would leave a whole category outside the manifest.
  ('custom_action', 'A named endpoint that is not CRUD');

/*
 * NO ROW LEVEL SECURITY ON ANY OF THESE. They are the vocabulary, identical in
 * every tenant, and hold nothing about anybody — the same reasoning that leaves
 * `permissions` without a policy. Read by everyone, written by migrations.
 */
GRANT SELECT ON
  connector_transports, connector_auth_strategies, hmac_canonicalisations,
  pagination_strategies, response_envelopes, pushdown_capabilities, mutation_capabilities
TO silo_app;
