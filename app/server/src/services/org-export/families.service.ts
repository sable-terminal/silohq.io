// The artefacts of an organisation export (spec 2.6), family by family, each with the
// markings it carries. Rows are read as the application role under the organisation's
// context, so row-level security bounds them to the tenant; each artefact names the
// markings of what it describes, and the run omits any the requester is not cleared for.
//
// Formats: rows are written as the database holds them (jsonb, snake_case keys), and every
// table an artefact draws on has a JSON Schema in schemas/tables, generated from the
// release's catalogue. Record values sealed at rest (receipt documents, captured values,
// extractions) are opened through the credential service for the export, never logged.
//
// Markings come from three places: markings on an object type (iam.object_type_markings),
// on a resource (gov.resource_markings: connections, properties, mappings, link types,
// action types, Siloes, views, apps, functions, interfaces), and on lineage artefacts,
// direct or inherited (gov.artefact_markings by lineage node).

import { stringify as yaml } from 'yaml';
import { z } from 'zod';
import { manifestSchema } from '../../contracts/connect/manifest.contract.ts';
import { openRecordValues, type ValueBinding } from '../../contracts/credential/recordValue.contract.ts';
import { exportObjectIndex } from '../../contracts/index-builder/index.contract.ts';
import type { ExportFamily, ExportFormat } from '../../contracts/org-export/export.contract.ts';
import type { HandlerContext } from '../../infra/http.infra.ts';
import type { Logger } from '../../infra/logger.infra.ts';
import type { ObjectKey, ObjectStore } from '../../infra/objectStorage.infra.ts';
import { inTransaction, type Databases } from '../../infra/postgres.infra.ts';
import type { ServiceClient } from '../../infra/serviceClient.infra.ts';
import { tenantDataRepo, type TenantTable } from '../../repos/platform/tenantData.repo.ts';
import { rowsToParquet } from '../../utils/parquet.util.ts';
import { canonicalTimestamp } from '../../utils/time.util.ts';

export type Context = Pick<HandlerContext, 'request' | 'correlationId'>;

export interface OrgExportDeps {
  databases: Databases;
  objects: ObjectStore;
  services: ServiceClient;
  logger: Logger;
  /** The largest one artefact may be: each is built in memory, while the bundle streams. */
  maxArtefactBytes: number;
  now?: () => Date;
}

export interface Artefact {
  family: ExportFamily;
  /** Unique within the family; an omitted artefact is named by it. */
  name: string;
  format: ExportFormat;
  /** Where it sits in the bundle. */
  path: string;
  markings: readonly string[];
  rows: number;
  body(): Promise<Buffer>;
}

type Row = Record<string, unknown>;
const json = (value: unknown): Buffer => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
const jsonl = (lines: readonly string[]): Buffer => Buffer.from(lines.map((l) => `${l}\n`).join(''));
const str = (value: unknown): string => String(value);
/** A file-safe name: letters, digits, dot, dash and underscore. */
const safe = (value: string): string => value.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 120) || '_';
const hexOf = (value: unknown): unknown => (typeof value === 'string' && value.startsWith('\\x') ? value.slice(2) : value);

function csv(rows: readonly Row[], columns: readonly string[]): Buffer {
  const cell = (value: unknown): string => {
    const text = value === null || value === undefined ? '' : typeof value === 'object' ? JSON.stringify(value) : String(hexOf(value));
    return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  return Buffer.from([columns.join(','), ...rows.map((r) => columns.map((c) => cell(r[c])).join(','))].map((l) => `${l}\r\n`).join(''));
}

const by = <T extends Row>(rows: readonly T[], key: string): Map<string, T[]> => {
  const out = new Map<string, T[]>();
  for (const row of rows) {
    const k = row[key];
    if (typeof k !== 'string') continue;
    out.set(k, [...(out.get(k) ?? []), row]);
  }
  return out;
};

/** What a JSON Schema says a Postgres type holds, as the export writes it. */
function jsonType(type: string): Record<string, unknown> {
  if (type.endsWith('[]')) return { type: 'array', items: jsonType(type.slice(0, -2)) };
  if (type === 'uuid') return { type: 'string', format: 'uuid' };
  if (type.startsWith('timestamp')) return { type: 'string', format: 'date-time' };
  if (type === 'date') return { type: 'string', format: 'date' };
  if (type === 'boolean') return { type: 'boolean' };
  if (['integer', 'smallint', 'bigint'].includes(type)) return { type: 'integer' };
  if (type.startsWith('numeric') || type === 'double precision' || type === 'real') return { type: 'number' };
  if (type === 'jsonb' || type === 'json') return {};
  if (type === 'bytea') return { type: 'string', description: 'bytes, as \\x and lowercase hex' };
  return { type: 'string' };
}

// ----------------------------------------------------------------------------- the reader

export interface Reader {
  rows(table: string): Promise<Row[]>;
  /** Rows as jsonb text, unparsed, for output that must keep every digit (bigint identities). */
  text(table: string): Promise<string[]>;
  byId(table: string, ids: readonly string[]): Promise<Row[]>;
  /** The family now being read, which the schema of each table it first reads is filed under. */
  family: ExportFamily;
  /** The tables the artefacts draw on, for their JSON Schemas, and the family that first read each. */
  used: Map<string, ExportFamily>;
  columnTypes(table: string): Promise<{ name: string; type: string; nullable: boolean }[]>;
}

export async function createReader(deps: OrgExportDeps, organisationId: string): Promise<Reader> {
  const pool = deps.databases.pool('control');
  const tx = <T>(work: Parameters<typeof inTransaction<T>>[2]) => inTransaction(pool, { organisationId }, work, { readOnly: true });
  const tables = new Map((await tx((db) => tenantDataRepo.tenantTables(db))).map((t) => [`${t.schema}.${t.table}`, t]));
  const cache = new Map<string, string[]>();
  const table = (name: string): TenantTable => {
    const found = tables.get(name);
    if (found === undefined) throw new Error(`no tenant table ${name}`);
    return found;
  };
  const used = new Map<string, ExportFamily>();
  const reader = { family: 'connector_manifests' as ExportFamily };
  const note = (name: string) => {
    if (!used.has(name)) used.set(name, reader.family);
  };
  const text = async (name: string): Promise<string[]> => {
    note(name);
    let rows = cache.get(name);
    if (rows === undefined) {
      rows = await tx((db) => tenantDataRepo.fullRows(db, table(name), organisationId));
      cache.set(name, rows);
    }
    return rows;
  };
  return Object.assign(reader, {
    used,
    text,
    async rows(name: string) {
      return (await text(name)).map((r) => JSON.parse(r) as Row);
    },
    async byId(name: string, ids: readonly string[]) {
      note(name);
      return (await tx((db) => tenantDataRepo.rowsById(db, table(name), ids))).map((r) => JSON.parse(r) as Row);
    },
    columnTypes: (name: string) => tx((db) => tenantDataRepo.columnTypes(db, table(name))),
  });
}

// ----------------------------------------------------------------------------- markings

export interface Markings {
  objectType(id: unknown): string[];
  resource(column: string, id: unknown): string[];
  artefact(kind: string, refId: unknown): string[];
}

export async function loadMarkings(read: Reader): Promise<Markings> {
  const objectTypes = new Map<string, string[]>();
  const add = (map: Map<string, string[]>, key: string, marking: string) => map.set(key, [...(map.get(key) ?? []), marking]);
  for (const r of await read.rows('iam.object_type_markings')) add(objectTypes, str(r['object_type_id']), str(r['marking_id']));
  const resources = new Map<string, string[]>();
  const COLUMNS = ['connection_id', 'property_mapping_id', 'property_id', 'link_type_id', 'action_type_id', 'silo_id', 'view_id', 'app_id', 'function_id', 'interface_id'];
  for (const r of await read.rows('gov.resource_markings')) {
    for (const c of COLUMNS) if (typeof r[c] === 'string') add(resources, `${c}:${str(r[c])}`, str(r['marking_id']));
  }
  const nodes = new Map((await read.rows('gov.lineage_nodes')).map((n) => [str(n['id']), n]));
  const artefacts = new Map<string, string[]>();
  for (const r of await read.rows('gov.artefact_markings')) {
    if (r['removed_at'] !== null) continue;
    const node = nodes.get(str(r['lineage_node_id']));
    if (node !== undefined) add(artefacts, `${str(node['kind'])}:${str(node['ref_id'])}`, str(r['marking_id']));
  }
  return {
    objectType: (id) => (typeof id === 'string' ? objectTypes.get(id) ?? [] : []),
    resource: (column, id) => (typeof id === 'string' ? resources.get(`${column}:${id}`) ?? [] : []),
    artefact: (kind, refId) => (typeof refId === 'string' ? artefacts.get(`${kind}:${refId}`) ?? [] : []),
  };
}

const union = (...lists: (readonly string[])[]): string[] => [...new Set(lists.flat())];

// ----------------------------------------------------------------------------- sealed values

async function openValues(deps: OrgExportDeps, ctx: Context, items: { binding: ValueBinding; sealed: unknown }[]): Promise<unknown[]> {
  const out: unknown[] = [];
  for (let i = 0; i < items.length; i += 5_000) {
    const chunk = items.slice(i, i + 5_000);
    const opened = await deps.services.call(openRecordValues, {
      body: { items: chunk.map((c) => ({ binding: c.binding, sealed: Buffer.from(String(hexOf(c.sealed)), 'hex').toString('base64') })) },
    }, { request: ctx.request, correlationId: ctx.correlationId });
    out.push(...opened.items.map((v) => JSON.parse(Buffer.from(v, 'base64').toString('utf8')) as unknown));
  }
  return out;
}

// ----------------------------------------------------------------------------- the families

/** What could not be carried because its stored object is gone; the manifest and receipt name each. */
export interface Missing { family: ExportFamily; artefact: string }

export async function collectArtefacts(deps: OrgExportDeps, ctx: Context, read: Reader, markings: Markings, missing: Missing[] = [])
  : Promise<Artefact[]> {
  const out: Artefact[] = [];
  const add = (a: Artefact) => out.push(a);
  const doc = (family: ExportFamily, name: string, path: string, marks: readonly string[], value: unknown, rows = 1) =>
    add({ family, name, format: 'json', path, markings: marks, rows, body: async () => json(value) });

  // Connector manifests: every version the organisation authored or its connections run.
  read.family = 'connector_manifests';
  const connectors = await read.rows('connect.connectors');
  const manifests = await read.rows('connect.connector_manifests');
  const connections = await read.rows('connect.connections');
  const fromCatalogue = [...new Set(connections.map((c) => str(c['manifest_id'])))].filter((id) => !manifests.some((m) => m['id'] === id));
  const catalogueManifests = await read.byId('connect.connector_manifests', fromCatalogue);
  const allConnectors = [...connectors, ...await read.byId('connect.connectors',
    [...new Set(catalogueManifests.map((m) => str(m['connector_id'])))].filter((id) => !connectors.some((c) => c['id'] === id)))];
  for (const m of [...manifests, ...catalogueManifests]) {
    const connector = allConnectors.find((c) => c['id'] === m['connector_id']);
    const slug = safe(str(connector?.['slug'] ?? m['connector_id']));
    add({
      family: 'connector_manifests', name: `${slug}@${str(m['version'])}`, format: 'yaml', path: `connectors/${slug}/${safe(str(m['version']))}.yaml`,
      markings: markings.artefact('connector_version', m['id']), rows: 1, body: async () => Buffer.from(yaml(m['document'])),
    });
  }
  doc('connector_manifests', 'schema:connector-manifest', 'schemas/connector-manifest.schema.json', [],
    z.toJSONSchema(manifestSchema, { unrepresentable: 'any', io: 'input' }));

  // Ontology: object types with every version, property, mapping and time field.
  read.family = 'ontology';
  const types = await read.rows('ontology.object_types');
  const versions = by(await read.rows('ontology.object_type_versions'), 'object_type_id');
  const properties = by(await read.rows('ontology.properties'), 'object_type_version_id');
  const mappings = by(await read.rows('ontology.property_mappings'), 'object_type_version_id');
  const timeFields = by(await read.rows('ontology.time_fields'), 'object_type_version_id');
  const identities = by(await read.rows('ontology.property_identities'), 'object_type_id');
  const implementations = by(await read.rows('ontology.interface_implementations'), 'object_type_version_id');
  const typeName = new Map(types.map((t) => [str(t['id']), safe(str(t['api_name']))]));
  const typeMarkings = new Map<string, string[]>();
  for (const t of types) {
    const id = str(t['id']);
    const vs = versions.get(id) ?? [];
    const of = (m: Map<string, Row[]>) => vs.flatMap((v) => m.get(str(v['id'])) ?? []);
    const props = of(properties);
    const maps = of(mappings);
    const marks = union(markings.objectType(id),
      ...props.map((p) => markings.resource('property_id', p['id'])), ...props.map((p) => markings.resource('property_id', p['property_identity_id'])),
      ...maps.map((m) => markings.resource('property_mapping_id', m['id'])), ...maps.map((m) => markings.resource('connection_id', m['connection_id'])));
    typeMarkings.set(id, marks);
    doc('ontology', `object_type:${typeName.get(id)!}`, `ontology/object-types/${typeName.get(id)!}.json`, marks, {
      objectType: t, versions: vs, propertyIdentities: identities.get(id) ?? [], properties: props, propertyMappings: maps,
      timeFields: of(timeFields), interfaceImplementations: of(implementations),
    }, vs.length);
  }
  const typeMarks = (id: unknown) => (typeof id === 'string' ? typeMarkings.get(id) ?? markings.objectType(id) : []);
  const routes = by(await read.rows('ontology.link_type_routes'), 'link_type_id');
  for (const l of await read.rows('ontology.link_types')) {
    const name = safe(str(l['api_name']));
    doc('ontology', `link_type:${name}`, `ontology/link-types/${name}.json`,
      union(markings.resource('link_type_id', l['id']), typeMarks(l['from_type_id']), typeMarks(l['to_type_id'])),
      { linkType: l, routes: routes.get(str(l['id'])) ?? [] });
  }
  const required = by(await read.rows('ontology.interface_required_properties'), 'interface_id');
  for (const i of await read.rows('ontology.interfaces')) {
    const name = safe(str(i['api_name']));
    doc('ontology', `interface:${name}`, `ontology/interfaces/${name}.json`, markings.resource('interface_id', i['id']),
      { interface: i, requiredProperties: required.get(str(i['id'])) ?? [] });
  }
  const shared = await read.rows('ontology.shared_properties');
  doc('ontology', 'shared_properties', 'ontology/shared-properties.json', [], { sharedProperties: shared }, shared.length);
  const actionVersions = by(await read.rows('action.action_type_versions'), 'action_type_id');
  const parameters = by(await read.rows('action.action_parameters'), 'action_type_version_id');
  const actionTypes = await read.rows('action.action_types');
  for (const a of actionTypes) {
    const name = safe(str(a['api_name']));
    const vs = actionVersions.get(str(a['id'])) ?? [];
    const params = vs.flatMap((v) => parameters.get(str(v['id'])) ?? []);
    doc('ontology', `action_type:${name}`, `ontology/action-types/${name}.json`,
      union(markings.resource('action_type_id', a['id']), ...params.map((p) => typeMarks(p['object_type_id']))),
      { actionType: a, versions: vs, parameters: params }, vs.length);
  }
  const functionVersions = by(await read.rows('ontology.function_versions'), 'function_id');
  for (const f of await read.rows('ontology.functions')) {
    const name = safe(str(f['api_name']));
    const vs = functionVersions.get(str(f['id'])) ?? [];
    doc('ontology', `function:${name}`, `ontology/functions/${name}.json`, markings.resource('function_id', f['id']), { function: f, versions: vs }, vs.length);
  }

  // Resolution: confirmed exact mappings (match keys, keyed hashes only) and field authorities, CSV and JSON.
  read.family = 'resolution';
  const matchKeys = by(await read.rows('ontology.match_keys'), 'object_type_id');
  const authorities = by(await read.rows('ontology.field_authorities'), 'object_type_id');
  const redirects = by(await read.rows('ontology.object_redirects'), 'object_type_id');
  const KEY_COLUMNS = ['id', 'object_type_id', 'silo_object_id', 'connection_id', 'source_object', 'source_identifier_hash', 'match_key_hash',
    'hmac_key_version_id', 'origin', 'resolution_proposal_id', 'first_seen_at', 'last_seen_at', 'superseded_at'];
  const AUTHORITY_COLUMNS = ['id', 'object_type_id', 'property_identity_id', 'winning_connection_id', 'condition', 'declared_by', 'declared_at',
    'reason', 'revoked_by', 'revoked_at'];
  for (const t of types) {
    const id = str(t['id']);
    const keys = matchKeys.get(id) ?? [];
    const auth = authorities.get(id) ?? [];
    if (keys.length === 0 && auth.length === 0 && (redirects.get(id) ?? []).length === 0) continue;
    const name = typeName.get(id)!;
    const marks = typeMarks(id);
    doc('resolution', `resolution:${name}`, `resolution/${name}.json`, marks,
      { matchKeys: keys, fieldAuthorities: auth, redirects: redirects.get(id) ?? [] }, keys.length + auth.length);
    add({ family: 'resolution', name: `match_keys:${name}`, format: 'csv', path: `resolution/${name}/match-keys.csv`, markings: marks,
      rows: keys.length, body: async () => csv(keys, KEY_COLUMNS) });
    add({ family: 'resolution', name: `field_authorities:${name}`, format: 'csv', path: `resolution/${name}/field-authorities.csv`, markings: marks,
      rows: auth.length, body: async () => csv(auth, AUTHORITY_COLUMNS) });
  }

  // Applications, views, Crons and scenarios: their validated definitions.
  read.family = 'applications';
  const appVersions = by(await read.rows('workspace.app_versions'), 'app_id');
  const appReferences = by(await read.rows('workspace.app_references'), 'app_version_id');
  const publications = by(await read.rows('workspace.app_publications'), 'app_id');
  for (const a of await read.rows('workspace.apps')) {
    const id = str(a['id']);
    const vs = appVersions.get(id) ?? [];
    doc('applications', `app:${id}`, `applications/${id}.json`,
      union(markings.resource('app_id', id), ...vs.map((v) => (v['markings'] as string[] | null) ?? []), ...vs.map((v) => markings.artefact('app_version', v['id']))),
      { app: a, versions: vs, references: vs.flatMap((v) => appReferences.get(str(v['id'])) ?? []), publications: publications.get(id) ?? [] }, vs.length);
  }
  read.family = 'views';
  const views = await read.rows('workspace.saved_views');
  const compiled = new Map((await read.rows('ontology.compiled_manifests')).map((m) => [str(m['id']), m]));
  const viewMarks = (id: unknown) => union(markings.resource('view_id', id), markings.artefact('view', id));
  for (const v of views) {
    const id = str(v['id']);
    doc('views', `view:${id}`, `views/${id}.json`, viewMarks(id), { view: v, manifest: compiled.get(str(v['manifest_id'])) ?? null });
  }
  read.family = 'crons';
  const conditions = by(await read.rows('automation.automation_conditions'), 'automation_id');
  const steps = by(await read.rows('automation.automation_actions'), 'automation_id');
  const cronConnections = by(await read.rows('automation.automation_connections'), 'automation_id');
  for (const c of await read.rows('automation.automations')) {
    const id = str(c['id']);
    doc('crons', `cron:${id}`, `crons/${id}.json`,
      union(viewMarks(c['saved_view_id']), ...(cronConnections.get(id) ?? []).map((x) => markings.resource('connection_id', x['connection_id']))),
      { cron: c, conditions: conditions.get(id) ?? [], actions: steps.get(id) ?? [], connections: cronConnections.get(id) ?? [] });
  }
  read.family = 'scenarios';
  const branches = by(await read.rows('simulation.scenario_branches'), 'scenario_id');
  const staged = by(await read.rows('simulation.staged_actions'), 'branch_id');
  for (const s of await read.rows('simulation.scenarios')) {
    const id = str(s['id']);
    const bs = branches.get(id) ?? [];
    doc('scenarios', `scenario:${id}`, `scenarios/${id}.json`, markings.artefact('scenario', id),
      { scenario: s, branches: bs, stagedActions: bs.flatMap((b) => staged.get(str(b['id'])) ?? []) });
  }

  // Receipts and audit: JSON Lines, lineage references resolved.
  read.family = 'receipts';
  const nodes = await read.rows('gov.lineage_nodes');
  const nodeById = new Map(nodes.map((n) => [str(n['id']), n]));
  const nodesByRef = by(nodes, 'ref_id');
  const edgesTo = by(await read.rows('gov.lineage_edges'), 'to_node_id');
  const ref = (n: Row) => ({ kind: n['kind'], ref_id: n['ref_id'], version: n['version'] });
  const lineageOf = (refId: string) => (nodesByRef.get(refId) ?? []).map((n) => ({
    ...ref(n),
    upstream: (edgesTo.get(str(n['id'])) ?? []).flatMap((e) => {
      const from = nodeById.get(str(e['from_node_id']));
      return from === undefined ? [] : [{ relation: e['relation'], ...ref(from) }];
    }),
  }));

  const mutations = new Map((await read.rows('action.mutations')).map((m) => [str(m['id']), m]));
  const actionVersionById = new Map([...actionVersions.values()].flat().map((v) => [str(v['id']), v]));
  const actionTypeById = new Map(actionTypes.map((a) => [str(a['id']), a]));
  const groups = new Map<string, Row[]>();
  for (const r of await read.rows('action.receipts')) {
    const mutation = mutations.get(str(r['mutation_id']));
    const version = mutation === undefined ? undefined : actionVersionById.get(str(mutation['action_type_version_id']));
    const actionType = version === undefined ? undefined : actionTypeById.get(str(version['action_type_id']));
    const group = actionType === undefined ? 'generic_edit' : safe(str(actionType['api_name']));
    const marks = union(typeMarks(mutation?.['object_type_id']), markings.resource('action_type_id', actionType?.['id']), markings.artefact('receipt', r['id']));
    if (marks.length > 0) {
      // A receipt the requester may not see is omitted on its own and named.
      add({ family: 'receipts', name: `receipt:${str(r['id'])}`, format: 'jsonl', path: '', markings: marks, rows: 1, body: async () => Buffer.alloc(0) });
      continue;
    }
    groups.set(group, [...(groups.get(group) ?? []), r]);
  }
  for (const [group, receipts] of groups) {
    add({
      family: 'receipts', name: `receipts:${group}`, format: 'jsonl', path: `receipts/${group}.jsonl`, markings: [], rows: receipts.length,
      body: async () => {
        const sealed = receipts.filter((r) => r['document'] !== null);
        const opened = await openValues(deps, ctx, sealed.map((r) => ({ binding: { table: 'action.receipts', id: str(r['id']) }, sealed: r['document'] })));
        const documents = new Map(sealed.map((r, i) => [str(r['id']), opened[i]]));
        return jsonl(receipts.map((r) => JSON.stringify({
          receipt: { ...r, document: undefined }, document: documents.get(str(r['id'])) ?? null, lineage: lineageOf(str(r['id'])),
        })));
      },
    });
  }
  // Audit rows keep every digit of their identities: each line is the row's own text.
  read.family = 'audit';
  for (const ledger of ['audit.audit_events', 'audit.auth_events'] as const) {
    const months = new Map<string, string[]>();
    for (const text of await read.text(ledger)) {
      const row = JSON.parse(text) as Row;
      const month = str(row['occurred_at']).slice(0, 7);
      const resource = typeof row['resource_id'] === 'string' ? lineageOf(row['resource_id']) : [];
      months.set(month, [...(months.get(month) ?? []), `{"row":${text},"lineage":${JSON.stringify(resource)}}`]);
    }
    const folder = ledger === 'audit.audit_events' ? 'audit/events' : 'audit/sign-in';
    for (const [month, lines] of [...months].sort()) {
      add({ family: 'audit', name: `${ledger}:${month}`, format: 'jsonl', path: `${folder}/${month}.jsonl`, markings: [], rows: lines.length, body: async () => jsonl(lines) });
    }
  }

  // Siloes: captured transitions, imported files with their extractions, in their formats plus Parquet.
  read.family = 'siloes_transitions';
  const siloes = await read.rows('siloes.siloes');
  if (siloes.length > 0) {
    const transitions = by(await read.rows('siloes.transitions'), 'silo_id');
    const files = by(await read.rows('siloes.silo_files'), 'silo_id');
    const extractions = by(await read.rows('siloes.silo_extractions'), 'file_id');
    for (const silo of siloes) {
      const siloId = str(silo['id']);
      const siloMarks = markings.resource('silo_id', siloId);
      const perType = by(transitions.get(siloId) ?? [], 'object_type_id');
      for (const [objectTypeId, ts] of perType) {
        const name = typeName.get(objectTypeId) ?? objectTypeId;
        const marks = union(siloMarks, typeMarks(objectTypeId));
        let opened: Row[] | undefined;
        const lines = async (): Promise<Row[]> => {
          if (opened !== undefined) return opened;
          const binding = (t: Row, column: 'previous_value' | 'new_value') => ({
            binding: {
              table: 'siloes.transitions', organisation_id: str(t['organisation_id']), silo_id: siloId, object_type_id: objectTypeId,
              object_ref: str(t['object_ref']), property: str(t['property']), observed_at: canonicalTimestamp(str(t['observed_at'])),
            } as ValueBinding,
            sealed: t[column],
          });
          const withPrevious = ts.filter((t) => t['previous_value'] !== null);
          const previous = await openValues(deps, ctx, withPrevious.map((t) => binding(t, 'previous_value')));
          const next = await openValues(deps, ctx, ts.map((t) => binding(t, 'new_value')));
          const previousOf = new Map(withPrevious.map((t, i) => [t, previous[i]]));
          opened = ts.map((t, i) => ({
            object_ref: t['object_ref'], property: t['property'], observed_at: t['observed_at'], connection_id: t['connection_id'],
            previous_value: previousOf.get(t) ?? null, new_value: next[i],
          }));
          return opened;
        };
        const base = `siloes/${siloId}/transitions/${safe(name)}`;
        add({ family: 'siloes_transitions', name: `transitions:${siloId}:${name}`, format: 'jsonl', path: `${base}.jsonl`, markings: marks,
          rows: ts.length, body: async () => jsonl((await lines()).map((l) => JSON.stringify(l))) });
        add({ family: 'siloes_transitions', name: `transitions:${siloId}:${name}:parquet`, format: 'parquet', path: `${base}.parquet`, markings: marks,
          rows: ts.length, body: async () => rowsToParquet(await lines()) });
      }
      const siloFiles = (files.get(siloId) ?? []).filter((f) => f['purged_at'] === null);
      for (const f of siloFiles) {
        const fileId = str(f['id']);
        const key = str(f['object_store_key']) as ObjectKey;
        // A file whose stored object is gone cannot be carried: it is named as missing, and
        // the export goes on (it is never withheld).
        if (await deps.objects.head('siloes', key) === undefined) {
          missing.push({ family: 'siloes_imports', artefact: `file:${fileId}` });
          deps.logger.warn('an imported file has no stored object; the export names it missing', {
            event: 'org_export.file_missing', resourceType: 'silo_file', resourceId: fileId,
          });
          continue;
        }
        add({ family: 'siloes_imports', name: `file:${fileId}`, format: 'original', path: `siloes/${siloId}/files/${fileId}/${safe(str(f['filename']))}`,
          markings: siloMarks, rows: 1, body: () => deps.objects.get('siloes', key) });
      }
      const fileExtractions = siloFiles.flatMap((f) => extractions.get(str(f['id'])) ?? []);
      if (fileExtractions.length > 0) {
        let opened: Row[] | undefined;
        const lines = async (): Promise<Row[]> => {
          if (opened !== undefined) return opened;
          const values = await openValues(deps, ctx, fileExtractions.map((e) => ({
            binding: { table: 'siloes.silo_extractions', organisation_id: str(e['organisation_id']), file_id: str(e['file_id']),
              object: str(e['object']), row_ref: str(e['row_ref']), field: str(e['field']) } as ValueBinding,
            sealed: e['value'],
          })));
          opened = fileExtractions.map((e, i) => ({ ...e, value: values[i] }));
          return opened;
        };
        add({ family: 'siloes_imports', name: `extractions:${siloId}`, format: 'jsonl', path: `siloes/${siloId}/extractions.jsonl`, markings: siloMarks,
          rows: fileExtractions.length, body: async () => jsonl((await lines()).map((l) => JSON.stringify(l))) });
        add({ family: 'siloes_imports', name: `extractions:${siloId}:parquet`, format: 'parquet', path: `siloes/${siloId}/extractions.parquet`,
          markings: siloMarks, rows: fileExtractions.length, body: async () => rowsToParquet(await lines()) });
      }
    }
  }
  // The Object Index: each nominated type's entries, read through index-builder. The
  // markings are the entries' own (object and per property) with the Silo's and the type's.
  read.family = 'siloes_index';
  const definitions = siloes.length === 0 ? [] : (await read.rows('siloes.index_definitions')).filter((d) => d['removed_at'] === null);
  for (const d of definitions) {
    const entries: Row[] = [];
    let after: string | undefined;
    for (;;) {
      const page = await deps.services.call(exportObjectIndex, { body: { definitionId: str(d['id']), limit: 1_000, ...(after ? { after } : {}) } },
        { request: ctx.request, correlationId: ctx.correlationId });
      entries.push(...page.entries.map((e) => JSON.parse(e) as Row));
      if (page.next === null) break;
      after = page.next;
    }
    const entryMarks = entries.flatMap((e) => Object.entries(e).filter(([k, v]) => k.endsWith('marking_ids') && Array.isArray(v)).flatMap(([, v]) => v as string[]));
    const marks = union(markings.resource('silo_id', d['silo_id']), typeMarks(d['object_type_id']), entryMarks);
    const name = typeName.get(str(d['object_type_id'])) ?? str(d['object_type_id']);
    const base = `siloes/${str(d['silo_id'])}/index/${safe(name)}`;
    add({ family: 'siloes_index', name: `index:${str(d['silo_id'])}:${name}`, format: 'jsonl', path: `${base}.jsonl`, markings: marks,
      rows: entries.length, body: async () => jsonl(entries.map((e) => JSON.stringify(e))) });
    add({ family: 'siloes_index', name: `index:${str(d['silo_id'])}:${name}:parquet`, format: 'parquet', path: `${base}.parquet`, markings: marks,
      rows: entries.length, body: async () => rowsToParquet(entries) });
  }
  return out;
}

/** JSON Schemas of every table the artefacts drew on, from this release's catalogue. */
export async function tableSchemas(read: Reader): Promise<Artefact[]> {
  const out: Artefact[] = [];
  for (const [name, family] of [...read.used].sort(([a], [b]) => a.localeCompare(b))) {
    const columns = await read.columnTypes(name);
    const schema = {
      $schema: 'https://json-schema.org/draft/2020-12/schema', title: name, type: 'object',
      properties: Object.fromEntries(columns.map((c) => [c.name, c.nullable ? { anyOf: [jsonType(c.type), { type: 'null' }] } : jsonType(c.type)])),
      required: columns.map((c) => c.name),
    };
    out.push({ family, name: `schema:${name}`, format: 'json', path: `schemas/tables/${name}.schema.json`, markings: [], rows: 0, body: async () => json(schema) });
  }
  return out;
}
