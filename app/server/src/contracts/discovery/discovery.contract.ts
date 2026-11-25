// discovery: agent discovery (spec 19; design: connect.discovery_settings, discovery_authorisations,
// discovery_runs, discovery_findings, discovery_probes). The Silo Agent finds systems on the
// customer's network and reads their structure, and discovery turns what it finds into
// proposals: a connector per finding, object types and links for the ontology. It reads
// structure only, it connects nothing, and it is compiled out of the sovereign build.
//
// - Off by default; off means unreachable: with the switch off every request but the
//   switch's own is refused, and scans in progress stop. Only discovery.manage, held
//   organisation-wide (a super admin), turns it on (spec 19.1).
// - Enabling authorises nothing. Each scan has its own authorisation: one agent, explicit
//   ranges or hosts (never a default subnet), the methods allowed, a host bound, an expiry.
//   It is routed through an approval chain (spec 44) and runs only once approved, unexpired
//   and unrevoked. The approver quotes the authorisation's document hash, as a mutation's
//   approver quotes its diff.
// - Every probe is logged, one row and one host_probed event each. The cell refuses a probe
//   outside the authorised ranges or methods, and stops a run past its host bound.
// - A finding is a proposal: what was found (product, schemas, tables, columns, keys, row
//   counts; never a row), a suggested connector, object types and links. A reviewer
//   (discovery.review) approves or rejects it; approving one with a catalogue promotes it to
//   a private connector and a draft connection through connect-registry, and may start an
//   ontology derivation. Credentials are supplied through the normal path afterwards.

import { z } from 'zod';
import { defineContract } from '../endpoint.contract.ts';

export const DISCOVERY_METHODS = ['port_scan', 'host_config', 'catalogue_introspection', 'opcua_browse', 'mqtt_observe'] as const;
export type DiscoveryMethod = (typeof DISCOVERY_METHODS)[number];
export const PROBE_OUTCOMES = ['open', 'closed', 'identified', 'refused', 'error'] as const;

/** Spec 19.3: targets. */
export const DEFAULT_MAX_HOSTS = 1_000;
/** An authorisation is a window, not standing permission. */
export const MAX_AUTHORISATION_DAYS = 31;

const identifierName = z.string().trim().min(1).max(128);
const ipv4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;
const hostname = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/;

/** One explicit target: an IPv4 address, an IPv4 CIDR range no wider than /16, or a host name. */
export const target = z.string().trim().toLowerCase().max(253).refine((t) => {
  const [address, bits, extra] = t.split('/');
  if (extra !== undefined) return false;
  if (bits === undefined) return ipv4.test(t) || (hostname.test(t) && !/^\d+(\.\d+)*$/.test(t));
  return ipv4.test(address!) && /^\d{1,2}$/.test(bits) && Number(bits) >= 16 && Number(bits) <= 32;
}, 'an IPv4 address, a CIDR range of /16 or narrower, or a host name');

// ----------------------------------------------------------------------------- what the agent reports

const column = z.strictObject({
  name: identifierName,
  /** The source's own type name, as the catalogue states it. */
  type: z.string().trim().min(1).max(64),
  nullable: z.boolean(),
});
const table = z.strictObject({
  name: identifierName,
  rowCount: z.int().min(0).nullable(),
  columns: z.array(column).max(2_000),
  primaryKey: z.array(identifierName).max(16),
  uniqueKeys: z.array(z.array(identifierName).min(1).max(16)).max(50),
  foreignKeys: z.array(z.strictObject({
    columns: z.array(identifierName).min(1).max(16),
    targetSchema: identifierName.nullable(),
    targetTable: identifierName,
    targetColumns: z.array(identifierName).min(1).max(16),
  })).max(200),
});

/**
 * An OPC UA server's structure (spec 19.4, 20.3): per family of instances (the server's own
 * object type, or a folder of untyped objects), the folder holding them, how many, their
 * variables' browse paths, data types and whether writable (attributes, never a value), and
 * the child objects of other types. Names only.
 */
export const opcUaStructure = z.strictObject({
  namespaceUris: z.array(z.string().max(500)).max(200),
  types: z.array(z.strictObject({
    name: z.string().trim().min(1).max(256),
    /** The server's object type by namespace URI; empty for a folder of untyped objects. */
    typeDefinition: z.string().max(1_300),
    root: z.string().min(1).max(1_300),
    instances: z.int().min(0),
    variables: z.array(z.strictObject({ path: z.string().min(1).max(1_000), dataType: z.string().max(128), writable: z.boolean() })).max(2_000),
    references: z.array(z.strictObject({ path: z.string().min(1).max(1_000), type: z.string().max(256) })).max(500),
  })).max(2_000),
  truncated: z.boolean(),
});
export type OpcUaStructure = z.infer<typeof opcUaStructure>;

/**
 * An MQTT broker's structure (spec 19.3, 20.2): topic families (+ where a level is an
 * identifier), how many topics each, the payload's encoding, and a JSON payload's field names
 * and JSON types. Payloads are inspected in the agent and discarded: never a value.
 */
export const mqttStructure = z.strictObject({
  families: z.array(z.strictObject({
    filter: z.string().min(1).max(1_024),
    topics: z.int().min(0),
    /** sparkplug_b: a Sparkplug B payload's metric names and types (D211). */
    encoding: z.enum(['json', 'text', 'sparkplug_b', 'binary']),
    fields: z.array(z.strictObject({ name: z.string().min(1).max(256), type: z.enum(['null', 'boolean', 'number', 'string', 'array', 'object']) })).max(500),
  })).max(2_000),
  truncated: z.boolean(),
});
export type MqttStructure = z.infer<typeof mqttStructure>;

/** Structure only (spec 19.3): the fields a finding may carry. Nothing here can hold a row. */
export const foundStructure = z.strictObject({
  product: z.string().trim().min(1).max(100).nullable(),
  version: z.string().trim().min(1).max(50).nullable(),
  /** How it would be reached: one of Connect's protocols, or other. */
  protocol: z.enum(['sql', 'rest', 'graphql', 'soap', 'odata', 'sftp', 'mqtt', 'opc_ua', 'other']),
  /** For SQL: the grammar the SQL engine would speak. */
  dialect: z.string().regex(/^[a-z][a-z0-9_]{1,31}$/).nullable(),
  port: z.int().min(1).max(65_535).nullable(),
  schemas: z.array(z.strictObject({ name: identifierName, tables: z.array(table).max(2_000) })).max(200),
  /** OPC UA node classes and MQTT topic families: names only. */
  nodeClasses: z.array(identifierName).max(2_000),
  topics: z.array(z.string().trim().min(1).max(256)).max(2_000),
  /** An industrial finding's structure (OPC UA browse, MQTT topic observation). */
  opcua: opcUaStructure.optional(),
  mqtt: mqttStructure.optional(),
});
export type FoundStructure = z.infer<typeof foundStructure>;

export const proposedObjectType = z.object({
  /** schema.table, or the node class or topic family. */
  sourceObject: z.string(),
  apiName: z.string(),
  /** An existing object type it matches by name and structure, if any. */
  matches: z.object({ objectTypeId: z.uuid(), apiName: z.string(), score: z.number() }).nullable(),
  /** Identifier proposals: the primary key, else the first unique key; match key candidates (spec 23). */
  identifier: z.array(z.string()),
  fields: z.int(),
  rowCount: z.int().nullable(),
});
export const proposedLink = z.object({
  from: z.string(),
  to: z.string(),
  fromColumns: z.array(z.string()),
  toColumns: z.array(z.string()),
  cardinality: z.enum(['one_to_one', 'many_to_one']),
  /** declared: a foreign key; inferred: matching names and types, at lower confidence. */
  origin: z.enum(['declared', 'inferred']),
  confidence: z.number().min(0).max(1),
});

// ----------------------------------------------------------------------------- views

export const settingsView = z.object({
  enabled: z.boolean(),
  enabledBy: z.uuid().nullable(),
  enabledAt: z.string().nullable(),
  disabledAt: z.string().nullable(),
});

export const authorisationView = z.object({
  id: z.uuid(),
  agentId: z.uuid(),
  ranges: z.array(z.string()),
  methods: z.array(z.enum(DISCOVERY_METHODS)),
  maxHosts: z.int(),
  expiresAt: z.string(),
  authorisedBy: z.uuid(),
  approvalChainId: z.uuid(),
  /** The approval chain's status, or expired/revoked where the authorisation itself is. */
  status: z.enum(['pending', 'approved', 'rejected', 'expired', 'revoked']),
  /** SHA-256 of the authorisation document, hex: what an approver quotes. */
  documentHash: z.string().regex(/^[0-9a-f]{64}$/),
  createdAt: z.string(),
  revokedAt: z.string().nullable(),
});
export type AuthorisationView = z.infer<typeof authorisationView>;

export const runView = z.object({
  id: z.uuid(),
  authorisationId: z.uuid(),
  status: z.enum(['running', 'completed', 'failed', 'revoked']),
  hostsContacted: z.int(),
  probes: z.int(),
  findings: z.int(),
  /** Codes: why it failed or stopped, and events the cell refused. */
  reasons: z.array(z.string().max(200)),
  startedAt: z.string(),
  completedAt: z.string().nullable(),
});
export type RunView = z.infer<typeof runView>;

export const findingView = z.object({
  id: z.uuid(),
  runId: z.uuid(),
  host: z.string(),
  found: foundStructure,
  proposedConnectorType: z.string().nullable(),
  proposedObjectTypes: z.array(proposedObjectType),
  proposedLinks: z.array(proposedLink),
  confidence: z.number().nullable(),
  reviewDecision: z.enum(['pending', 'approved', 'rejected']),
  reviewedBy: z.uuid().nullable(),
  reviewedAt: z.string().nullable(),
  promotedConnectorId: z.uuid().nullable(),
  promotedConnectionId: z.uuid().nullable(),
  ontologyProposalId: z.uuid().nullable(),
  createdAt: z.string(),
});
export type FindingView = z.infer<typeof findingView>;

// ----------------------------------------------------------------------------- endpoints

export const getDiscoverySettings = defineContract({
  service: 'discovery', name: 'getDiscoverySettings', method: 'GET', path: '/v1/discovery/settings', callers: ['gateway'],
  context: 'organisation', idempotency: 'none',
  response: settingsView,
});

/** discovery.manage, held organisation-wide: never delegable to a scope admin (spec 19.1). */
export const setDiscoveryEnabled = defineContract({
  service: 'discovery', name: 'setDiscoveryEnabled', method: 'PUT', path: '/v1/discovery/settings', callers: ['gateway'],
  // Setting the switch to where it is changes nothing.
  context: 'organisation', idempotency: 'none',
  body: z.strictObject({ enabled: z.boolean() }),
  response: settingsView,
  maxBodyBytes: 512,
});

export const requestScanAuthorisation = defineContract({
  service: 'discovery', name: 'requestScanAuthorisation', method: 'POST', path: '/v1/discovery/authorisations', callers: ['gateway'],
  context: 'organisation', idempotency: 'keyed',
  body: z.strictObject({
    agentId: z.uuid(),
    ranges: z.array(target).min(1).max(64).refine((r) => new Set(r).size === r.length, 'each target once'),
    methods: z.array(z.enum(DISCOVERY_METHODS)).min(1).max(DISCOVERY_METHODS.length).refine((m) => new Set(m).size === m.length, 'each method once'),
    maxHosts: z.int().min(1).max(65_536).default(DEFAULT_MAX_HOSTS),
    expiresAt: z.iso.datetime({ offset: true }),
  }),
  response: authorisationView,
  status: 201,
  maxBodyBytes: 16_384,
});

export const listScanAuthorisations = defineContract({
  service: 'discovery', name: 'listScanAuthorisations', method: 'GET', path: '/v1/discovery/authorisations', callers: ['gateway'],
  context: 'organisation', idempotency: 'none',
  query: z.strictObject({ limit: z.coerce.number().int().min(1).max(200).default(50) }),
  response: z.object({ authorisations: z.array(authorisationView) }),
});

export const getScanAuthorisation = defineContract({
  service: 'discovery', name: 'getScanAuthorisation', method: 'GET', path: '/v1/discovery/authorisations/:authorisationId',
  callers: ['gateway'], context: 'organisation', idempotency: 'none',
  params: z.strictObject({ authorisationId: z.uuid() }),
  response: authorisationView,
});

export const revokeScanAuthorisation = defineContract({
  service: 'discovery', name: 'revokeScanAuthorisation', method: 'POST', path: '/v1/discovery/authorisations/:authorisationId/revoke',
  callers: ['gateway'],
  // Revoking is set once; a second revoke answers the same.
  context: 'organisation', idempotency: 'none',
  params: z.strictObject({ authorisationId: z.uuid() }),
  response: authorisationView,
  maxBodyBytes: 512,
});

export const startScan = defineContract({
  service: 'discovery', name: 'startScan', method: 'POST', path: '/v1/discovery/authorisations/:authorisationId/runs', callers: ['gateway'],
  context: 'organisation', idempotency: 'keyed',
  params: z.strictObject({ authorisationId: z.uuid() }),
  response: runView,
  // The run continues after the reply.
  status: 202,
  maxBodyBytes: 512,
});

export const getScanRun = defineContract({
  service: 'discovery', name: 'getScanRun', method: 'GET', path: '/v1/discovery/runs/:runId', callers: ['gateway'],
  context: 'organisation', idempotency: 'none',
  params: z.strictObject({ runId: z.uuid() }),
  response: runView,
});

/** An authorisation's scan runs, newest first (D261): where a person finds a run again after leaving it. */
export const listScanRuns = defineContract({
  service: 'discovery', name: 'listScanRuns', method: 'GET', path: '/v1/discovery/authorisations/:authorisationId/runs', callers: ['gateway'],
  context: 'organisation', idempotency: 'none',
  params: z.strictObject({ authorisationId: z.uuid() }),
  query: z.strictObject({ limit: z.coerce.number().int().min(1).max(100).default(20) }),
  response: z.object({ runs: z.array(runView) }),
});

export const listFindings = defineContract({
  service: 'discovery', name: 'listFindings', method: 'GET', path: '/v1/discovery/findings', callers: ['gateway'],
  context: 'organisation', idempotency: 'none',
  query: z.strictObject({
    runId: z.uuid().optional(),
    decision: z.enum(['pending', 'approved', 'rejected']).optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  }),
  response: z.object({ findings: z.array(findingView) }),
});

export const getFinding = defineContract({
  service: 'discovery', name: 'getFinding', method: 'GET', path: '/v1/discovery/findings/:findingId', callers: ['gateway'],
  context: 'organisation', idempotency: 'none',
  params: z.strictObject({ findingId: z.uuid() }),
  response: findingView,
});

/**
 * discovery.review. Approving with promote creates a private connector, its first version and
 * a draft connection, as the reviewer (who needs connector.build and connection.create where
 * the connection will live); with proposeOntology, an ontology derivation from that connection.
 */
export const reviewFinding = defineContract({
  service: 'discovery', name: 'reviewFinding', method: 'POST', path: '/v1/discovery/findings/:findingId/review', callers: ['gateway'],
  context: 'organisation', idempotency: 'keyed',
  params: z.strictObject({ findingId: z.uuid() }),
  body: z.strictObject({
    decision: z.enum(['approve', 'reject']),
    promote: z.strictObject({
      owningScopeId: z.uuid(),
      name: z.string().trim().min(1).max(200).optional(),
      proposeOntology: z.boolean().default(false),
    }).optional(),
  }).refine((b) => b.decision === 'approve' || b.promote === undefined, 'only an approval promotes'),
  response: findingView,
  maxBodyBytes: 2_048,
});
