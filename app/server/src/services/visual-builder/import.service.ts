// Starting a visual-builder draft from a service's own description (spec 14.4's discovery
// models; 16.4): a WSDL for SOAP, an introspection result or SDL for GraphQL. Pure, and no
// model call: the description is compiled to a manifest the person then edits, tries and
// publishes like any draft. Every expression in it is written here from fixed templates, with
// names quoted as CEL literals; nothing is guessed that the description does not say, and what
// was left out is named in the notes.
//
// - WSDL 1.1, document/literal: each operation whose response holds a repeated element of a
//   complex type becomes an object. Its request element's simple children are the parameters
//   (equality filters where one is named as a record field; token or page paging where the
//   names say so); the record's simple children, and those of a child element once nested,
//   are its fields. The SOAP 1.1 port is preferred to the 1.2 one; namespaces are resolved,
//   never guessed from prefixes. A WSDL carrying a DTD is refused unread.
// - GraphQL: each Query field that lists objects (a list, a connection's edges.node, or nodes)
//   becomes an object, its arguments the variables; `first` and `after` with a pageInfo page
//   by cursor and set the limit; an argument named as a field filters it.
// Authentication is not described by either; the draft says none and the person sets it.

import { XMLParser } from 'fast-xml-parser';
import {
  buildClientSchema, buildSchema, isEnumType, isListType, isNonNullType, isObjectType, isScalarType, type GraphQLField, type GraphQLNamedType,
  type GraphQLObjectType, type GraphQLOutputType, type IntrospectionQuery,
} from 'graphql';
import type { FieldType, ManifestInput } from '../../contracts/connect/manifest.contract.ts';
import { AppError } from '../../utils/errors.util.ts';
import { CURSOR_PARAMS, CURSOR_PROPS, PAGE_PARAMS, SIZE_PARAMS } from '../connector-builder/openapi.service.ts';
import { toName } from '../schema-inference/infer.service.ts';

export interface Imported { document: ManifestInput; notes: string[] }
interface Identity { name: string; provider: string }

const VERSION = '0.1.0';
const MAX_OBJECTS = 50;
const MAX_FIELDS = 200;
const MAX_PAGES = 1_000;
const PAGE_SIZE = 100;
const literal = (value: string): string => JSON.stringify(value);
type ObjectInput = ManifestInput['objects'][number];

/** A name not yet taken, from a base. */
function unique(base: string, taken: Set<string>): string {
  let candidate = base;
  for (let n = 2; taken.has(candidate); n += 1) candidate = `${base.slice(0, 59)}_${n}`;
  taken.add(candidate);
  return candidate;
}

// ----------------------------------------------------------------------------- WSDL

const WSDL = 'http://schemas.xmlsoap.org/wsdl/';
const SOAP11 = 'http://schemas.xmlsoap.org/wsdl/soap/';
const SOAP12 = 'http://schemas.xmlsoap.org/wsdl/soap12/';
const XSD = 'http://www.w3.org/2001/XMLSchema';
const XML_NAME = /^[A-Za-z_][A-Za-z0-9_-]{0,127}$/;
const PARAMETER_NAME = /^[_A-Za-z][_0-9A-Za-z]{0,127}$/;

type Node = Record<string, unknown>;
interface El { node: Node; scope: ReadonlyMap<string, string> }

const listOf = (value: unknown): unknown[] => (value === undefined ? [] : Array.isArray(value) ? value : [value]);

function scoped(node: Node, parent: ReadonlyMap<string, string>): El {
  const scope = new Map(parent);
  for (const [key, value] of Object.entries(node)) {
    if (key === '@_xmlns') scope.set('', String(value));
    else if (key.startsWith('@_xmlns:')) scope.set(key.slice(8), String(value));
  }
  return { node, scope };
}

/**
 * Child elements in a namespace with a local name, each with its namespace scope. A child's
 * own declarations apply to its own name (<xs:schema xmlns:xs="...">), so its prefix is
 * resolved in its scope, not its parent's.
 */
function children(el: El, ns: string, local: string): El[] {
  const out: El[] = [];
  for (const [key, value] of Object.entries(el.node)) {
    if (key.startsWith('@_') || key === '#text') continue;
    const colon = key.indexOf(':');
    if ((colon < 0 ? key : key.slice(colon + 1)) !== local) continue;
    const prefix = colon < 0 ? '' : key.slice(0, colon);
    for (const v of listOf(value)) {
      const child = scoped(v !== null && typeof v === 'object' ? v as Node : {}, el.scope);
      if (child.scope.get(prefix) === ns) out.push(child);
    }
  }
  return out;
}

const attr = (el: El, name: string): string | undefined => (typeof el.node[`@_${name}`] === 'string' ? el.node[`@_${name}`] as string : undefined);

/** A QName attribute's namespace and local name, resolved in the element's scope. */
function qname(el: El, value: string): { ns: string | undefined; local: string } {
  const colon = value.indexOf(':');
  return colon < 0 ? { ns: el.scope.get(''), local: value } : { ns: el.scope.get(value.slice(0, colon)), local: value.slice(colon + 1) };
}

const XSD_TYPES: Readonly<Record<string, FieldType>> = {
  string: 'string', normalizedString: 'string', token: 'string', anyURI: 'string', ID: 'string', QName: 'string', language: 'string',
  int: 'integer', integer: 'integer', long: 'integer', short: 'integer', byte: 'integer', nonNegativeInteger: 'integer', positiveInteger: 'integer',
  negativeInteger: 'integer', nonPositiveInteger: 'integer', unsignedInt: 'integer', unsignedLong: 'integer', unsignedShort: 'integer', unsignedByte: 'integer',
  decimal: 'number', double: 'number', float: 'number', boolean: 'boolean', date: 'date', dateTime: 'date-time',
};

interface Schema { tns: string; qualified: boolean }
interface Particle { name: string; repeated: boolean; simple?: FieldType; complex?: { el: El; schema: Schema } }

class Schemas {
  readonly elements = new Map<string, { el: El; schema: Schema }>();
  readonly complexTypes = new Map<string, { el: El; schema: Schema }>();
  readonly simpleTypes = new Map<string, { el: El; schema: Schema }>();

  constructor(definitions: El) {
    for (const types of children(definitions, WSDL, 'types')) {
      for (const s of children(types, XSD, 'schema')) {
        const schema: Schema = { tns: attr(s, 'targetNamespace') ?? '', qualified: attr(s, 'elementFormDefault') === 'qualified' };
        for (const [kind, map] of [['element', this.elements], ['complexType', this.complexTypes], ['simpleType', this.simpleTypes]] as const) {
          for (const el of children(s, XSD, kind)) {
            const name = attr(el, 'name');
            if (name !== undefined) map.set(`${schema.tns}|${name}`, { el, schema });
          }
        }
      }
    }
  }

  /** A simple type's field type, through restrictions to an XSD built-in; string where unknown. */
  simple(ns: string | undefined, local: string, depth = 0): FieldType | undefined {
    if (ns === XSD) return XSD_TYPES[local] ?? 'string';
    const found = this.simpleTypes.get(`${ns}|${local}`);
    if (found === undefined || depth > 5) return undefined;
    const base = children(found.el, XSD, 'restriction')[0];
    const b = base === undefined ? undefined : attr(base, 'base');
    return b === undefined ? 'string' : this.simple(qname(base!, b).ns, qname(base!, b).local, depth + 1) ?? 'string';
  }

  /** An element declaration's type: simple, or a complex type to read particles from. */
  typeOf(el: El, schema: Schema): Pick<Particle, 'simple' | 'complex'> {
    const inlineComplex = children(el, XSD, 'complexType')[0];
    if (inlineComplex !== undefined) return { complex: { el: inlineComplex, schema } };
    if (children(el, XSD, 'simpleType')[0] !== undefined) return { simple: 'string' };
    const type = attr(el, 'type');
    if (type === undefined) return { simple: 'string' };
    const { ns, local } = qname(el, type);
    const simple = this.simple(ns, local);
    if (simple !== undefined) return { simple };
    const complex = this.complexTypes.get(`${ns}|${local}`);
    return complex === undefined ? { simple: 'string' } : { complex };
  }

  /** A complex type's child elements, in order: sequences, all and choice, nested; extensions after their base. */
  particles(complex: { el: El; schema: Schema }, depth = 0): Particle[] {
    if (depth > 8) return [];
    const out: Particle[] = [];
    const walk = (group: El) => {
      for (const kind of ['sequence', 'all', 'choice']) {
        for (const g of children(group, XSD, kind)) {
          for (const e of children(g, XSD, 'element')) out.push(this.particle(e, complex.schema));
          walk(g);
        }
      }
    };
    for (const content of children(complex.el, XSD, 'complexContent')) {
      for (const extension of children(content, XSD, 'extension')) {
        const base = attr(extension, 'base');
        const found = base === undefined ? undefined : this.complexTypes.get(`${qname(extension, base).ns}|${qname(extension, base).local}`);
        if (found !== undefined) out.push(...this.particles(found, depth + 1));
        walk(extension);
      }
    }
    walk(complex.el);
    return out;
  }

  particle(e: El, schema: Schema): Particle {
    const max = attr(e, 'maxOccurs');
    const repeated = max === 'unbounded' || (max !== undefined && Number(max) > 1);
    const ref = attr(e, 'ref');
    if (ref !== undefined) {
      const { ns, local } = qname(e, ref);
      const global = this.elements.get(`${ns}|${local}`);
      return { name: local, repeated, ...(global === undefined ? { simple: 'string' as const } : this.typeOf(global.el, global.schema)) };
    }
    return { name: attr(e, 'name') ?? '', repeated, ...this.typeOf(e, schema) };
  }
}

/** The repeated complex element under a response element, as a path of element names (to depth 4). */
function recordsUnder(schemas: Schemas, complex: { el: El; schema: Schema }, path: string[], depth = 0): { path: string[]; record: { el: El; schema: Schema } } | undefined {
  if (depth > 4) return undefined;
  const parts = schemas.particles(complex);
  const repeated = parts.find((p) => p.repeated && p.complex !== undefined && XML_NAME.test(p.name));
  if (repeated !== undefined) return { path: [...path, repeated.name], record: repeated.complex! };
  for (const p of parts) {
    if (p.complex === undefined || p.repeated || !XML_NAME.test(p.name)) continue;
    const found = recordsUnder(schemas, p.complex, [...path, p.name], depth + 1);
    if (found !== undefined) return found;
  }
  return undefined;
}

/** CEL reading a dot path of the response Body by index (element names may hold a hyphen), guarded. */
function bodyAt(path: readonly string[]): { guard: string; value: string } {
  const guards: string[] = [];
  let at = 'response.body';
  for (const segment of path) {
    guards.push(`${literal(segment)} in ${at}`);
    at = `${at}[${literal(segment)}]`;
  }
  return { guard: guards.join(' && '), value: at };
}

const objectNameOf = (operation: string): string => toName(operation.replace(/^(Get|List|Find|Search|Query|Fetch|Read)(?=[A-Z_])/, '') || operation);

export function importWsdl(text: string, identity: Identity): Imported {
  if (/<!DOCTYPE/i.test(text)) throw new AppError('validation', 'the WSDL carries a DTD, which is refused', { code: 'visual.wsdl_unreadable' });
  let root: Node;
  try {
    root = new XMLParser({
      ignoreAttributes: false, attributeNamePrefix: '@_', removeNSPrefix: false, parseTagValue: false, parseAttributeValue: false,
      processEntities: true, htmlEntities: true,
    }).parse(text) as Node;
  } catch {
    throw new AppError('validation', 'the WSDL does not parse', { code: 'visual.wsdl_unreadable' });
  }
  const definitions = children(scoped(root, new Map()), WSDL, 'definitions')[0];
  if (definitions === undefined) throw new AppError('validation', 'this is not a WSDL 1.1 document', { code: 'visual.wsdl_unreadable' });
  const notes: string[] = [];
  const schemas = new Schemas(definitions);
  const messages = new Map(children(definitions, WSDL, 'message').map((m) => [attr(m, 'name') ?? '', m]));
  const elementOf = (message: El | undefined): { name: string; el: El; schema: Schema } | undefined => {
    const part = message === undefined ? undefined : children(message, WSDL, 'part')[0];
    const element = part === undefined ? undefined : attr(part, 'element');
    if (part === undefined || element === undefined) return undefined;
    const { ns, local } = qname(part, element);
    const found = schemas.elements.get(`${ns}|${local}`);
    return found === undefined ? undefined : { name: local, ...found };
  };

  // The service's port: SOAP 1.1 preferred; its binding gives each operation's action.
  const ports = children(definitions, WSDL, 'service').flatMap((s) => children(s, WSDL, 'port')).flatMap((port) => {
    const v11 = children(port, SOAP11, 'address')[0];
    const v12 = children(port, SOAP12, 'address')[0];
    const address = v11 ?? v12;
    const location = address === undefined ? undefined : attr(address, 'location');
    const binding = attr(port, 'binding');
    return location === undefined || binding === undefined ? [] : [{ version: v11 !== undefined ? '1.1' as const : '1.2' as const, location, binding: qname(port, binding).local }];
  }).sort((a, b) => a.version.localeCompare(b.version));
  const port = ports[0];
  if (port === undefined) throw new AppError('validation', 'the WSDL names no SOAP port', { code: 'visual.wsdl_no_port' });
  const url = /^(https?:\/\/[^/?#]+)(\/[^?#]*)?$/.exec(port.location);
  if (url === null) throw new AppError('validation', 'the SOAP port\'s address is not an HTTP URL', { code: 'visual.wsdl_no_port' });
  const binding = children(definitions, WSDL, 'binding').find((b) => attr(b, 'name') === port.binding);
  const portTypeName = binding === undefined ? undefined : attr(binding, 'type');
  const portType = children(definitions, WSDL, 'portType').find((p) => portTypeName !== undefined && attr(p, 'name') === qname(binding!, portTypeName).local);
  if (binding === undefined || portType === undefined) throw new AppError('validation', 'the SOAP port\'s binding is not described', { code: 'visual.wsdl_no_port' });
  const actions = new Map(children(binding, WSDL, 'operation').map((o) => {
    const soap = children(o, port.version === '1.1' ? SOAP11 : SOAP12, 'operation')[0];
    return [attr(o, 'name') ?? '', soap === undefined ? undefined : attr(soap, 'soapAction')] as const;
  }));

  const taken = new Set<string>();
  const objects: ObjectInput[] = [];
  for (const operation of children(portType, WSDL, 'operation')) {
    const opName = attr(operation, 'name') ?? '';
    if (objects.length >= MAX_OBJECTS) { notes.push('objects_bounded'); break; }
    const input = elementOf(messages.get(qname(operation, attr(children(operation, WSDL, 'input')[0] ?? operation, 'message') ?? '').local));
    const output = elementOf(messages.get(qname(operation, attr(children(operation, WSDL, 'output')[0] ?? operation, 'message') ?? '').local));
    if (input === undefined || output === undefined || !XML_NAME.test(input.name) || !XML_NAME.test(output.name)) { notes.push(`${opName}:not_document_literal`); continue; }
    const outType = schemas.typeOf(output.el, output.schema).complex;
    const found = outType === undefined ? undefined : recordsUnder(schemas, outType, [output.name]);
    if (found === undefined) { notes.push(`${opName}:no_records`); continue; }
    const fieldNames = new Set<string>();
    const fields: ObjectInput['fields'] = [];
    for (const p of schemas.particles(found.record)) {
      if (fields.length >= MAX_FIELDS || !XML_NAME.test(p.name)) continue;
      if (p.repeated) { notes.push(`${opName}:list_field_left_out:${p.name}`); continue; }
      if (p.simple !== undefined) {
        const name = unique(toName(p.name), fieldNames);
        fields.push({ name, type: p.simple, ...(name === p.name ? {} : { path: p.name }), provenance: 'documented' });
        continue;
      }
      for (const inner of schemas.particles(p.complex!)) {
        if (inner.simple === undefined || inner.repeated || !XML_NAME.test(inner.name)) continue;
        fields.push({ name: unique(toName(`${p.name}_${inner.name}`), fieldNames), type: inner.simple, path: `${p.name}.${inner.name}`, provenance: 'documented' });
      }
    }
    const identifier = fields.find((f) => f.name === 'id') ?? fields.find((f) => /(^|_)id$/.test(f.name));
    if (fields.length === 0 || identifier === undefined) { notes.push(`${opName}:${fields.length === 0 ? 'no_fields' : 'no_identifier'}`); continue; }
    const inType = schemas.typeOf(input.el, input.schema).complex;
    const parameters = (inType === undefined ? [] : schemas.particles(inType)).filter((p) => p.simple !== undefined && PARAMETER_NAME.test(p.name)).map((p) => p.name);
    const beside = outType === undefined ? [] : schemas.particles(outType).filter((p) => p.simple !== undefined && !p.repeated).map((p) => p.name);
    const cursor = parameters.find((n) => CURSOR_PARAMS.test(n));
    const nextToken = beside.find((n) => CURSOR_PROPS.test(n));
    const pageNumber = parameters.find((n) => PAGE_PARAMS.test(n));
    const size = parameters.find((n) => SIZE_PARAMS.test(n));
    let paging: { next: { cel: string }; maxPages: number } | undefined;
    if (cursor !== undefined && nextToken !== undefined) {
      const { guard, value } = bodyAt([output.name, nextToken]);
      paging = { next: { cel: `${guard} && ${value} != null && string(${value}) != "" ? {"variables": {${literal(cursor)}: string(${value})}} : stop()` }, maxPages: MAX_PAGES };
    } else if (pageNumber !== undefined) {
      paging = { next: { cel: `page.records > 0 ? {"variables": {${literal(pageNumber)}: int(page.number) + 1}} : stop()` }, maxPages: MAX_PAGES };
    }
    const byElement = new Map(fields.map((f) => [f.path ?? f.name, f.name]));
    const filters = parameters.filter((n) => byElement.has(n)).map((n) => ({
      field: byElement.get(n)!, ops: ['eq' as const], patch: { cel: `{"variables": {${literal(n)}: value}}` },
    }));
    const action = actions.get(opName);
    objects.push({
      name: unique(objectNameOf(opName), taken), identifier: [identifier.name], fields,
      source: {
        kind: 'soap', path: url[2] ?? '/', ...(action ? { action } : {}), operation: input.name, namespace: input.schema.tns,
        qualified: input.schema.qualified, parameters: parameters.map((name) => ({ name })),
        constants: size !== undefined && paging !== undefined ? { [size]: PAGE_SIZE } : {},
        recordPath: found.path.join('.'), ...(paging === undefined ? {} : { paging }),
      },
      pushdown: { filters, sort: [] },
    });
  }
  if (objects.length === 0) throw new AppError('validation', 'the WSDL describes no operation that returns a list of records', { code: 'visual.import_no_objects' });
  return {
    document: {
      schemaVersion: '1', identity: { ...identity, version: VERSION }, transport: { viaAgent: false, baseUrl: url[1]! },
      protocol: { kind: 'soap', version: port.version }, auth: { strategy: 'none', fields: [] }, objects,
    },
    notes: ['auth_not_described', ...notes],
  };
}

// ----------------------------------------------------------------------------- GraphQL

function unwrap(type: GraphQLOutputType): { named: GraphQLNamedType; list: boolean } {
  let t: GraphQLOutputType = type;
  let list = false;
  for (;;) {
    if (isNonNullType(t)) t = t.ofType;
    else if (isListType(t)) { list = true; t = t.ofType; } else return { named: t, list };
  }
}

function scalarType(named: GraphQLNamedType): FieldType | undefined {
  if (isEnumType(named)) return 'string';
  if (!isScalarType(named)) return undefined;
  switch (named.name) {
    case 'Int': return 'integer';
    case 'Float': return 'number';
    case 'Boolean': return 'boolean';
    case 'ID':
    case 'String': return 'string';
    default:
      if (/date.?time|timestamp|instant/i.test(named.name)) return 'date-time';
      if (/^date$/i.test(named.name)) return 'date';
      if (/^json/i.test(named.name)) return 'json';
      return 'string';
  }
}

/** Where a root field's records sit, and whether it pages by cursor (a pageInfo with hasNextPage and endCursor). */
function listing(field: GraphQLField<unknown, unknown>): { node: GraphQLObjectType; recordPath?: string; pageInfo: boolean } | undefined {
  const { named, list } = unwrap(field.type);
  if (!isObjectType(named)) return undefined;
  if (list) return { node: named, pageInfo: false };
  const fields = named.getFields();
  const pageInfoType = fields['pageInfo'] === undefined ? undefined : unwrap(fields['pageInfo'].type).named;
  const pageInfo = pageInfoType !== undefined && isObjectType(pageInfoType) && pageInfoType.getFields()['hasNextPage'] !== undefined
    && pageInfoType.getFields()['endCursor'] !== undefined;
  const edges = fields['edges'] === undefined ? undefined : unwrap(fields['edges'].type);
  if (edges !== undefined && edges.list && isObjectType(edges.named) && edges.named.getFields()['node'] !== undefined) {
    const node = unwrap(edges.named.getFields()['node']!.type).named;
    if (isObjectType(node)) return { node, recordPath: 'edges.node', pageInfo };
  }
  const nodes = fields['nodes'] === undefined ? undefined : unwrap(fields['nodes'].type);
  if (nodes !== undefined && nodes.list && isObjectType(nodes.named)) return { node: nodes.named, recordPath: 'nodes', pageInfo };
  return undefined;
}

export function importGraphql(text: string, identity: Identity, baseUrl: string | undefined): Imported {
  let schema;
  try {
    const trimmed = text.trim();
    if (trimmed.startsWith('{')) {
      const parsed = JSON.parse(trimmed) as { data?: IntrospectionQuery; __schema?: unknown };
      schema = buildClientSchema((parsed.data ?? parsed) as IntrospectionQuery);
    } else {
      schema = buildSchema(trimmed);
    }
  } catch {
    throw new AppError('validation', 'the GraphQL description is neither an introspection result nor SDL', { code: 'visual.graphql_unreadable' });
  }
  const query = schema.getQueryType();
  if (query === undefined || query === null) throw new AppError('validation', 'the schema has no Query type', { code: 'visual.import_no_objects' });
  const notes: string[] = baseUrl === undefined ? ['base_url_not_described'] : [];
  const taken = new Set<string>();
  const objects: ObjectInput[] = [];
  for (const root of Object.values(query.getFields())) {
    if (root.name.startsWith('__')) continue;
    if (objects.length >= MAX_OBJECTS) { notes.push('objects_bounded'); break; }
    const found = listing(root);
    if (found === undefined) continue;
    const fieldNames = new Set<string>();
    const fields: ObjectInput['fields'] = [];
    let identifier: string | undefined;
    for (const f of Object.values(found.node.getFields())) {
      if (fields.length >= MAX_FIELDS || f.args.some((a) => isNonNullType(a.type))) continue;
      const { named, list } = unwrap(f.type);
      if (list) continue;
      const type = scalarType(named);
      if (type !== undefined) {
        const name = unique(toName(f.name), fieldNames);
        fields.push({ name, type, ...(name === f.name ? {} : { path: f.name }), provenance: 'documented' });
        if (identifier === undefined && (f.name === 'id' || (named.name === 'ID' && !fields.some((x) => x.name === 'id')))) identifier = name;
        continue;
      }
      if (!isObjectType(named)) continue;
      for (const inner of Object.values(named.getFields())) {
        const i = unwrap(inner.type);
        const innerType = i.list || inner.args.some((a) => isNonNullType(a.type)) ? undefined : scalarType(i.named);
        if (innerType !== undefined) fields.push({ name: unique(toName(`${f.name}_${inner.name}`), fieldNames), type: innerType, path: `${f.name}.${inner.name}`, provenance: 'documented' });
      }
    }
    if (fields.length === 0 || identifier === undefined) { notes.push(`${root.name}:${fields.length === 0 ? 'no_fields' : 'no_identifier'}`); continue; }
    if (root.args.some((a) => isNonNullType(a.type) && a.defaultValue === undefined)) { notes.push(`${root.name}:required_arguments`); continue; }
    const args = new Map(root.args.map((a) => [a.name, a]));
    const cursor = found.pageInfo && args.has('first') && args.has('after');
    const topLevel = new Map(fields.filter((f) => f.path === undefined || !f.path.includes('.')).map((f) => [f.path ?? f.name, f.name]));
    const filters = root.args.filter((a) => topLevel.has(a.name) && !unwrap(a.type as GraphQLOutputType).list && scalarType(unwrap(a.type as GraphQLOutputType).named) !== undefined)
      .map((a) => ({ field: topLevel.get(a.name)!, ops: ['eq' as const], patch: { cel: `{"variables": {${literal(a.name)}: value}}` } }));
    const at = `response.body.data.${root.name}`;
    objects.push({
      name: unique(toName(root.name), taken), identifier: [identifier], fields,
      source: {
        kind: 'graphql', root: root.name, variables: root.args.map((a) => ({ name: a.name, type: String(a.type) })),
        constants: args.has('first') ? { first: 50 } : {}, ...(found.recordPath === undefined ? {} : { recordPath: found.recordPath }),
        ...(cursor ? {
          select: ['pageInfo.hasNextPage', 'pageInfo.endCursor'],
          paging: { next: { cel: `${at}.pageInfo.hasNextPage ? {"variables": {"after": ${at}.pageInfo.endCursor}} : stop()` }, maxPages: MAX_PAGES },
        } : {}),
      },
      pushdown: { filters, sort: [], ...(args.has('first') ? { limit: { patch: { cel: '{"variables": {"first": limit}}' } } } : {}) },
    });
  }
  if (objects.length === 0) throw new AppError('validation', 'the schema has no Query field that lists objects', { code: 'visual.import_no_objects' });
  return {
    document: {
      schemaVersion: '1', identity: { ...identity, version: VERSION }, transport: { viaAgent: false, ...(baseUrl === undefined ? {} : { baseUrl }) },
      protocol: { kind: 'graphql' }, auth: { strategy: 'none', fields: [] }, objects,
    },
    notes: ['auth_not_described', ...notes],
  };
}
