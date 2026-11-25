/*
 * 117 — a connection's parameters: what one document needs to serve one instance.
 *
 * A v2 connector reads `params.host`, `params.tenant`, `params.region` — the
 * shop's domain, the Okta org, the on-prem server's certificate authority — so
 * one document serves every customer of a system instead of one document per
 * customer. They are asked for beside the credential at connect time and are
 * NOT secret: an expression can read them, the builder shows them, and the
 * audit trail may name them. A value that looks like a secret is refused by the
 * service before it gets here (MANIFEST-V2 §9.1, finding F27).
 *
 * AN OBJECT OF STRINGS, HELD TO THAT BY THE DATABASE. The engine binds each as
 * text; a nested value here would be something no expression was written to
 * read. The size bound matches the manifest's: a PEM fits, a file does not.
 */

ALTER TABLE connections
  ADD COLUMN parameters jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE connections
  ADD CONSTRAINT connections_parameters_are_strings CHECK (
    jsonb_typeof(parameters) = 'object'
    AND pg_column_size(parameters) <= 262144
    AND NOT jsonb_path_exists(parameters, '$.* ? (@.type() != "string")')
  );
