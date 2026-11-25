/*
 * 119 — the authentication strategies a v2 connector can declare.
 *
 * `connection_credentials.auth_strategy` references this table, so a credential
 * sealed for `all_of`, `placed`, `session` or any other v2 strategy is refused
 * by the foreign key until the strategy is a row. They go in NOT user-selectable:
 * the builder form still writes version 1 documents and would offer a strategy
 * it cannot express. That flag flips when the form writes v2.
 *
 * THE VERSION 1 NAMES STAY. A connection made before v2 recorded its strategy
 * under the old name, and the runtime maps it (`jwt_bearer_assertion` to
 * `jwt_assertion`, `session_cookie` to `placed`, `hmac_signed` to `signed`).
 */
INSERT INTO connector_auth_strategies (strategy, user_selectable, description) VALUES
  ('none',              false, 'No sign-in: a public source'),
  ('oauth2_password',   false, 'A username and password exchanged at a token endpoint'),
  ('ssh_key',           false, 'A username and an SSH key or password, on the connection'),
  ('placed',            false, 'Named values, each placed where the system expects it'),
  ('session',           false, 'Log in with a request; use the token and cookies it returns'),
  ('jwt_assertion',     false, 'A signed assertion, used or exchanged for a token'),
  ('signed',            false, 'Each request signed: SigV4, OAuth 1.0a, HMAC, RSA or Ed25519'),
  ('ws_security',       false, 'A WS-Security username token in the SOAP header'),
  ('ntlm',              false, 'A Windows domain account, through the Silo agent'),
  ('negotiate',         false, 'Kerberos single sign-on, through the Silo agent'),
  ('all_of',            false, 'Several credentials, applied together')
ON CONFLICT (strategy) DO NOTHING;
