// Discovery's pure rules (spec 19.2 to 19.4): whether a host is inside an authorisation's
// explicit targets, the authorisation document an approver quotes, and what a finding
// proposes (a connector, object types and links) and, when promoted, the manifest of its
// private connector. Structure only throughout: names, types, keys and counts.

import { dialectFieldType, type CatalogueFieldType } from '../connect-runtime/protocols/sql/catalogueTypes.protocol.ts';
import { isDialect } from '../connect-runtime/protocols/sql/checks.protocol.ts';
import type { DiscoveryMethod, FoundStructure, MqttStructure } from '../../contracts/discovery/discovery.contract.ts';
import type { OntologyManifest } from '../../contracts/ontology/manifest.contract.ts';
import { canonicalJsonBytes } from '../../utils/canonicalJson.util.ts';
import { sha256 } from '../../utils/crypto.util.ts';

// ----------------------------------------------------------------------------- targets

const toNumber = (ip: string): number => ip.split('.').reduce((n, part) => n * 256 + Number(part), 0);
const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

/** Whether a reported host is one of the explicit targets: an address in a range, or a named host exactly. */
export function inTargets(host: string, targets: readonly string[]): boolean {
  const h = host.trim().toLowerCase();
  for (const t of targets) {
    if (!t.includes('/')) {
      if (t === h) return true;
      continue;
    }
    if (!IPV4.test(h)) continue;
    const [base, bits] = t.split('/') as [string, string];
    const width = Number(bits);
    const mask = width === 0 ? 0 : (0xffffffff << (32 - width)) >>> 0;
    if (((toNumber(h) & mask) >>> 0) === ((toNumber(base) & mask) >>> 0)) return true;
  }
  return false;
}

/** The authorisation document delivered to the agent, and its hash: what an approver quotes. */
export function authorisationDocument(a: {
  id: string; organisationId: string; agentId: string; ranges: readonly string[]; methods: readonly DiscoveryMethod[]; maxHosts: number; expiresAt: string;
  authorisedBy: string;
}): { document: Record<string, unknown>; hash: Buffer } {
  const document = {
    v: 1, kind: 'discovery_authorisation', id: a.id, organisation_id: a.organisationId, agent_id: a.agentId,
    ranges: [...a.ranges].sort(), methods: [...a.methods].sort(), max_hosts: a.maxHosts, expires_at: new Date(a.expiresAt).toISOString(),
    authorised_by: a.authorisedBy,
  };
  return { document, hash: sha256(canonicalJsonBytes(document)) };
}

// ----------------------------------------------------------------------------- proposals

/** Lower snake case, as a manifest or ontology name: starts with a letter, at most 63 characters. */
export function snake(text: string): string {
  let s = text.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60);
  if (!/^[a-z]/.test(s)) s = `t_${s}`.slice(0, 60);
  return s === '' || s === 't_' ? 'item' : s;
}

const singular = (name: string): string => (name.endsWith('ies') ? `${name.slice(0, -3)}y` : name.endsWith('ses') ? name.slice(0, -2)
  : name.endsWith('s') && !/(ss|us|is)$/.test(name) ? name.slice(0, -1) : name);
const normal = (name: string): string => singular(snake(name).replace(/_/g, ''));

export interface ProposedObjectType {
  sourceObject: string;
  apiName: string;
  matches: { objectTypeId: string; apiName: string; score: number } | null;
  identifier: string[];
  fields: number;
  rowCount: number | null;
}
export interface ProposedLink {
  from: string; to: string; fromColumns: string[]; toColumns: string[];
  cardinality: 'one_to_one' | 'many_to_one'; origin: 'declared' | 'inferred'; confidence: number;
}

/** The suggested connector: Connect's protocol, and the SQL engine's grammar where it applies. */
export const proposedConnectorType = (found: FoundStructure): string | null =>
  found.protocol === 'other' ? null : found.dialect === null ? found.protocol : `${found.protocol}:${found.dialect}`;

const sameColumns = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((c, i) => c === b[i]);

/** Object types from tables (matched to existing types by name and structure), links from keys (spec 19.4). */
export function proposeStructure(found: FoundStructure, ontology: OntologyManifest | undefined): {
  objectTypes: ProposedObjectType[]; links: ProposedLink[]; confidence: number;
} {
  const objectTypes: ProposedObjectType[] = [];
  const links: ProposedLink[] = [];
  const tables = found.schemas.flatMap((s) => s.tables.map((t) => ({ schema: s.name, table: t, source: `${s.name}.${t.name}` })));
  const taken = new Set<string>();
  for (const { table, source } of tables) {
    let apiName = singular(snake(table.name));
    for (let n = 2; taken.has(apiName); n++) apiName = `${singular(snake(table.name))}_${n}`;
    taken.add(apiName);
    let matches: ProposedObjectType['matches'] = null;
    for (const type of ontology?.objectTypes ?? []) {
      const names = [type.apiName, type.displayName].map(normal);
      const nameScore = names.includes(normal(table.name)) ? 1 : 0;
      const props = new Set(type.properties.map((p) => normal(p.apiName)));
      const overlap = table.columns.length === 0 ? 0 : table.columns.filter((c) => props.has(normal(c.name))).length / table.columns.length;
      const score = Math.round((0.6 * nameScore + 0.4 * overlap) * 100) / 100;
      if (score >= 0.6 && (matches === null || score > matches.score)) matches = { objectTypeId: type.id, apiName: type.apiName, score };
    }
    const identifier = table.primaryKey.length > 0 ? table.primaryKey : table.uniqueKeys[0] ?? [];
    objectTypes.push({ sourceObject: source, apiName, matches, identifier: [...identifier], fields: table.columns.length, rowCount: table.rowCount });

    const unique = (cols: readonly string[]) => sameColumns(cols, table.primaryKey) || table.uniqueKeys.some((k) => sameColumns(k, cols));
    for (const fk of table.foreignKeys) {
      const schema = fk.targetSchema ?? tables.find((t) => t.table.name === fk.targetTable)?.schema;
      links.push({
        from: source, to: `${schema ?? ''}.${fk.targetTable}`, fromColumns: [...fk.columns], toColumns: [...fk.targetColumns],
        cardinality: unique(fk.columns) ? 'one_to_one' : 'many_to_one', origin: 'declared', confidence: 0.9,
      });
    }
  }
  // Undeclared references (spec 19.4): <target>_id holding the type of the target's single-column key.
  for (const { table, source } of tables) {
    for (const column of table.columns) {
      const m = /^(.+?)_?id$/i.exec(column.name);
      if (m === null || table.primaryKey.includes(column.name)) continue;
      if (links.some((l) => l.from === source && l.fromColumns.length === 1 && l.fromColumns[0] === column.name)) continue;
      const target = tables.find((t) => t.source !== source && normal(t.table.name) === normal(m[1]!) && t.table.primaryKey.length === 1);
      if (target === undefined) continue;
      const key = target.table.columns.find((c) => c.name === target.table.primaryKey[0]);
      if (key === undefined || key.type.toLowerCase() !== column.type.toLowerCase()) continue;
      links.push({
        from: source, to: target.source, fromColumns: [column.name], toColumns: [key.name], cardinality: 'many_to_one', origin: 'inferred', confidence: 0.5,
      });
    }
  }
  // Industrial (spec 19.4, 20.3): an OPC UA server's types and folders, links from references; MQTT topic families.
  for (const t of found.opcua?.types ?? []) {
    const apiName = unique(taken, singular(snake(t.name)));
    const fields = ['browse_name', 'node', ...t.variables.map((v) => fieldNameOf(v.path))];
    objectTypes.push({
      sourceObject: t.name, apiName, matches: matchOf(ontology, t.name, fields), identifier: ['id'], fields: t.variables.length + 2, rowCount: t.instances,
    });
  }
  for (const t of found.opcua?.types ?? []) {
    for (const r of t.references) {
      if (!(found.opcua?.types ?? []).some((o) => o.name === r.type)) continue;
      links.push({ from: t.name, to: r.type, fromColumns: [fieldNameOf(r.path)], toColumns: ['node'], cardinality: 'one_to_one', origin: 'declared', confidence: 0.8 });
    }
  }
  for (const f of found.mqtt?.families ?? []) {
    if (f.encoding === 'binary') continue;
    const plan = mqttObject(f);
    objectTypes.push({
      sourceObject: f.filter, apiName: unique(taken, singular(plan.name)), matches: matchOf(ontology, plan.name, plan.fields.map((x) => x.name)),
      identifier: plan.identifier, fields: plan.fields.length, rowCount: f.topics,
    });
  }
  const confidence = tables.length > 0 ? 0.9 : (found.opcua?.types.length ?? 0) > 0 ? 0.8 : (found.mqtt?.families.length ?? 0) > 0 ? 0.7
    : found.product !== null ? 0.6 : 0.3;
  return { objectTypes, links, confidence };
}

/** A name not yet taken: name, name_2, name_3. */
function unique(taken: Set<string>, name: string): string {
  let out = name;
  for (let n = 2; taken.has(out); n++) out = `${name}_${n}`.slice(0, 63);
  taken.add(out);
  return out;
}

/** An existing object type a found one matches by name and fields (score at least 0.6). */
function matchOf(ontology: OntologyManifest | undefined, name: string, fields: readonly string[]): ProposedObjectType['matches'] {
  let matches: ProposedObjectType['matches'] = null;
  for (const type of ontology?.objectTypes ?? []) {
    const nameScore = [type.apiName, type.displayName].map(normal).includes(normal(name)) ? 1 : 0;
    const props = new Set(type.properties.map((p) => normal(p.apiName)));
    const overlap = fields.length === 0 ? 0 : fields.filter((f) => props.has(normal(f))).length / fields.length;
    const score = Math.round((0.6 * nameScore + 0.4 * overlap) * 100) / 100;
    if (score >= 0.6 && (matches === null || score > matches.score)) matches = { objectTypeId: type.id, apiName: type.apiName, score };
  }
  return matches;
}

/** A browse path as a field name: Motor/Speed is motor_speed. */
const fieldNameOf = (path: string): string => snake(path.replaceAll('/', '_'));

/** An OPC UA data type as a manifest field type. */
export function opcUaFieldType(dataType: string): CatalogueFieldType | 'json' {
  if (dataType === 'Boolean') return 'boolean';
  if (/^(S?Byte|U?Int(16|32|64)|U?Integer|Enumeration)$/.test(dataType)) return 'integer';
  if (/^(Float|Double|Number|Duration)$/.test(dataType)) return 'number';
  if (/^(DateTime|UtcTime)$/.test(dataType)) return 'date-time';
  if (/^(String|LocalizedText|QualifiedName|NodeId|ExpandedNodeId|Guid|XmlElement|ByteString|LocaleId|StatusCode)$/.test(dataType)) return 'string';
  return 'json';
}

const JSON_FIELD_TYPES = { null: 'json', boolean: 'boolean', number: 'number', string: 'string', array: 'json', object: 'json' } as const;

/**
 * An MQTT topic family as a manifest object: a field per + level (named by the level before it,
 * site/+ is site), a field per JSON payload field (or the text), the + fields its identifier
 * (else the topic itself), and the JSONata decode reading them.
 */
export function mqttObject(f: MqttStructure['families'][number]): {
  name: string; identifier: string[]; fields: { name: string; type: string; path?: string }[]; decode: string; topic: string;
} {
  if (f.encoding === 'sparkplug_b') return sparkplugObject(f);
  const levels = f.filter.split('/');
  const literal = levels.filter((l) => l !== '+' && l !== '#');
  const name = snake(literal.slice(-2).join('_') || 'messages');
  const taken = new Set<string>();
  const fields: { name: string; type: string }[] = [];
  const parts: string[] = [];
  const identifier: string[] = [];
  levels.forEach((level, i) => {
    if (level !== '+') return;
    const before = i > 0 && levels[i - 1] !== '+' ? levels[i - 1]! : `level_${i}`;
    const field = unique(taken, snake(before));
    fields.push({ name: field, type: 'string' });
    identifier.push(field);
    parts.push(`${JSON.stringify(field)}: topic[${i}]`);
  });
  if (identifier.length === 0) {
    const field = unique(taken, 'topic');
    fields.push({ name: field, type: 'string' });
    identifier.push(field);
    parts.push(`${JSON.stringify(field)}: $join(topic, "/")`);
  }
  if (f.encoding === 'text') {
    const field = unique(taken, 'text');
    fields.push({ name: field, type: 'string' });
    parts.push(`${JSON.stringify(field)}: payload`);
  } else {
    for (const x of f.fields) {
      const field = unique(taken, snake(x.name));
      fields.push({ name: field, type: JSON_FIELD_TYPES[x.type] });
      parts.push(`${JSON.stringify(field)}: payload.\`${x.name.replaceAll('`', '')}\``);
    }
  }
  return { name, identifier, fields, decode: `{ ${parts.join(', ')} }`, topic: f.filter };
}

/**
 * A Sparkplug B family (20.2; D211): every message of the group's devices (or edge nodes, where
 * the family has no device level), whatever its type and edge node; identified by edge node and
 * device; each observed metric read by its name. Deaths carry no values and are skipped.
 */
function sparkplugObject(f: MqttStructure['families'][number]) {
  const levels = f.filter.split('/');
  const devices = levels.length === 5;
  const group = levels[1] === '+' ? 'sparkplug' : levels[1]!;
  const topic = ['spBv1.0', levels[1]!, '+', '+', ...(devices ? ['+'] : [])].join('/');
  const taken = new Set<string>();
  const identifier = [unique(taken, 'edge_node'), ...(devices ? [unique(taken, 'device')] : [])];
  const fields: { name: string; type: string }[] = [{ name: identifier[0]!, type: 'string' }, ...(devices ? [{ name: identifier[1]!, type: 'string' }] : [])];
  const parts = [`${JSON.stringify(identifier[0])}: payload.edgeNodeId`, ...(devices ? [`${JSON.stringify(identifier[1])}: payload.deviceId`] : [])];
  for (const x of f.fields) {
    const field = unique(taken, snake(x.name));
    fields.push({ name: field, type: JSON_FIELD_TYPES[x.type] });
    parts.push(`${JSON.stringify(field)}: payload.values.\`${x.name.replaceAll('`', '')}\``);
  }
  const kinds = devices ? '["DBIRTH", "DDATA"]' : '["NBIRTH", "NDATA"]';
  return {
    name: snake(`${group}_${devices ? 'devices' : 'nodes'}`), identifier, fields, topic,
    decode: `payload.messageType in ${kinds} ? { ${parts.join(', ')} } : null`,
  };
}

// ----------------------------------------------------------------------------- the promoted connector

/**
 * A catalogue type as a manifest field type: what the finding's dialect means by it where the
 * SQL engine says (dialectFieldType), otherwise by the type's own name, generic over SQL catalogues.
 */
export function fieldType(sourceType: string, dialect: string | null = null): CatalogueFieldType {
  const own = dialect !== null && isDialect(dialect) ? dialectFieldType(sourceType, dialect) : undefined;
  if (own !== undefined) return own;
  const t = sourceType.toLowerCase();
  if (/^(tiny|small|medium|big)?int(eger)?\d*|^(small|big)?serial|^int\d$/.test(t)) return 'integer';
  if (/^(numeric|decimal|real|double|float|money|number)/.test(t)) return 'number';
  if (/^(bool|boolean|bit)$/.test(t)) return 'boolean';
  if (/^date$/.test(t)) return 'date';
  if (/^(timestamp|datetime|smalldatetime|datetimeoffset)/.test(t)) return 'date-time';
  if (/^jsonb?$/.test(t)) return 'json';
  return 'string';
}

/**
 * The first version of a promoted finding's private connector (SQL through the agent): an
 * object per table that has a key to identify its records, a field per column, relationships
 * from declared and inferred keys. No pushdown is declared: conformance earns it later.
 * Undefined when nothing is identifiable.
 */
export function promotedManifest(found: FoundStructure, links: readonly ProposedLink[], host: string): Record<string, unknown> | undefined {
  if (found.protocol === 'opc_ua' && found.opcua !== undefined) return promotedOpcUa(found, host);
  if (found.protocol === 'mqtt' && found.mqtt !== undefined) return promotedMqtt(found, host);
  if (found.protocol !== 'sql' || found.dialect === null) return undefined;
  const objects: Record<string, unknown>[] = [];
  const nameOf = new Map<string, string>();
  const taken = new Set<string>();
  for (const schema of found.schemas) {
    for (const table of schema.tables) {
      const key = table.primaryKey.length > 0 ? table.primaryKey : table.uniqueKeys[0] ?? [];
      if (key.length === 0 || key.length > 8 || table.columns.length === 0) continue;
      let name = snake(table.name);
      for (let n = 2; taken.has(name); n++) name = `${snake(table.name)}_${n}`;
      taken.add(name);
      nameOf.set(`${schema.name}.${table.name}`, name);
      const fieldNames = new Map<string, string>();
      const fieldTaken = new Set<string>();
      for (const column of table.columns.slice(0, 2_000)) {
        let f = snake(column.name);
        for (let n = 2; fieldTaken.has(f); n++) f = `${snake(column.name)}_${n}`;
        fieldTaken.add(f);
        fieldNames.set(column.name, f);
      }
      const keyed = (cols: readonly string[]) => cols.every((c) => fieldNames.has(c));
      objects.push({
        name, label: table.name.slice(0, 200),
        identifier: key.map((c) => fieldNames.get(c)!).filter((c) => c !== undefined),
        // The other unique constraints: match key candidates once confirmed (19.4).
        ...(() => {
          const unique = table.uniqueKeys.filter((k) => keyed(k) && k.join() !== key.join()).slice(0, 50).map((k) => k.map((c) => fieldNames.get(c)!));
          return unique.length === 0 ? {} : { uniqueKeys: unique };
        })(),
        fields: table.columns.map((c) => ({
          name: fieldNames.get(c.name)!, type: fieldType(c.type, found.dialect), nullable: c.nullable, column: c.name, provenance: 'observed',
        })),
        source: { kind: 'sql', schema: schema.name, table: table.name },
        relationships: [] as unknown[],
        _fields: fieldNames,
      });
    }
  }
  if (objects.length === 0) return undefined;
  for (const link of links) {
    if (link.fromColumns.length !== 1 || link.toColumns.length !== 1) continue;
    const from = objects.find((o) => nameOf.get(link.from) === o['name']);
    const toName = nameOf.get(link.to);
    const to = objects.find((o) => o['name'] === toName);
    if (from === undefined || to === undefined) continue;
    const field = (from['_fields'] as Map<string, string>).get(link.fromColumns[0]!);
    const targetField = (to['_fields'] as Map<string, string>).get(link.toColumns[0]!);
    if (field === undefined || targetField === undefined) continue;
    (from['relationships'] as unknown[]).push({ field, targetObject: toName, targetField, kind: link.origin === 'declared' ? 'foreign_key' : 'reference' });
  }
  for (const o of objects) delete o['_fields'];
  const product = (found.product ?? 'Database').slice(0, 100);
  return {
    schemaVersion: '1',
    identity: { name: `${product} on ${host}`.slice(0, 200), provider: product, version: '1.0.0' },
    transport: { viaAgent: true },
    protocol: { kind: 'sql', dialect: found.dialect },
    auth: {
      strategy: 'username_password',
      fields: [
        { name: 'username', kind: 'public', label: 'User', role: 'username' },
        { name: 'password', kind: 'secret', label: 'Password', role: 'password' },
      ],
    },
    objects: objects.slice(0, 500),
  };
}

/**
 * A browsed OPC UA server's private connector: an object per family with variables, its records
 * the root folder's instances (of the type, where the server has one), identified by browse name,
 * a field per variable at its browse path. Read through the agent; the login is set afterwards
 * if the server needs one, and the connection takes its industrial endpoint as any does.
 */
function promotedOpcUa(found: FoundStructure, host: string): Record<string, unknown> | undefined {
  const taken = new Set<string>();
  const objects = (found.opcua?.types ?? []).filter((t) => t.variables.length > 0).slice(0, 500).map((t) => {
    const fieldTaken = new Set<string>(['id', 'node']);
    return {
      name: unique(taken, snake(t.name)), label: t.name.slice(0, 200), identifier: ['id'],
      fields: [
        { name: 'id', type: 'string', nullable: false, path: '$browseName', provenance: 'observed' },
        { name: 'node', type: 'string', nullable: false, path: '$nodeId', provenance: 'observed' },
        ...t.variables.slice(0, 1_000).map((v) => ({ name: unique(fieldTaken, fieldNameOf(v.path)), type: opcUaFieldType(v.dataType), path: v.path, provenance: 'observed' })),
      ],
      source: { kind: 'opc_ua', root: t.root, ...(t.typeDefinition === '' ? {} : { typeDefinition: t.typeDefinition }), maxInstances: Math.min(10_000, Math.max(100, t.instances * 2)) },
    };
  });
  if (objects.length === 0) return undefined;
  const product = (found.product ?? 'OPC UA server').slice(0, 100);
  return {
    schemaVersion: '1', identity: { name: `${product} on ${host}`.slice(0, 200), provider: product, version: '1.0.0' },
    transport: { viaAgent: true }, protocol: { kind: 'opc_ua' }, auth: { strategy: 'none' }, objects,
  };
}

/** An observed broker's private connector: an object per JSON or text topic family, decoded by its JSONata. */
function promotedMqtt(found: FoundStructure, host: string): Record<string, unknown> | undefined {
  const taken = new Set<string>();
  const objects = (found.mqtt?.families ?? []).filter((f) => f.encoding !== 'binary').slice(0, 500).map((f) => {
    const plan = mqttObject(f);
    return {
      name: unique(taken, plan.name), label: f.filter.slice(0, 200), identifier: plan.identifier,
      fields: plan.fields.map((x) => ({ ...x, provenance: 'observed' })),
      source: { kind: 'mqtt', topic: plan.topic, payload: f.encoding, decode: { jsonata: plan.decode } },
    };
  });
  if (objects.length === 0) return undefined;
  const product = (found.product ?? 'MQTT broker').slice(0, 100);
  return {
    schemaVersion: '1', identity: { name: `${product} on ${host}`.slice(0, 200), provider: product, version: '1.0.0' },
    transport: { viaAgent: true }, protocol: { kind: 'mqtt' }, auth: { strategy: 'none' }, objects,
  };
}
