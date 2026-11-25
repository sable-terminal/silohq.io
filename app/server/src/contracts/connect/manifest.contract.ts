// The connector manifest (spec 14.1, 14.3): the boundary between anything a model or a
// person produced and anything the engine executes. A connection to a named system is
// this document, never code (docs/siloServiceCatalogue.doc.md).
//
// Closed sets: the protocol (an engine Silo writes) and the auth strategy (how a secret is
// placed). Everything a provider varies above that is data or a bounded expression:
// - records: a JSONata expression from the response body to the records;
// - fields: a path into the record, or a JSONata expression over it;
// - paging: a CEL expression from the last request and response to the next request
//   patch, or null to stop, with a mandatory page bound;
// - pushdown: per field and operator, a CEL expression giving the request patch (REST, and
//   GraphQL's variables), or a declaration the SQL engine compiles (SQL);
// - errors: CEL conditions over the response, each mapped to a meaning from a closed set;
// - writes: request templates whose bodies are JSONata over the values;
// - change streams: the sources of change per object (a closed set, spec 18.1), with the
//   webhook's signature check as CEL and its decoding as JSONata.
// The manifest never holds a secret: it names the fields a connection needs and where
// each belongs in a request.
//
// The SQL dialect is a string here and is checked by the SQL engine itself, the only code
// that may tell dialects apart (tests/architecture/providers.test.ts).
//
// Expressions are validated at save, by the expression evaluator, against the inputs of
// the block they sit in (services/expression-evaluator); a manifest with an expression
// that fails is refused, never repaired (spec 14.2).

import { z } from 'zod';

export const MANIFEST_SCHEMA_VERSION = '1';

/** Protocols with an engine. Each has its own module under services/connect-runtime/protocols. */
export const PROTOCOLS = ['rest', 'graphql', 'soap', 'sql', 'odata', 'sap_rfc', 'sftp', 'file_share', 'email', 'mqtt', 'opc_ua', 'bigquery'] as const;
export type Protocol = (typeof PROTOCOLS)[number];

/** How a secret reaches a request (spec 15.1). Named canonicalisations are expressions here. */
export const AUTH_STRATEGIES = [
  'none', 'api_key', 'bearer', 'basic', 'oauth2_code', 'oauth2_code_pkce', 'oauth2_client_credentials', 'oauth2_refresh',
  'jwt_bearer', 'mtls', 'session_cookie', 'username_password', 'x509', 'expression',
  // SOAP's WS-Security UsernameToken (OASIS), placed in the envelope's header by the credential service.
  'ws_security',
  // SFTP's public key authentication (RFC 4252 7): a username and a private key, opened by the credential service.
  'ssh_key',
] as const;
export type AuthStrategy = (typeof AUTH_STRATEGIES)[number];
export const OAUTH_STRATEGIES = ['oauth2_code', 'oauth2_code_pkce', 'oauth2_client_credentials', 'oauth2_refresh'] as const;

/** What an error means to Silo (spec 14.5). Self-heal fires on these, so they are a closed set. */
export const ERROR_MEANINGS = ['auth', 'rate_limit', 'not_found', 'upstream', 'bounds', 'conflict', 'validation'] as const;
export type ErrorMeaning = (typeof ERROR_MEANINGS)[number];

/** Filter operators a plan step may ask a source to apply (spec 14.5). */
export const FILTER_OPS = ['eq', 'ne', 'lt', 'lte', 'gt', 'gte', 'in', 'contains', 'starts_with', 'is_null', 'is_not_null'] as const;
export type FilterOp = (typeof FILTER_OPS)[number];

export const AGGREGATE_FUNCTIONS = ['count', 'sum', 'min', 'max', 'avg'] as const;
export type AggregateFunction = (typeof AGGREGATE_FUNCTIONS)[number];

/** The type lattice fields are inferred on (spec 14.6), plus the detected string formats. */
export const FIELD_TYPES = ['string', 'integer', 'number', 'boolean', 'date', 'date-time', 'json'] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

/** OData's primitive types an OData object's fields have (spec 14.4): what a filter's literal and a key are written as. */
export const EDM_TYPES = [
  'Edm.String', 'Edm.Guid', 'Edm.Boolean', 'Edm.Byte', 'Edm.SByte', 'Edm.Int16', 'Edm.Int32', 'Edm.Int64', 'Edm.Decimal', 'Edm.Double', 'Edm.Single',
  'Edm.Date', 'Edm.DateTime', 'Edm.DateTimeOffset',
] as const;
export type EdmType = (typeof EDM_TYPES)[number];

// ----------------------------------------------------------------------------- pieces

const name = z.string().regex(/^[a-z][a-z0-9_]{0,62}$/, 'lower snake case, at most 63 characters');
/** A dot path into a record: a.b.c, each segment any key without dots. */
const fieldPath = z.string().min(1).max(500).regex(/^[^.\s][^.]*(\.[^.\s][^.]*)*$/, 'a dot path');
const label = z.string().trim().min(1).max(200);
const headerName = z.string().regex(/^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,100}$/, 'an HTTP header name');
const semver = z.string().regex(
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$/,
  'semver',
);

export const celExpression = z.strictObject({ cel: z.string().trim().min(1).max(4_000) });
export const jsonataExpression = z.strictObject({ jsonata: z.string().trim().min(1).max(8_000) });
export type CelExpression = z.infer<typeof celExpression>;
export type JsonataExpression = z.infer<typeof jsonataExpression>;

/**
 * A path on the connection's base URL. {params.<name>} is replaced by a connection
 * parameter, encoded as one segment. Never absolute: the host comes from the manifest's
 * base URL only, so no value can send a request elsewhere.
 */
export const pathTemplate = z.string().max(2_048)
  .regex(/^\/[^\s]*$/, 'a path starting with /')
  .refine((p) => !p.includes('//') && !/(^|\/)\.\.?(\/|$)/.test(p), 'no empty or dot segments');

const queryValue = z.union([z.string().max(4_096), z.number(), z.boolean()]);

/** A GraphQL name (spec: Name). */
export const graphqlName = z.string().regex(/^[_A-Za-z][_0-9A-Za-z]{0,127}$/, 'a GraphQL name');

/** A change to a request: from paging, pushdown or a write. null removes a query parameter or header. */
export const requestPatch = z.strictObject({
  path: pathTemplate.optional(),
  query: z.record(z.string().min(1).max(200), z.union([queryValue, z.null()])).optional(),
  headers: z.record(headerName, z.union([z.string().max(4_096), z.null()])).optional(),
  /** Merged key by key into a JSON object body. */
  body: z.record(z.string().max(200), z.json()).optional(),
  /**
   * GraphQL: values for the query's declared variables; SOAP: for the operation's declared
   * parameters. null removes one. Values travel as variables or element text, never in the
   * query's or the envelope's structure.
   */
  variables: z.record(graphqlName, z.json()).optional(),
});
export type RequestPatch = z.infer<typeof requestPatch>;

export const requestTemplate = z.strictObject({
  method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']),
  path: pathTemplate,
  query: z.record(z.string().min(1).max(200), queryValue).default({}),
  headers: z.record(headerName, z.string().max(4_096)).default({}),
  body: z.json().optional(),
});
export type RequestTemplate = z.infer<typeof requestTemplate>;

// ----------------------------------------------------------------------------- blocks

const identity = z.strictObject({
  name: label,
  /** The vendor or product the connector speaks to. Display and catalogue only; no code reads it. */
  provider: label,
  version: semver,
  languageVersions: z.strictObject({ cel: z.string().max(20), jsonata: z.string().max(20) }).optional(),
});

const transport = z.strictObject({
  /** True for systems behind the customer's firewall: the Silo Agent runs the protocol (spec 10). */
  viaAgent: z.boolean(),
  /**
   * The origin requests go to, with an optional base path. {params.<name>} may name a host
   * part (a tenant subdomain). Absent for protocols without a URL (SQL).
   */
  baseUrl: z.string().max(500).regex(/^(?:(https?|sftp):\/\/[^\s/?#]+(\/[^\s?#]*)?|file:\/\/\/[^\s?#]+)$/, 'an http(s) origin, or an sftp host, and optional path; or a file share\'s file:/// root').optional(),
  tls: z.strictObject({ minVersion: z.enum(['1.2', '1.3']) }).optional(),
  /** Per request; the engine's own bound applies when absent. */
  timeoutMs: z.int().min(100).max(120_000).optional(),
  /**
   * Held in Silo's own store, not a customer system (spec 66.5): an Import Silo's rows, read
   * by the cell with its own credentials, never through an agent, never written.
   */
  store: z.strictObject({ kind: z.literal('silo'), siloId: z.uuid() }).optional(),
});

const restProtocol = z.strictObject({
  kind: z.literal('rest'),
  format: z.literal('json').default('json'),
});
const sqlProtocol = z.strictObject({
  kind: z.literal('sql'),
  /** A grammar of the SQL engine. Checked by the engine, which alone tells dialects apart. */
  dialect: z.string().regex(/^[a-z][a-z0-9_]{1,31}$/),
});
const graphqlProtocol = z.strictObject({ kind: z.literal('graphql') });
/** SOAP over HTTP: the envelope version decides its namespace, content type and where the action goes. */
const soapProtocol = z.strictObject({ kind: z.literal('soap'), version: z.enum(['1.1', '1.2']).default('1.1') });
/**
 * Email fallback (spec 14.4), for a system with no API: its notifications are forwarded to an
 * address minted for the connection, and records arrive only as they do (changeStream.email).
 */
const emailProtocol = z.strictObject({ kind: z.literal('email') });
/** OData (SAP S/4HANA and ECC, spec 14.4): its version decides the payload shape, paging and literals. */
const odataProtocol = z.strictObject({ kind: z.literal('odata'), version: z.enum(['4.0', '2.0']).default('4.0') });
/**
 * SFTP (spec 14.4: "SFTP and file share", discovered from the file header): files in a
 * directory on an SSH server, read by the credential service, which holds the login, and
 * parsed by the cell. The server is pinned by its host key (the connection's host_key_sha256).
 */
const sftpProtocol = z.strictObject({ kind: z.literal('sftp') });
/**
 * A file share (spec 14.4 "SFTP and file share", 10.4): files in a directory on the Silo
 * Agent's host (a share mounted there), read by the agent beneath the roots its owner allows
 * and parsed by the cell as SFTP's are. The root is the manifest's file:/// base; there is no
 * login: the host's own permissions and its owner's roots decide.
 */
const fileShareProtocol = z.strictObject({ kind: z.literal('file_share') });
/**
 * MQTT (spec 20.2), the Silo Agent's plugin: the broker is the connection's industrial endpoint,
 * reached by the agent on the customer's network. Topics, decoding and fields are the manifest's.
 */
const mqttProtocol = z.strictObject({ kind: z.literal('mqtt'), version: z.enum(['3.1.1', '5.0']).default('3.1.1') });
/**
 * OPC UA (spec 20.3), the Silo Agent's plugin: the server is the connection's industrial
 * endpoint; nodes are named by namespace URI and identifier, never by namespace index.
 */
const opcUaProtocol = z.strictObject({ kind: z.literal('opc_ua') });
/** Protocols with an engine in this release. The others are refused at save until theirs exists. */
const protocol = z.discriminatedUnion('kind', [
  restProtocol, sqlProtocol, graphqlProtocol, soapProtocol, odataProtocol, emailProtocol, sftpProtocol, fileShareProtocol, mqttProtocol, opcUaProtocol,
]);

/** The connection parameter pinning an SFTP server: its host key's SHA-256, as OpenSSH prints it ("SHA256:" and base64). */
export const SFTP_HOST_KEY_PARAMETER = 'host_key_sha256';

/** A public, non-secret connection parameter: a tenant subdomain, a region, a database name. */
const parameter = z.strictObject({
  name,
  label,
  required: z.boolean().default(true),
  pattern: z.string().max(200).optional(),
});

const FIELD_ROLES = ['username', 'password', 'token', 'api_key', 'client_id', 'client_secret', 'private_key', 'passphrase', 'other'] as const;

const authField = z.strictObject({
  name,
  kind: z.enum(['secret', 'public']),
  label,
  /** What the strategy uses it for: basic takes username and password, bearer a token. */
  role: z.enum(FIELD_ROLES).default('other'),
  /** Where api_key places it; none for a value only an expression or the strategy reads. */
  location: z.enum(['header', 'query', 'none']).default('none'),
  /** The header or query parameter name. */
  key: z.string().min(1).max(100).optional(),
  /** Written before the value, such as "Token ". */
  prefix: z.string().max(40).optional(),
});

const oauthEndpoints = z.strictObject({
  authorise: z.url({ protocol: /^https?$/ }).optional(),
  token: z.url({ protocol: /^https?$/ }).optional(),
  revoke: z.url({ protocol: /^https?$/ }).optional(),
  metadata: z.url({ protocol: /^https?$/ }).optional(),
});

const auth = z.strictObject({
  strategy: z.enum(AUTH_STRATEGIES),
  fields: z.array(authField).max(20).default([]),
  endpoints: oauthEndpoints.optional(),
  scopes: z.array(z.string().min(1).max(200)).max(100).default([]),
  scopeSeparator: z.enum([' ', ',']).default(' '),
  /** How the client authenticates at the token endpoint (RFC 6749 2.3.1). */
  clientAuthentication: z.enum(['client_secret_basic', 'client_secret_post']).default('client_secret_basic'),
  refresh: z.strictObject({
    mode: z.enum(['none', 'refresh_token', 'reauthenticate']),
    /** The provider issues a new refresh token on each use; the old one stops working. */
    rotatesRefreshToken: z.boolean().default(false),
    /** Refresh this long before expiry. */
    leadSeconds: z.int().min(0).max(3_600).default(60),
  }).optional(),
  /** strategy expression only: CEL over request, now, public and secret, giving { headers, query }. */
  sign: celExpression.optional(),
  /**
   * strategy ws_security only: the UsernameToken's password as text (over TLS) or as the
   * profile's digest of a nonce, the creation time and the password.
   */
  wsSecurity: z.strictObject({ password: z.enum(['text', 'digest']).default('text') }).optional(),
}).superRefine((a, ctx) => {
  if (a.strategy === 'ws_security' && !(['username', 'password'] as const).every((role) => a.fields.some((f) => f.role === role))) {
    ctx.addIssue({ code: 'custom', path: ['fields'], message: 'a WS-Security UsernameToken needs a username field and a password field' });
  }
  if ((a.strategy === 'expression') !== (a.sign !== undefined)) {
    ctx.addIssue({ code: 'custom', path: ['sign'], message: 'sign is given exactly when the strategy is expression' });
  }
  if ((OAUTH_STRATEGIES as readonly string[]).includes(a.strategy) && a.endpoints?.token === undefined) {
    ctx.addIssue({ code: 'custom', path: ['endpoints', 'token'], message: 'an OAuth strategy needs a token endpoint' });
  }
  if ((a.strategy === 'oauth2_code' || a.strategy === 'oauth2_code_pkce') && a.endpoints?.authorise === undefined) {
    ctx.addIssue({ code: 'custom', path: ['endpoints', 'authorise'], message: 'an authorisation code strategy needs an authorise endpoint' });
  }
  const names = new Set<string>();
  a.fields.forEach((f, i) => {
    if (names.has(f.name)) ctx.addIssue({ code: 'custom', path: ['fields', i, 'name'], message: 'field names are unique' });
    names.add(f.name);
    if (f.location !== 'none' && f.key === undefined) {
      ctx.addIssue({ code: 'custom', path: ['fields', i, 'key'], message: 'a placed field names its header or query parameter' });
    }
  });
});

const field = z.strictObject({
  name,
  type: z.enum(FIELD_TYPES),
  nullable: z.boolean().default(true),
  /** REST: a dot path into the record (default: the name). OPC UA: a browse path, names split by /, or $browseName or $nodeId. */
  path: fieldPath.optional(),
  /** REST: computed from the record, $ being the record. */
  value: jsonataExpression.optional(),
  /** SQL: the column (default: the name). An identifier, quoted by the dialect. */
  column: z.string().min(1).max(128).optional(),
  format: z.string().max(40).optional(),
  provenance: z.enum(['observed', 'documented', 'both']).default('documented'),
}).refine((f) => f.path === undefined || f.value === undefined, 'a field has a path or a value, not both');

/** REST: how one object is read. */
export const restSource = z.strictObject({
  kind: z.literal('rest'),
  request: requestTemplate.refine((r) => r.method === 'GET' || r.method === 'POST', 'a read is a GET or a POST'),
  /** From the response body to the records: an array, or one object. */
  records: jsonataExpression,
  /** Absent: one page. */
  paging: z.strictObject({ next: celExpression, maxPages: z.int().min(1).max(10_000) }).optional(),
});
export type RestSource = z.infer<typeof restSource>;

/** SQL: a table or view in the customer's database. The engine generates every statement. */
export const sqlSource = z.strictObject({
  kind: z.literal('sql'),
  schema: z.string().min(1).max(128).optional(),
  table: z.string().min(1).max(128),
  /** A column every read must filter, for a table that refuses an unfiltered scan: read from the start of time. */
  partitionColumn: z.string().min(1).max(128).optional(),
});
export type SqlSource = z.infer<typeof sqlSource>;

/** A dot path of GraphQL names: where something sits in a selection. */
const graphqlPath = z.string().max(500).regex(/^[_A-Za-z][_0-9A-Za-z]*(\.[_A-Za-z][_0-9A-Za-z]*)*$/, 'a dot path of GraphQL names');

/**
 * GraphQL: one root query field read with a query the engine builds from the plan. The
 * selection is the fields asked for (their paths under recordPath) and the extra paths
 * paging reads; every value a plan, a pushdown or paging supplies goes in a declared,
 * typed variable, passed as the same-named argument of the root field.
 */
export const graphqlSource = z.strictObject({
  kind: z.literal('graphql'),
  /** The endpoint, on the connection's base URL. */
  path: pathTemplate.default('/graphql'),
  /** The root Query field that lists the object. */
  root: graphqlName,
  /** The root field's arguments, as typed variables (a GraphQL type reference such as Int, String! or ContactFilter). */
  variables: z.array(z.strictObject({ name: graphqlName, type: z.string().min(1).max(200) })).max(20).default([]),
  /** Values always sent for declared variables, such as a page size. */
  constants: z.record(graphqlName, z.json()).default({}),
  /** Where the records sit in the root field's result: a dot path, mapped over lists (edges.node, nodes); empty for the result itself. */
  recordPath: graphqlPath.optional(),
  /** Paths under the root field the paging expression reads, such as pageInfo.endCursor. */
  select: z.array(graphqlPath).max(20).default([]),
  /** CEL from the last response (and the variables sent) to the next variables, or stop(). */
  paging: z.strictObject({ next: celExpression, maxPages: z.int().min(1).max(10_000) }).optional(),
});
export type GraphqlSource = z.infer<typeof graphqlSource>;

/** An XML element's local name (an NCName without dots, so a dot path can name a nesting). */
const xmlName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_-]{0,127}$/, 'an XML element name');
const xmlPath = z.string().max(500).regex(/^[A-Za-z_][A-Za-z0-9_-]*(\.[A-Za-z_][A-Za-z0-9_-]*)*$/, 'a dot path of XML element names');

/**
 * SOAP (spec 14.4, discovered from a WSDL): one operation read with an envelope the engine
 * builds. Its parameters are child elements of the operation's request element, in the
 * order declared; every value a plan, a pushdown or paging supplies goes in a declared
 * parameter's text, escaped, never in an element name. Records sit at a path of element
 * local names under the Body, read with namespace prefixes removed; an element repeated or
 * not, a record is a record.
 */
export const soapSource = z.strictObject({
  kind: z.literal('soap'),
  /** The endpoint, on the connection's base URL. */
  path: pathTemplate.default('/'),
  /** The SOAPAction: a header for 1.1, the content type's action parameter for 1.2. */
  action: z.string().max(500).regex(/^[^"\r\n\\]*$/, 'no quotes, backslashes or line breaks').optional(),
  /** The operation's request element and its namespace. */
  operation: xmlName,
  namespace: z.string().max(500).regex(/^[A-Za-z][A-Za-z0-9+.-]*:[^\s"<>&']+$/, 'a namespace URI'),
  /** Whether the parameters are in the operation's namespace (elementFormDefault qualified) or unqualified. */
  qualified: z.boolean().default(true),
  /** The operation's parameters, as child elements in this order. */
  parameters: z.array(z.strictObject({ name: graphqlName })).max(30).default([]),
  /** Values always sent for declared parameters, such as a page size. */
  constants: z.record(graphqlName, z.union([z.string().max(4_096), z.number(), z.boolean()])).default({}),
  /** Where the records sit under the Body, such as GetContactsResponse.contacts.contact. */
  recordPath: xmlPath,
  paging: z.strictObject({ next: celExpression, maxPages: z.int().min(1).max(10_000) }).optional(),
});
export type SoapSource = z.infer<typeof soapSource>;

/** An OData identifier: an entity set or property name. */
const odataName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/, 'an OData name');

/**
 * OData (spec 14.4, discovered from $metadata): one entity set read with a query the engine
 * writes. Filters, sort and limit compile natively ($filter, $orderby, $top), every value a
 * typed literal of its property's EDM type; records and paging follow the protocol's version.
 */
export const odataSource = z.strictObject({
  kind: z.literal('odata'),
  /** The service root under the connection's base URL (often the base itself: "/"). */
  servicePath: pathTemplate.default('/'),
  entitySet: odataName,
  /** Each property's EDM type, by property name; a property not named is a string. */
  types: z.record(odataName, z.enum(EDM_TYPES)).default({}),
  /** Pages one read follows at most; more is refused, never truncated. */
  maxPages: z.int().min(1).max(10_000).default(100),
});
export type OdataSource = z.infer<typeof odataSource>;

/** Email fallback: an object whose records arrive only in notifications; it is never read on demand. */
export const emailSource = z.strictObject({ kind: z.literal('email') });

/**
 * SFTP: the object's records are the rows of the files in a directory whose names match a
 * pattern (* and ? only), read in name order. CSV (a header row names the columns, which the
 * fields' paths name) or JSON Lines (one record per line, read by the fields' paths). More
 * files or bytes than declared are refused, never truncated.
 */
export const sftpSource = z.strictObject({
  kind: z.literal('sftp'),
  /** Under the connection's base path: relative segments, never "..". */
  directory: z.string().min(1).max(500).regex(/^(?!.*(^|\/)\.\.(\/|$))[A-Za-z0-9._ -]+(\/[A-Za-z0-9._ -]+)*$/, 'relative path segments, never ".."'),
  pattern: z.string().min(1).max(200).regex(/^[A-Za-z0-9._*?-]+$/, 'a file name pattern of letters, digits, ., _, -, * and ?'),
  format: z.enum(['csv', 'jsonl']),
  /** CSV only. */
  delimiter: z.enum([',', '\t', ';', '|']).default(','),
  maxFiles: z.int().min(1).max(1_000).default(100),
  maxFileBytes: z.int().min(1).max(100 * 1024 * 1024).default(10 * 1024 * 1024),
});
export type SftpSource = z.infer<typeof sftpSource>;
/** A file share's object: SFTP's shape, read by the agent on its host. */
export const fileShareSource = sftpSource.extend({ kind: z.literal('file_share') });
export type FileShareSource = z.infer<typeof fileShareSource>;

/** An MQTT topic filter: levels split by /, + one whole level, # the last level alone. */
const topicFilter = z.string().min(1).max(1_024).refine((f) => !f.includes('\u0000') && f.split('/').every((level, i, all) =>
  (!level.includes('#') || (level === '#' && i === all.length - 1)) && (!level.includes('+') || level === '+')), 'an MQTT topic filter (+ a whole level, # the last)');

/**
 * MQTT (spec 20.2): an object's records are the messages on a topic filter. decode is JSONata
 * over { topic: [its levels], payload, receivedAt } giving the record, whose fields are read by
 * their paths; site/+/line/+/temp gives a line by topic[1] and topic[3]. A read is the
 * broker's retained messages, gathered for snapshotMs (the backfill of 18.5); live telemetry
 * arrives through the change stream. Payloads: JSON, text, or Sparkplug B (D211): decode then
 * reads { messageType, groupId, edgeNodeId, deviceId, timestamp, seq, metrics, values }, each
 * metric named by its birth where a message gives only its alias, on a spBv1.0/... topic.
 */
export const mqttSource = z.strictObject({
  kind: z.literal('mqtt'),
  topic: topicFilter,
  payload: z.enum(['json', 'text', 'sparkplug_b']).default('json'),
  decode: jsonataExpression,
  qos: z.union([z.literal(0), z.literal(1), z.literal(2)]).default(1),
  snapshotMs: z.int().min(100).max(10_000).default(2_000),
});
export type MqttSource = z.infer<typeof mqttSource>;

/** An OPC UA node by namespace URI and identifier: "nsu=<uri>;i=|s=|g=|b=<id>". Never a namespace index, which can change on restart. */
export const opcUaNode = z.string().max(1_300).regex(/^nsu=[^;\s]{1,500};((i=\d{1,10})|(s=\S{1,500})|(g=[0-9a-fA-F-]{36})|(b=[A-Za-z0-9+/=]{1,700}))$/,
  'an OPC UA node by namespace URI and identifier (nsu=...;i=|s=|g=|b=...)');

/**
 * OPC UA (spec 20.3): an object's records are the root node's child objects (of typeDefinition
 * where one is named). Each field's path is a browse path under the instance, browse names split
 * by / ("Temperature", "Motor/Speed"), or $browseName or $nodeId for the instance itself. A read
 * is the values now; subscriptions with sampling, queue and deadband feed the change stream.
 */
export const opcUaSource = z.strictObject({
  kind: z.literal('opc_ua'),
  root: opcUaNode,
  typeDefinition: opcUaNode.optional(),
  maxInstances: z.int().min(1).max(10_000).default(1_000),
});
export type OpcUaSource = z.infer<typeof opcUaSource>;

const pushdown = z.strictObject({
  filters: z.array(z.strictObject({
    field: name,
    ops: z.array(z.enum(FILTER_OPS)).min(1),
    /** REST: CEL over field, op, value and params giving the request patch. SQL compiles natively. */
    patch: celExpression.optional(),
  })).default([]),
  sort: z.array(z.strictObject({
    field: name,
    /** REST: CEL over field and direction giving the request patch. */
    patch: celExpression.optional(),
  })).default([]),
  /** REST: CEL over limit giving the request patch (a page size). */
  limit: z.strictObject({ patch: celExpression.optional() }).optional(),
  /** SQL only: aggregates the source computes. */
  aggregates: z.strictObject({
    functions: z.array(z.enum(AGGREGATE_FUNCTIONS)).min(1),
    groupBy: z.boolean().default(false),
  }).optional(),
});

/**
 * One write operation an object declares (spec 42.5: an Action may use only operations the
 * manifest declares). REST: the request, {identifier} in its path standing for the record's
 * identifier, encoded as one segment. SQL: the declaration alone; the SQL engine generates
 * the statement (decision 2026-11-01), so no request, body or result is given.
 */
/**
 * A GraphQL write (spec 14.4, 42.5): the root Mutation field it calls, the field's typed
 * arguments (each sent as a declared variable, never as text in the document), and the paths
 * under its result to select back, such as the written record's identifier.
 */
const graphqlMutation = z.strictObject({
  field: z.string().regex(/^[_A-Za-z][_0-9A-Za-z]{0,127}$/, 'a GraphQL name'),
  variables: z.array(z.strictObject({ name: z.string().regex(/^[_A-Za-z][_0-9A-Za-z]{0,127}$/), type: z.string().min(1).max(200) })).min(1).max(30),
  select: z.array(z.string().max(500).regex(/^[_A-Za-z][_0-9A-Za-z]*(\.[_A-Za-z][_0-9A-Za-z]*)*$/)).max(20).default([]),
});

/** A SOAP write (spec 14.4, 42.5): the operation it calls, as a read names its own. */
const soapWrite = z.strictObject({
  action: z.string().max(500).regex(/^[^"\r\n\\]*$/, 'no quotes, backslashes or line breaks').optional(),
  operation: z.string().regex(/^[A-Za-z_][A-Za-z0-9_.-]{0,127}$/, 'an XML name'),
  namespace: z.string().max(500).regex(/^[A-Za-z][A-Za-z0-9+.-]*:[^\s"<>&']+$/, 'a namespace URI'),
  qualified: z.boolean().default(true),
  parameters: z.array(z.strictObject({ name: z.string().regex(/^[_A-Za-z][_0-9A-Za-z]{0,127}$/) })).min(1).max(30),
});

const restWrite = z.strictObject({
  request: requestTemplate.optional(),
  /** GraphQL: the mutation this write calls (the protocol's write, as request is REST's). */
  mutation: graphqlMutation.optional(),
  /** SOAP: the operation this write calls, its namespace and declared parameters. */
  soap: z.lazy(() => soapWrite).optional(),
  /** From the values (and identifier for update and delete) to the body. */
  body: jsonataExpression.optional(),
  /** From the response to the written record's identifier. */
  result: jsonataExpression.optional(),
});

/** An OPC UA browse path under an instance: browse names split by /, each level named ("Motor/Start"). */
const browsePath = z.string().min(1).max(1_000).refine((p) => !p.startsWith('$') && p.split('/').every((segment) => segment !== ''),
  'a browse path: browse names split by /, no empty level');

/** An MQTT command topic (47.1): no wildcard, no system topic; {identifier} as one whole level stands for the record's identifier. */
export const commandTopic = z.string().min(1).max(1_024).refine((t) => !t.includes('\u0000') && !t.startsWith('$')
  && t.split('/').every((level) => !level.includes('+') && !level.includes('#') && ((!level.includes('{') && !level.includes('}')) || level === '{identifier}')),
'an MQTT topic with no wildcard: {identifier} a whole level');

/** An MQTT command's declared payload schema (47.1): each key a JSON payload carries, its type, and whether it must be there. */
const payloadKey = z.strictObject({
  name: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/, 'a payload key'),
  type: z.enum(['string', 'number', 'integer', 'boolean']),
  required: z.boolean().default(true),
});

/**
 * An MQTT command (47.1): published to the topic ({identifier} the record's), at its QoS. A
 * retained publish persists on the broker, so it is declared per topic (20.2). The payload is
 * the body's result (default: the inputs): a JSON object of exactly the schema's keys and
 * types, or text.
 */
const mqttCommand = z.strictObject({
  topic: commandTopic,
  qos: z.union([z.literal(0), z.literal(1), z.literal(2)]).default(1),
  retained: z.boolean().default(false),
  payload: z.enum(['json', 'text']).default('json'),
  schema: z.array(payloadKey).max(50).default([]),
});
export type MqttCommand = z.infer<typeof mqttCommand>;

/**
 * A custom action endpoint (spec 42.5): an operation that is not create, read, update or
 * delete ("convert lead", "close case"). A REST custom action names its request and declares
 * the fields it changes (its readable effect), which Silo reads as prior state and back
 * after; without them it cannot be bound to an Action type. A physical command (47.1) is an
 * OPC UA method call or an MQTT publish: it has no state, so it changes no field and is
 * verified by acknowledgement (47.6). `compensatedBy` names the custom action that undoes it,
 * for a compensating revert (42.8): a command's inverse.
 */
/** The OPC UA built-in types a method's input argument may take (D245). */
export const METHOD_ARGUMENT_TYPES = ['Boolean', 'SByte', 'Byte', 'Int16', 'UInt16', 'Int32', 'UInt32', 'Int64', 'Float', 'Double', 'String'] as const;
export type MethodArgumentType = (typeof METHOD_ARGUMENT_TYPES)[number];

const customAction = z.strictObject({
  name,
  label: label.optional(),
  /** REST: the endpoint's request. */
  request: requestTemplate.optional(),
  /**
   * OPC UA: the method called, its browse path under the instance ("Motor/Start"), and the input
   * arguments it takes, in the order it declares them, each by its name and built-in type (D245)
   * and, where there is no body, the custom action's input its value is taken from (default: its
   * name, where that is an input's name).
   */
  opcua: z.strictObject({
    method: browsePath,
    arguments: z.array(z.strictObject({ name: z.string().trim().min(1).max(128), type: z.enum(METHOD_ARGUMENT_TYPES), input: name.optional() }))
      .max(10).default([]),
  }).optional(),
  /** MQTT: the command published. */
  mqtt: mqttCommand.optional(),
  /**
   * From the inputs (and identifier) to the body (REST), the payload (MQTT) or the method's input
   * arguments by name (OPC UA). Default: the inputs themselves.
   */
  body: jsonataExpression.optional(),
  changes: z.array(name).max(100).default([]),
  compensatedBy: name.optional(),
});
export type CustomAction = z.infer<typeof customAction>;

const writes = z.strictObject({
  create: restWrite.optional(),
  /** A partial update: only the fields written are sent. */
  update: restWrite.optional(),
  /** A full update (42.5): the source replaces the record, so every field but the identifier is sent. */
  updateFull: restWrite.optional(),
  delete: restWrite.optional(),
  /** Creates the record its identifier names, or updates it (48.1: MERGE on SQL). */
  upsert: restWrite.optional(),
  custom: z.array(customAction).max(20).default([]),
  /** physical: a write that moves something in the world (spec 47.7). */
  risk: z.enum(['standard', 'physical']).default('standard'),
  bounds: z.strictObject({
    maxRows: z.int().min(1).max(100_000),
    /** CEL over values and prior: false refuses the write. */
    valueCheck: celExpression.optional(),
  }),
});

const object = z.strictObject({
  name,
  label: label.optional(),
  /** The fields that identify a record. */
  identifier: z.array(name).min(1).max(8),
  /**
   * Other field sets the source declares unique (a unique constraint, say): candidates for
   * matching records across systems in resolution (spec 19.4, 23).
   */
  uniqueKeys: z.array(z.array(name).min(1).max(16)).max(50).optional(),
  fields: z.array(field).min(1).max(2_000),
  source: z.discriminatedUnion('kind', [restSource, sqlSource, graphqlSource, soapSource, odataSource, emailSource, sftpSource, fileShareSource, mqttSource, opcUaSource]),
  pushdown: pushdown.default({ filters: [], sort: [] }),
  writes: writes.optional(),
  relationships: z.array(z.strictObject({
    field: name,
    targetObject: name,
    targetField: name,
    kind: z.enum(['foreign_key', 'reference', 'parent']),
    /** What the source does to this record when the one it references is deleted (spec 43.7: cascades are reported). */
    onDelete: z.enum(['cascade', 'restrict', 'set_null', 'no_action']).optional(),
  })).max(100).default([]),
});

const errors = z.strictObject({
  /** In order, before the protocol's own standard classification. */
  classify: z.array(z.strictObject({
    /** CEL over status, headers, body and sqlstate. */
    when: celExpression,
    meaning: z.enum(ERROR_MEANINGS),
    /** CEL giving seconds to wait before a retry. */
    retryAfter: celExpression.optional(),
  })).max(50).default([]),
});

const limits = z.strictObject({
  requestsPerSecond: z.number().positive().max(10_000).optional(),
  maxConcurrent: z.int().min(1).max(64).optional(),
  /** Attempts for a rate-limited or upstream failure, including the first. */
  maxAttempts: z.int().min(1).max(5).default(3),
});

const mapping = z.strictObject({
  object: name,
  field: name,
  objectType: z.string().min(1).max(200),
  property: z.string().min(1).max(200),
  confidence: z.number().min(0).max(1),
});

// ----------------------------------------------------------------------------- change streams

/**
 * Where a source's changes come from (spec 18.1). A closed set: each has a decoder Silo
 * runs. Database change data capture, MQTT telemetry and OPC UA subscriptions run in the Silo
 * Agent; provider event APIs join when their engine exists.
 */
export const CHANGE_SOURCE_KINDS = ['webhook', 'cdc', 'poll', 'email', 'mqtt', 'opcua'] as const;
export type ChangeSourceKind = (typeof CHANGE_SOURCE_KINDS)[number];

/** How a delta changes the entity it names (spec 18.2). */
export const CHANGE_OPERATIONS = ['insert', 'update', 'delete'] as const;

/**
 * The connection's inbound webhook (spec 18.8): one endpoint per connection, whatever
 * objects it carries. verify is CEL over the raw body, the lower-cased headers, the
 * connection parameters, now and secret.webhook (the connection's sealed signing secret),
 * evaluated inside the credential service only; it gives the signature the provider should
 * have sent and the one it did send, compared in constant time there, and the time the
 * provider signed, for replay protection. decode is JSONata from the body (parsed when it
 * is JSON) to the deltas.
 */
const changeWebhook = z.strictObject({
  verify: celExpression,
  decode: jsonataExpression,
  /** No delivery for this long marks the stream delayed and falls back to polling where declared (spec 18.7). */
  heartbeatSeconds: z.int().min(60).max(7 * 24 * 3_600).optional(),
});

/** A line of text a rule looks for: plain text, never a pattern. */
const emailText = z.string().min(1).max(200).regex(/^[^\r\n]+$/, 'one line of text');

/**
 * Email fallback's rules (spec 14.4): which senders are taken, and how each kind of
 * notification becomes one record. Templates, never regular expressions: a rule matches when
 * every condition's text is in the sender, subject or text; a field is the text after its
 * label, to the line's end, the next word, or a closing text.
 */
const changeEmail = z.strictObject({
  /** Only messages from these senders are read: an address, or @domain. */
  senders: z.array(z.string().max(254).regex(/^([^\s@]+@[^\s@]+\.[^\s@]+|@[^\s@]+\.[^\s@]+)$/, 'an address or @domain')).min(1).max(20),
  rules: z.array(z.strictObject({
    object: name,
    when: z.array(z.strictObject({ on: z.enum(['from', 'subject', 'body']), contains: emailText })).min(1).max(5),
    fields: z.array(z.strictObject({
      field: name,
      on: z.enum(['subject', 'body']),
      after: emailText,
      until: z.union([z.enum(['line', 'word']), emailText]).default('line'),
    })).min(1).max(100),
    /** delete: the notification says the record is gone (a cancellation). */
    op: z.enum(['upsert', 'delete']).default('upsert'),
  })).min(1).max(50),
  heartbeatSeconds: z.int().min(60).max(30 * 24 * 3_600).optional(),
});
export type ChangeEmailBlock = z.output<typeof changeEmail>;

const changeSource = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('webhook') }),
  /** Notifications forwarded to the connection's minted address (email fallback, spec 14.4). */
  z.strictObject({ kind: z.literal('email') }),
  /**
   * Read records modified after a stored watermark (spec 18.1): a field the source filters with
   * gt. A watermark read cannot see a record removed outright; where the source keeps removed
   * records with a marker (a deleted flag or time) and returns them past the watermark,
   * deletedField names it, and a record whose marker is set is a delete (decision 2026-11-15).
   */
  z.strictObject({ kind: z.literal('poll'), intervalSeconds: z.int().min(60).max(86_400), watermarkField: name, deletedField: name.optional() }),
  /** Change data capture, read by the Silo Agent (spec 10, 18.1). */
  z.strictObject({ kind: z.literal('cdc'), method: z.enum(['logical_replication', 'binlog', 'change_tracking']) }),
  /** MQTT telemetry (spec 20.2, 20.6): the agent's subscription to the object's topic filter, live, never spooled. */
  z.strictObject({ kind: z.literal('mqtt') }),
  /**
   * OPC UA subscriptions (spec 20.3): a monitored item per instance and field, sampled at
   * samplingMs (0: as fast as the server samples) with a queue of queueSize, changes smaller than
   * the deadband (absolute, or percent of the variable's range) filtered out by the server; the
   * server's timestamp is the delta's source_at. Live, never spooled.
   */
  z.strictObject({
    kind: z.literal('opcua'),
    samplingMs: z.number().min(0).max(3_600_000).default(1_000),
    queueSize: z.int().min(1).max(1_000).default(10),
    deadband: z.strictObject({ type: z.enum(['absolute', 'percent']), value: z.number().min(0).max(1e12) }).optional(),
  }),
]);

const changeStreamObject = z.strictObject({
  object: name,
  /** In order of preference; the first healthy one is used (spec 18.1). */
  sources: z.array(changeSource).min(1).max(3),
  /** source_sequence where the source supplies a monotonic sequence, else observed_at (spec 18.6). */
  ordering: z.enum(['source_sequence', 'observed_at']).default('observed_at'),
  /** CEL over the delta giving its de-duplication key; default connection, entity and sequence. */
  dedupKey: celExpression.optional(),
});

const changeStream = z.strictObject({
  webhook: changeWebhook.optional(),
  email: changeEmail.optional(),
  objects: z.array(changeStreamObject).min(1).max(500),
});
export type ChangeStreamBlock = z.output<typeof changeStream>;
export type ChangeStreamObject = ChangeStreamBlock['objects'][number];

const conformance = z.strictObject({
  suiteVersion: z.string().max(40),
  runId: z.uuid(),
  passed: z.array(z.string().max(100)),
  failed: z.array(z.string().max(100)),
  notApplicable: z.array(z.string().max(100)),
});

export const manifestSchema = z.strictObject({
  schemaVersion: z.literal(MANIFEST_SCHEMA_VERSION),
  identity,
  transport,
  protocol,
  params: z.array(parameter).max(20).default([]),
  auth,
  objects: z.array(object).min(1).max(500),
  errors: errors.default({ classify: [] }),
  limits: limits.default({ maxAttempts: 3 }),
  mapping: z.array(mapping).max(10_000).default([]),
  conformance: conformance.optional(),
  changeStream: changeStream.optional(),
}).superRefine((m, ctx) => {
  // SFTP: an sftp host, a pinned host key, a username with a password or a private key; files are read, never written here.
  const sftp = m.protocol.kind === 'sftp';
  if (m.transport.baseUrl !== undefined && m.transport.baseUrl.startsWith('sftp://') !== sftp) {
    ctx.addIssue({ code: 'custom', path: ['transport', 'baseUrl'], message: sftp ? 'an SFTP connection names an sftp:// host' : 'only an SFTP connection names an sftp:// host' });
  }
  if (sftp) {
    if (m.transport.baseUrl === undefined) ctx.addIssue({ code: 'custom', path: ['transport', 'baseUrl'], message: 'an SFTP connection names its host' });
    if (!m.params.some((p) => p.name === SFTP_HOST_KEY_PARAMETER && p.required)) {
      ctx.addIssue({ code: 'custom', path: ['params'], message: `an SFTP connection pins its server: declare the required parameter ${SFTP_HOST_KEY_PARAMETER}` });
    }
    const roles = new Set(m.auth.fields.map((f) => f.role));
    const login = m.auth.strategy === 'username_password' ? roles.has('username') && roles.has('password')
      : m.auth.strategy === 'ssh_key' ? roles.has('username') && roles.has('private_key') : false;
    if (!login) ctx.addIssue({ code: 'custom', path: ['auth'], message: 'SFTP logs in with a username and a password (username_password) or a private key (ssh_key)' });
    m.objects.forEach((o, i) => {
      if (o.writes !== undefined) ctx.addIssue({ code: 'custom', path: ['objects', i, 'writes'], message: 'SFTP files are read, never written, in this release' });
      if (o.pushdown.filters.length > 0 || o.pushdown.sort.length > 0) {
        ctx.addIssue({ code: 'custom', path: ['objects', i, 'pushdown'], message: 'files are read whole: filters and sorts are applied after the source' });
      }
    });
  } else if (m.auth.strategy === 'ssh_key') {
    ctx.addIssue({ code: 'custom', path: ['auth', 'strategy'], message: 'a private key logs in to SFTP only' });
  }
  // A file share: the agent's host, a file:/// root, no login; files are read, never written here.
  const share = m.protocol.kind === 'file_share';
  if (m.transport.baseUrl !== undefined && m.transport.baseUrl.startsWith('file:///') !== share) {
    ctx.addIssue({ code: 'custom', path: ['transport', 'baseUrl'], message: share ? 'a file share names its root as file:///' : 'only a file share names a file:/// root' });
  }
  if (share) {
    if (m.transport.baseUrl === undefined) ctx.addIssue({ code: 'custom', path: ['transport', 'baseUrl'], message: 'a file share names its root on the agent\'s host' });
    if (!m.transport.viaAgent) ctx.addIssue({ code: 'custom', path: ['transport', 'viaAgent'], message: 'a file share is read by the Silo Agent on its host' });
    if (m.auth.strategy !== 'none') ctx.addIssue({ code: 'custom', path: ['auth', 'strategy'], message: 'a file share has no login: the agent\'s host and its owner\'s roots decide' });
    m.objects.forEach((o, i) => {
      if (o.writes !== undefined) ctx.addIssue({ code: 'custom', path: ['objects', i, 'writes'], message: 'files are read, never written, in this release' });
      if (o.pushdown.filters.length > 0 || o.pushdown.sort.length > 0) {
        ctx.addIssue({ code: 'custom', path: ['objects', i, 'pushdown'], message: 'files are read whole: filters and sorts are applied after the source' });
      }
    });
  }
  if (m.auth.strategy === 'ws_security' && m.protocol.kind !== 'soap') {
    ctx.addIssue({ code: 'custom', path: ['auth', 'strategy'], message: 'WS-Security is SOAP\'s: it travels in the envelope' });
  }
  // OPC UA (20.3): the agent's plugin; each field a browse path or the instance's own name or node; reads only until physical writes.
  if (m.protocol.kind === 'opc_ua') {
    if (!m.transport.viaAgent) ctx.addIssue({ code: 'custom', path: ['transport', 'viaAgent'], message: 'OPC UA runs in the Silo Agent' });
    if (m.transport.baseUrl !== undefined) ctx.addIssue({ code: 'custom', path: ['transport', 'baseUrl'], message: 'the server is the connection\'s industrial endpoint, not the manifest\'s' });
    if (m.auth.strategy === 'username_password' && !(['username', 'password'] as const).every((role) => m.auth.fields.some((f) => f.role === role))) {
      ctx.addIssue({ code: 'custom', path: ['auth', 'fields'], message: 'an OPC UA login is a username and a password' });
    }
    m.objects.forEach((o, i) => {
      // Setpoints and commands (47.1): an update writes each field's variable, the declaration alone; a custom action calls a
      // method; every OPC UA write is physical.
      if (o.writes !== undefined) {
        const w = o.writes;
        const at = (...p: (string | number)[]) => ['objects', i, 'writes', ...p];
        if (w.risk !== 'physical') ctx.addIssue({ code: 'custom', path: at('risk'), message: 'every OPC UA write is physical (47.1)' });
        if (w.create !== undefined || w.updateFull !== undefined || w.delete !== undefined || w.upsert !== undefined) {
          ctx.addIssue({ code: 'custom', path: at(), message: 'an OPC UA object takes setpoint updates and method calls' });
        }
        if (w.update !== undefined && Object.keys(w.update).length > 0) {
          ctx.addIssue({ code: 'custom', path: at('update'), message: 'an OPC UA update is the declaration alone: the agent writes each field\'s variable' });
        }
        const id = o.fields.find((f) => f.name === o.identifier[0]);
        if (o.identifier.length !== 1 || (id?.path ?? id?.name) !== '$browseName') {
          ctx.addIssue({ code: 'custom', path: ['objects', i, 'identifier'], message: 'a written OPC UA object is identified by its instances\' browse names ($browseName)' });
        }
      }
      if (o.pushdown.filters.length > 0 || o.pushdown.sort.length > 0) {
        ctx.addIssue({ code: 'custom', path: ['objects', i, 'pushdown'], message: 'nodes are read whole: filters and sorts are applied after the source' });
      }
      o.fields.forEach((f, j) => {
        if (f.value !== undefined) ctx.addIssue({ code: 'custom', path: ['objects', i, 'fields', j, 'value'], message: 'an OPC UA field reads a browse path; compute in a derived property' });
        const path = f.path ?? f.name;
        if (path !== '$browseName' && path !== '$nodeId' && path.split('/').some((segment) => segment === '')) {
          ctx.addIssue({ code: 'custom', path: ['objects', i, 'fields', j, 'path'], message: 'a browse path names each level: no empty segment' });
        }
      });
    });
  }
  // Industrial (spec 20.1): the agent's plugin, its broker the connection's endpoint; a write publishes a command (47.1).
  if (m.protocol.kind === 'mqtt') {
    if (!m.transport.viaAgent) ctx.addIssue({ code: 'custom', path: ['transport', 'viaAgent'], message: 'MQTT runs in the Silo Agent' });
    if (m.transport.baseUrl !== undefined) ctx.addIssue({ code: 'custom', path: ['transport', 'baseUrl'], message: 'the broker is the connection\'s industrial endpoint, not the manifest\'s' });
    if (m.auth.strategy === 'username_password' && !(['username', 'password'] as const).every((role) => m.auth.fields.some((f) => f.role === role))) {
      ctx.addIssue({ code: 'custom', path: ['auth', 'fields'], message: 'an MQTT login is a username and a password' });
    }
    m.objects.forEach((o, i) => {
      if (o.writes !== undefined) {
        const w = o.writes;
        if (w.risk !== 'physical') ctx.addIssue({ code: 'custom', path: ['objects', i, 'writes', 'risk'], message: 'every MQTT publish is physical (47.1)' });
        if (w.create !== undefined || w.update !== undefined || w.updateFull !== undefined || w.delete !== undefined || w.upsert !== undefined) {
          ctx.addIssue({ code: 'custom', path: ['objects', i, 'writes'], message: 'an MQTT object publishes commands: its custom actions' });
        }
        if (o.identifier.length !== 1) {
          ctx.addIssue({ code: 'custom', path: ['objects', i, 'identifier'], message: 'a commanded MQTT object has one identifier, its topic\'s {identifier}' });
        }
      }
      if (o.pushdown.filters.length > 0 || o.pushdown.sort.length > 0) {
        ctx.addIssue({ code: 'custom', path: ['objects', i, 'pushdown'], message: 'messages are read whole: filters and sorts are applied after the source' });
      }
    });
  }
  if (m.protocol.kind === 'email' && m.changeStream?.email === undefined) {
    ctx.addIssue({ code: 'custom', path: ['changeStream', 'email'], message: 'an email connection declares how its notifications are read' });
  }
  m.changeStream?.email?.rules.forEach((r, i) => {
    const at = ['changeStream', 'email', 'rules', i];
    const object = m.objects.find((o) => o.name === r.object);
    const streamed = m.changeStream?.objects.find((x) => x.object === r.object);
    if (object === undefined || streamed === undefined || !streamed.sources.some((src) => src.kind === 'email')) {
      ctx.addIssue({ code: 'custom', path: [...at, 'object'], message: `${r.object} is not an object streamed from email` });
      return;
    }
    const fields = new Set(object.fields.map((f) => f.name));
    r.fields.forEach((f, j) => {
      if (!fields.has(f.field)) ctx.addIssue({ code: 'custom', path: [...at, 'fields', j, 'field'], message: `${f.field} is not a field of ${r.object}` });
    });
    const extracted = new Set(r.fields.map((f) => f.field));
    for (const id of object.identifier) {
      if (!extracted.has(id)) ctx.addIssue({ code: 'custom', path: [...at, 'fields'], message: `the rule extracts no ${id}: a record is known by its identifier` });
    }
  });
  const objects = new Set<string>();
  m.objects.forEach((o, i) => {
    const at = (...path: (string | number)[]) => ['objects', i, ...path];
    if (objects.has(o.name)) ctx.addIssue({ code: 'custom', path: at('name'), message: 'object names are unique' });
    objects.add(o.name);
    // Sparkplug B lives in its own namespace (D211): spBv1.0/<group>/<message type>/<edge node>[/<device>].
    if (o.source.kind === 'mqtt' && o.source.payload === 'sparkplug_b' && !o.source.topic.startsWith('spBv1.0/')) {
      ctx.addIssue({ code: 'custom', path: at('source', 'topic'), message: 'a Sparkplug B object reads a spBv1.0/... topic' });
    }
    if (o.source.kind !== m.protocol.kind) {
      ctx.addIssue({ code: 'custom', path: at('source', 'kind'), message: `the source must be a ${m.protocol.kind} source` });
    }
    const fields = new Set(o.fields.map((f) => f.name));
    if (fields.size !== o.fields.length) ctx.addIssue({ code: 'custom', path: at('fields'), message: 'field names are unique' });
    for (const id of o.identifier) {
      if (!fields.has(id)) ctx.addIssue({ code: 'custom', path: at('identifier'), message: `identifier ${id} is not a field` });
    }
    (o.uniqueKeys ?? []).forEach((key, j) => key.forEach((f) => {
      if (!fields.has(f)) ctx.addIssue({ code: 'custom', path: at('uniqueKeys', j), message: `${f} is not a field` });
    }));
    if (m.protocol.kind === 'email' && o.writes !== undefined) {
      ctx.addIssue({ code: 'custom', path: at('writes'), message: 'an email connection takes notifications; it writes nothing' });
    }
    // A write speaks its protocol: a request for REST, a mutation for GraphQL; custom actions are REST's.
    if (o.writes !== undefined && (m.protocol.kind === 'rest' || m.protocol.kind === 'graphql' || m.protocol.kind === 'soap')) {
      for (const op of ['create', 'update', 'updateFull', 'delete', 'upsert'] as const) {
        const w = o.writes[op];
        if (w === undefined) continue;
        if (m.protocol.kind === 'graphql' && (w.mutation === undefined || w.request !== undefined)) {
          ctx.addIssue({ code: 'custom', path: at('writes', op), message: 'a GraphQL write names its mutation, not a request' });
        }
        if (m.protocol.kind === 'rest' && (w.mutation !== undefined || w.soap !== undefined)) {
          ctx.addIssue({ code: 'custom', path: at('writes', op), message: 'a REST write names its request' });
        }
        if (m.protocol.kind === 'graphql' && w.soap !== undefined) {
          ctx.addIssue({ code: 'custom', path: at('writes', op, 'soap'), message: 'a GraphQL write names its mutation' });
        }
        if (m.protocol.kind === 'soap' && (w.soap === undefined || w.request !== undefined || w.mutation !== undefined)) {
          ctx.addIssue({ code: 'custom', path: at('writes', op), message: 'a SOAP write names its operation' });
        }
      }
      if (m.protocol.kind !== 'rest' && o.writes.custom.length > 0) {
        ctx.addIssue({ code: 'custom', path: at('writes', 'custom'), message: 'custom actions are REST endpoints' });
      }
    }
    const declared = (path: (string | number)[], fieldName: string) => {
      if (!fields.has(fieldName)) ctx.addIssue({ code: 'custom', path: at(...path), message: `${fieldName} is not a field` });
    };
    const patched = m.protocol.kind === 'rest' || m.protocol.kind === 'graphql' || m.protocol.kind === 'soap';
    o.pushdown.filters.forEach((f, j) => {
      declared(['pushdown', 'filters', j, 'field'], f.field);
      if (patched && f.patch === undefined) {
        ctx.addIssue({ code: 'custom', path: at('pushdown', 'filters', j, 'patch'), message: `a ${m.protocol.kind} filter says how it changes the request` });
      }
    });
    o.pushdown.sort.forEach((s, j) => {
      declared(['pushdown', 'sort', j, 'field'], s.field);
      if (patched && s.patch === undefined) {
        ctx.addIssue({ code: 'custom', path: at('pushdown', 'sort', j, 'patch'), message: `a ${m.protocol.kind} sort says how it changes the request` });
      }
    });
    if (patched && o.pushdown.limit !== undefined && o.pushdown.limit.patch === undefined) {
      ctx.addIssue({ code: 'custom', path: at('pushdown', 'limit', 'patch'), message: `a ${m.protocol.kind} limit says how it changes the request` });
    }
    if (m.protocol.kind !== 'sql' && o.pushdown.aggregates !== undefined) {
      ctx.addIssue({ code: 'custom', path: at('pushdown', 'aggregates'), message: 'only the SQL engine pushes aggregates down' });
    }
    o.relationships.forEach((r, j) => declared(['relationships', j, 'field'], r.field));
    const customs = new Set<string>();
    o.writes?.custom.forEach((c, j) => {
      const here = (...p: (string | number)[]) => at('writes', 'custom', j, ...p);
      const kind = m.protocol.kind;
      if (kind !== 'rest' && kind !== 'opc_ua' && kind !== 'mqtt') {
        ctx.addIssue({ code: 'custom', path: here(), message: 'custom actions are REST endpoints, OPC UA methods or MQTT commands' });
      }
      if (kind === 'rest' && (c.request === undefined || c.opcua !== undefined || c.mqtt !== undefined)) {
        ctx.addIssue({ code: 'custom', path: here('request'), message: 'a REST custom action names its request' });
      }
      if (kind === 'rest' && c.changes.length === 0) {
        ctx.addIssue({ code: 'custom', path: here('changes'), message: 'a REST custom action declares the fields it changes: its readable effect (42.5)' });
      }
      if (kind === 'opc_ua' && (c.opcua === undefined || c.request !== undefined || c.mqtt !== undefined)) {
        ctx.addIssue({ code: 'custom', path: here('opcua'), message: 'an OPC UA custom action names the method it calls' });
      }
      if (kind === 'opc_ua' && c.body !== undefined && (c.opcua?.arguments.length ?? 0) === 0) {
        ctx.addIssue({ code: 'custom', path: here('body'), message: 'a method that takes no input arguments has no body' });
      }
      if (c.opcua !== undefined && new Set(c.opcua.arguments.map((a) => a.name)).size !== c.opcua.arguments.length) {
        ctx.addIssue({ code: 'custom', path: here('opcua', 'arguments'), message: 'a method names each input argument once' });
      }
      c.opcua?.arguments.forEach((a, k) => {
        if (c.body === undefined && a.input === undefined && !name.safeParse(a.name).success) {
          ctx.addIssue({ code: 'custom', path: here('opcua', 'arguments', k, 'input'), message: `name the input ${a.name} is taken from: an input's name is lower snake case` });
        }
      });
      if (c.opcua !== undefined && new Set(c.opcua.arguments.map((a) => a.input ?? a.name)).size !== c.opcua.arguments.length) {
        ctx.addIssue({ code: 'custom', path: here('opcua', 'arguments'), message: 'each input argument is taken from an input of its own' });
      }
      if (kind === 'mqtt' && (c.mqtt === undefined || c.request !== undefined || c.opcua !== undefined)) {
        ctx.addIssue({ code: 'custom', path: here('mqtt'), message: 'an MQTT custom action names the command it publishes' });
      }
      if ((kind === 'opc_ua' || kind === 'mqtt') && c.changes.length > 0) {
        ctx.addIssue({ code: 'custom', path: here('changes'), message: 'a command has no state: it changes no field, and is verified by acknowledgement (47.6)' });
      }
      if (c.mqtt !== undefined) {
        if (c.mqtt.payload === 'text' && c.mqtt.schema.length > 0) ctx.addIssue({ code: 'custom', path: here('mqtt', 'schema'), message: 'a text payload has no keys' });
        if (new Set(c.mqtt.schema.map((k) => k.name)).size !== c.mqtt.schema.length) {
          ctx.addIssue({ code: 'custom', path: here('mqtt', 'schema'), message: 'payload keys are unique' });
        }
        if (c.mqtt.topic.split('/').filter((level) => level === '{identifier}').length > 1) {
          ctx.addIssue({ code: 'custom', path: here('mqtt', 'topic'), message: 'the topic names the record once' });
        }
      }
      if (customs.has(c.name)) ctx.addIssue({ code: 'custom', path: here('name'), message: 'custom action names are unique' });
      customs.add(c.name);
      c.changes.forEach((f, k) => declared(['writes', 'custom', j, 'changes', k], f));
    });
    o.writes?.custom.forEach((c, j) => {
      if (c.compensatedBy !== undefined && (!customs.has(c.compensatedBy) || c.compensatedBy === c.name)) {
        ctx.addIssue({ code: 'custom', path: at('writes', 'custom', j, 'compensatedBy'), message: 'compensatedBy names another custom action of the object' });
      }
      // An inverse is sent with no inputs: there is no prior state to send (47.6).
      if ((o.writes?.custom.find((x) => x.name === c.compensatedBy)?.opcua?.arguments.length ?? 0) > 0) {
        ctx.addIssue({ code: 'custom', path: at('writes', 'custom', j, 'compensatedBy'), message: 'an inverse method takes no input arguments: it is called with none' });
      }
    });
    for (const op of ['create', 'update', 'updateFull', 'delete', 'upsert'] as const) {
      const w = o.writes?.[op];
      if (w === undefined) continue;
      if (m.protocol.kind === 'rest' && w.request === undefined) {
        ctx.addIssue({ code: 'custom', path: at('writes', op, 'request'), message: 'a REST write names its request' });
      }
      if (m.protocol.kind === 'odata' && (w.request !== undefined || w.mutation !== undefined || w.soap !== undefined)) {
        ctx.addIssue({ code: 'custom', path: at('writes', op), message: 'an OData write is written by the engine: it names no request, mutation or operation' });
      }
      if (m.protocol.kind === 'sql' && (w.request !== undefined || w.body !== undefined || w.result !== undefined)) {
        ctx.addIssue({ code: 'custom', path: at('writes', op), message: 'an SQL write is generated by the engine: it declares the operation only' });
      }
    }
  });
  if ((m.protocol.kind === 'rest' || m.protocol.kind === 'graphql' || m.protocol.kind === 'soap') && m.transport.baseUrl === undefined) {
    ctx.addIssue({ code: 'custom', path: ['transport', 'baseUrl'], message: `a ${m.protocol.kind} connector names its base URL` });
  }
  if (m.protocol.kind === 'sql' && !m.transport.viaAgent && m.transport.store === undefined) {
    ctx.addIssue({ code: 'custom', path: ['transport', 'viaAgent'], message: 'customer databases are reached through the Silo Agent' });
  }
  if (m.transport.store !== undefined) {
    if (m.protocol.kind !== 'sql') ctx.addIssue({ code: 'custom', path: ['protocol'], message: 'a Silo store is read with SQL' });
    if (m.transport.viaAgent) ctx.addIssue({ code: 'custom', path: ['transport', 'viaAgent'], message: 'a Silo store is read in the cell, never through an agent' });
    if (m.auth.strategy !== 'none') ctx.addIssue({ code: 'custom', path: ['auth', 'strategy'], message: 'a Silo store is read with the cell\'s own credentials' });
    if (m.objects.some((o) => o.writes !== undefined)) ctx.addIssue({ code: 'custom', path: ['objects'], message: 'a Silo holds a copy: nothing is written to it' });
  }
  if (m.changeStream !== undefined) {
    const streamed = new Set<string>();
    m.changeStream.objects.forEach((s, i) => {
      const at = (...path: (string | number)[]) => ['changeStream', 'objects', i, ...path];
      const object = m.objects.find((o) => o.name === s.object);
      if (object === undefined) {
        ctx.addIssue({ code: 'custom', path: at('object'), message: `${s.object} is not an object` });
        return;
      }
      if (streamed.has(s.object)) ctx.addIssue({ code: 'custom', path: at('object'), message: 'an object has one change stream entry' });
      streamed.add(s.object);
      const kinds = s.sources.map((source) => source.kind);
      if (new Set(kinds).size !== kinds.length) ctx.addIssue({ code: 'custom', path: at('sources'), message: 'each source kind once' });
      s.sources.forEach((source, j) => {
        if (source.kind === 'webhook' && m.changeStream!.webhook === undefined) {
          ctx.addIssue({ code: 'custom', path: at('sources', j), message: 'a webhook source needs the change stream webhook block' });
        }
        if (source.kind === 'mqtt' && object.source.kind !== 'mqtt') {
          ctx.addIssue({ code: 'custom', path: at('sources', j), message: 'only an MQTT object streams by MQTT' });
        }
        if (source.kind === 'opcua') {
          if (object.source.kind !== 'opc_ua') ctx.addIssue({ code: 'custom', path: at('sources', j), message: 'only an OPC UA object streams by subscription' });
          // Each sample names its instance, so the record is known without a read: identified by the instance itself.
          const unnamed = object.identifier.filter((name) => {
            const path = object.fields.find((f) => f.name === name)?.path ?? name;
            return path !== '$browseName' && path !== '$nodeId';
          });
          if (unnamed.length > 0) {
            ctx.addIssue({ code: 'custom', path: at('sources', j), message: 'a subscribed OPC UA object is identified by its instance: $browseName or $nodeId' });
          }
          if (source.deadband?.type === 'percent' && source.deadband.value > 100) {
            ctx.addIssue({ code: 'custom', path: at('sources', j, 'deadband', 'value'), message: 'a percent deadband is at most 100' });
          }
        }
        if (source.kind === 'cdc' && !m.transport.viaAgent) {
          ctx.addIssue({ code: 'custom', path: at('sources', j), message: 'change data capture runs in the Silo Agent' });
        }
        if (source.kind === 'poll') {
          const pushable = object.pushdown.filters.some((f) => f.field === source.watermarkField && f.ops.includes('gt'));
          if (!object.fields.some((f) => f.name === source.watermarkField)) {
            ctx.addIssue({ code: 'custom', path: at('sources', j, 'watermarkField'), message: `${source.watermarkField} is not a field` });
          } else if (!pushable) {
            ctx.addIssue({ code: 'custom', path: at('sources', j, 'watermarkField'), message: 'the source must filter the watermark field with gt' });
          }
          if (source.deletedField !== undefined && !object.fields.some((f) => f.name === source.deletedField)) {
            ctx.addIssue({ code: 'custom', path: at('sources', j, 'deletedField'), message: `${source.deletedField} is not a field` });
          }
        }
      });
    });
  }
  const params = new Set(m.params.map((p) => p.name));
  for (const [path, text] of [['transport', m.transport.baseUrl ?? ''], ...m.objects.map((o, i) =>
    o.source.kind === 'graphql' || o.source.kind === 'soap' ? [`objects.${i}.source.path`, o.source.path] as const
      : [`objects.${i}.source.request.path`, o.source.kind === 'rest' ? o.source.request.path : ''] as const)] as const) {
    for (const match of text.matchAll(/\{params\.([a-z][a-z0-9_]*)\}/g)) {
      if (!params.has(match[1]!)) ctx.addIssue({ code: 'custom', path: path.split('.'), message: `params.${match[1]} is not a declared parameter` });
    }
  }
});

export type Manifest = z.output<typeof manifestSchema>;
export type ManifestInput = z.input<typeof manifestSchema>;

/**
 * The tables a manifest streams by change data capture: each such object's SQL table, its
 * schema as the manifest names it (undefined where unqualified). A binary log carries every
 * table of the server, so a binlog capture reads these, and only these, by schema and name.
 */
export function cdcTables(manifest: Manifest): { object: string; schema: string | undefined; table: string }[] {
  const objects = new Map(manifest.objects.map((o) => [o.name, o]));
  const tables: { object: string; schema: string | undefined; table: string }[] = [];
  for (const stream of manifest.changeStream?.objects ?? []) {
    if (!stream.sources.some((s) => s.kind === 'cdc')) continue;
    const source = objects.get(stream.object)?.source;
    if (source?.kind === 'sql') tables.push({ object: stream.object, schema: source.schema, table: source.table });
  }
  return tables;
}
export type ManifestObject = Manifest['objects'][number];
export type ManifestField = ManifestObject['fields'][number];
export type ManifestAuth = Manifest['auth'];
export type AuthField = ManifestAuth['fields'][number];

/** Every expression in a manifest, with the block it is evaluated in and where it sits. */
export interface ManifestExpression {
  block: ExpressionBlock;
  language: 'cel' | 'jsonata';
  source: string;
  path: string;
}

/** The places an expression can sit; each has its own inputs (services/expression-evaluator). */
export const EXPRESSION_BLOCKS = [
  'records', 'field', 'paging.next', 'pushdown.filter', 'pushdown.sort', 'pushdown.limit', 'errors.when', 'errors.retryAfter',
  'auth.sign', 'write.body', 'write.result', 'write.valueCheck', 'change.verify', 'change.decode', 'change.dedupKey', 'webhook.payload',
  // An MQTT message to its record (20.2): { topic: [levels], payload, receivedAt }.
  'source.decode',
] as const;
export type ExpressionBlock = (typeof EXPRESSION_BLOCKS)[number];

export function manifestExpressions(m: Manifest): ManifestExpression[] {
  const out: ManifestExpression[] = [];
  const cel = (block: ExpressionBlock, e: CelExpression | undefined, path: string) => {
    if (e) out.push({ block, language: 'cel', source: e.cel, path });
  };
  const jsonata = (block: ExpressionBlock, e: JsonataExpression | undefined, path: string) => {
    if (e) out.push({ block, language: 'jsonata', source: e.jsonata, path });
  };
  cel('auth.sign', m.auth.sign, 'auth.sign');
  m.errors.classify.forEach((rule, i) => {
    cel('errors.when', rule.when, `errors.classify.${i}.when`);
    cel('errors.retryAfter', rule.retryAfter, `errors.classify.${i}.retryAfter`);
  });
  m.objects.forEach((o, i) => {
    const at = `objects.${i}`;
    o.fields.forEach((f, j) => jsonata('field', f.value, `${at}.fields.${j}.value`));
    if (o.source.kind === 'rest') {
      jsonata('records', o.source.records, `${at}.source.records`);
      cel('paging.next', o.source.paging?.next, `${at}.source.paging.next`);
    }
    if (o.source.kind === 'graphql' || o.source.kind === 'soap') cel('paging.next', o.source.paging?.next, `${at}.source.paging.next`);
    if (o.source.kind === 'mqtt') jsonata('source.decode', o.source.decode, `${at}.source.decode`);
    o.pushdown.filters.forEach((f, j) => cel('pushdown.filter', f.patch, `${at}.pushdown.filters.${j}.patch`));
    o.pushdown.sort.forEach((s, j) => cel('pushdown.sort', s.patch, `${at}.pushdown.sort.${j}.patch`));
    cel('pushdown.limit', o.pushdown.limit?.patch, `${at}.pushdown.limit.patch`);
    for (const op of ['create', 'update', 'updateFull', 'delete', 'upsert'] as const) {
      const w = o.writes?.[op];
      jsonata('write.body', w?.body, `${at}.writes.${op}.body`);
      jsonata('write.result', w?.result, `${at}.writes.${op}.result`);
    }
    cel('write.valueCheck', o.writes?.bounds.valueCheck, `${at}.writes.bounds.valueCheck`);
  });
  if (m.changeStream !== undefined) {
    cel('change.verify', m.changeStream.webhook?.verify, 'changeStream.webhook.verify');
    jsonata('change.decode', m.changeStream.webhook?.decode, 'changeStream.webhook.decode');
    m.changeStream.objects.forEach((s, i) => cel('change.dedupKey', s.dedupKey, `changeStream.objects.${i}.dedupKey`));
  }
  return out;
}
