import YAML from 'yaml';
import { candidatesFromSchema, pagingFragment } from './paging.compile';
import { fieldsBlock, identifierOf, keyPath, looksTemporal, parameterName, singular, slug, type Compiled, type CompiledField, type FieldType } from './shared.compile';

/**
 * OpenAPI (3.0, 3.1) and Swagger 2.0, as a version 2 draft.
 *
 * ── WHAT A SPECIFICATION CAN SAY, AND WHAT IT CANNOT ──────────────────────
 *
 * It names the endpoints, the shapes, the parameters and the authentication —
 * so a list endpoint becomes an object, its item schema its fields, a query
 * parameter that names a field a filter, and a POST beside it a create. It
 * does not say which parameter pages or what a cursor means; paging is
 * PROPOSED from parameter names and recorded as a note for the probe to
 * confirm. Nothing is fetched here: the compiler reads the document it is
 * given.
 */

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => v !== null && typeof v === 'object' && !Array.isArray(v);

/** JSON or YAML, whichever the text is. */
export function parseSpecification(text: string): unknown {
  const trimmed = text.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) return JSON.parse(trimmed);
  return YAML.parse(trimmed, { maxAliasCount: 100 });
}

const RECORD_KEYS = ['data', 'items', 'results', 'records', 'values', 'value', 'entries', 'list', 'rows', 'objects', 'elements', 'content'];
const TEMPORAL_FROM = /^(.*?)(_?(after|since|from|gte|min|start|begin))$/i;
const TEMPORAL_TO = /^(.*?)(_?(before|until|to|lte|max|end))$/i;

class Spec {
  constructor(readonly root: Json) {}

  deref(node: unknown, depth = 0): Json {
    if (!isObject(node) || depth > 20) return {};
    const ref = node.$ref;
    if (typeof ref === 'string' && ref.startsWith('#/')) {
      let target: unknown = this.root;
      for (const part of ref.slice(2).split('/')) target = isObject(target) ? target[part.replace(/~1/g, '/').replace(/~0/g, '~')] : undefined;
      return this.deref(target, depth + 1);
    }
    return node;
  }

  /** A schema with `allOf` merged and the first `oneOf`/`anyOf` taken. */
  schema(node: unknown, depth = 0): Json {
    const s = this.deref(node);
    if (depth > 12) return s;
    if (Array.isArray(s.allOf)) {
      const merged: Json = { type: 'object', properties: {}, required: [] };
      for (const part of s.allOf) {
        const p = this.schema(part, depth + 1);
        Object.assign(merged.properties as Json, isObject(p.properties) ? p.properties : {});
        (merged.required as string[]).push(...(Array.isArray(p.required) ? (p.required as string[]) : []));
      }
      return { ...s, ...merged, allOf: undefined };
    }
    for (const key of ['oneOf', 'anyOf']) {
      const options = s[key];
      if (Array.isArray(options) && options.length > 0) {
        const first = options.map((o) => this.schema(o, depth + 1)).find((o) => o.type !== 'null') ?? {};
        return { ...first, ...Object.fromEntries(Object.entries(s).filter(([k]) => k !== key)) };
      }
    }
    return s;
  }

  typeOf(schema: Json): string | undefined {
    const t = schema.type;
    if (Array.isArray(t)) return (t as string[]).find((x) => x !== 'null');
    if (typeof t === 'string') return t;
    if (isObject(schema.properties)) return 'object';
    if (schema.items) return 'array';
    return undefined;
  }
}

function fieldType(spec: Spec, raw: unknown): FieldType {
  const schema = spec.schema(raw);
  const type = spec.typeOf(schema);
  const format = String(schema.format ?? '');
  if (type === 'string') return format === 'date-time' ? 'datetime' : format === 'date' ? 'date' : 'string';
  if (type === 'integer' || type === 'number') return 'number';
  if (type === 'boolean') return 'boolean';
  if (type === 'object' || type === 'array') return 'json';
  return 'unknown';
}

function fieldsOf(spec: Spec, item: Json): { fields: CompiledField[]; jsonApi: boolean } {
  const props = isObject(item.properties) ? item.properties : {};
  const attributes = isObject(props.attributes) ? spec.schema(props.attributes) : null;
  if (attributes && isObject(attributes.properties) && 'id' in props) {
    /* JSON:API: values under attributes, the id beside them. */
    const fields: CompiledField[] = [{ name: 'id', type: 'string' }];
    for (const [key, value] of Object.entries(attributes.properties)) fields.push({ name: key, type: fieldType(spec, value), expression: `{{ attributes.${keyPath(key)} }}` });
    return { fields, jsonApi: true };
  }
  return { fields: Object.entries(props).map(([key, value]) => ({ name: key, type: fieldType(spec, value) })), jsonApi: false };
}

interface ListShape {
  recordsPath: string | null;
  item: Json;
  topProperties: string[];
}

function listShape(spec: Spec, response: Json, objectHint: string): ListShape | null {
  const type = spec.typeOf(response);
  if (type === 'array') {
    const item = spec.schema(response.items);
    return spec.typeOf(item) === 'object' ? { recordsPath: null, item, topProperties: [] } : null;
  }
  if (type !== 'object' || !isObject(response.properties)) return null;
  const arrays = Object.entries(response.properties)
    .map(([key, value]) => [key, spec.schema(value)] as const)
    .filter(([, value]) => spec.typeOf(value) === 'array' && spec.typeOf(spec.schema(value.items)) === 'object');
  if (arrays.length === 0) return null;
  const preferred = [...RECORD_KEYS, objectHint, `${objectHint}s`];
  const chosen = arrays.find(([key]) => preferred.includes(key)) ?? arrays[0]!;
  return { recordsPath: chosen[0], item: spec.schema(chosen[1].items), topProperties: Object.keys(response.properties) };
}

function responseSchema(spec: Spec, operation: Json, swagger: boolean): Json | null {
  const responses = isObject(operation.responses) ? operation.responses : {};
  for (const code of ['200', '201', '2XX', '2xx', 'default']) {
    const response = spec.deref(responses[code]);
    if (!isObject(response) || Object.keys(response).length === 0) continue;
    if (swagger) return response.schema ? spec.schema(response.schema) : null;
    const content = isObject(response.content) ? response.content : {};
    const media = Object.keys(content).find((m) => /json/i.test(m)) ?? Object.keys(content)[0];
    const schema = media && isObject(content[media]) ? (content[media] as Json).schema : undefined;
    return schema ? spec.schema(schema) : null;
  }
  return null;
}

function responseHeaders(spec: Spec, operation: Json): string[] {
  const responses = isObject(operation.responses) ? operation.responses : {};
  const ok = spec.deref(responses['200']);
  return isObject(ok.headers) ? Object.keys(ok.headers).map((h) => h.toLowerCase()) : [];
}

function parametersOf(spec: Spec, pathItem: Json, operation: Json): Json[] {
  const all = [...(Array.isArray(pathItem.parameters) ? pathItem.parameters : []), ...(Array.isArray(operation.parameters) ? operation.parameters : [])];
  return all.map((p) => spec.deref(p));
}

function requestBodySchema(spec: Spec, operation: Json, params: Json[], swagger: boolean): Json | null {
  if (swagger) {
    const body = params.find((p) => p.in === 'body');
    return body ? spec.schema(body.schema) : null;
  }
  const body = spec.deref(operation.requestBody);
  const content = isObject(body.content) ? body.content : {};
  const media = Object.keys(content).find((m) => /json/i.test(m));
  const schema = media && isObject(content[media]) ? (content[media] as Json).schema : undefined;
  return schema ? spec.schema(schema) : null;
}

/* ── Where it is, and how it signs in ───────────────────────────────────── */

function baseOf(spec: Spec, swagger: boolean, options: { specUrl?: string; baseUrl?: string }, notes: string[]): { baseUrl: string; parameters: Json } {
  const parameters: Json = {};
  let url: string;
  if (swagger) {
    const root = spec.root;
    const scheme = Array.isArray(root.schemes) && root.schemes.includes('https') ? 'https' : Array.isArray(root.schemes) && root.schemes[0] ? String(root.schemes[0]) : 'https';
    url = root.host ? `${scheme}://${String(root.host)}${String(root.basePath ?? '')}` : String(root.basePath ?? '');
  } else {
    const server = Array.isArray(spec.root.servers) && isObject(spec.root.servers[0]) ? (spec.root.servers[0] as Json) : {};
    url = String(server.url ?? '');
    const variables = isObject(server.variables) ? server.variables : {};
    url = url.replace(/\{([^}]+)\}/g, (_all, name: string) => {
      const variable = isObject(variables[name]) ? (variables[name] as Json) : {};
      const param = parameterName(name);
      parameters[param] = {
        label: String(variable.description ?? name).slice(0, 80),
        ...(variable.default !== undefined ? { default: String(variable.default) } : {}),
      };
      return `{{ params.${param} }}`;
    });
  }
  if (options.baseUrl) {
    url = options.baseUrl;
  } else if (!/^https?:\/\//.test(url)) {
    if (options.specUrl) {
      url = new URL(url || '/', options.specUrl).toString().replace(/\/$/, '');
    } else {
      parameters.host = { label: 'Where your instance is', looksLike: 'api.example.com' };
      url = `https://{{ params.host }}${url.startsWith('/') ? url : `/${url}`}`;
      notes.push('The specification gives no absolute address, so the host is asked for when connecting.');
    }
  }
  return { baseUrl: url.replace(/\/+$/, ''), parameters };
}

function authOf(spec: Spec, swagger: boolean, notes: string[]): { auth: Json[]; credentials: Json } {
  const schemes: Json = swagger ? (isObject(spec.root.securityDefinitions) ? spec.root.securityDefinitions : {}) : isObject(spec.root.components) && isObject((spec.root.components as Json).securitySchemes) ? ((spec.root.components as Json).securitySchemes as Json) : {};
  const credentials: Json = {};
  const strategyOf = (name: string): Json | null => {
    const s = spec.deref(schemes[name]);
    const type = String(s.type ?? '');
    const label = String(s.description ?? '').split('\n')[0]!.slice(0, 80);
    const credentialName = parameterName(name);
    if (type === 'apiKey') {
      credentials[credentialName] = { label: label || `${String(s.name)}` };
      if (s.in === 'header') return { strategy: 'api_key_header', name: String(s.name), fields: { key: credentialName } };
      if (s.in === 'query') return { strategy: 'api_key_query', name: String(s.name), fields: { key: credentialName } };
      if (s.in === 'cookie') return { strategy: 'placed', places: { [credentialName]: `cookie:${String(s.name)}` } };
    }
    if ((type === 'http' && String(s.scheme).toLowerCase() === 'bearer') || (swagger && type === 'apiKey' && /bearer/i.test(String(s.description ?? '')))) return { strategy: 'bearer' };
    if ((type === 'http' && String(s.scheme).toLowerCase() === 'basic') || type === 'basic') return { strategy: 'basic' };
    if (type === 'mutualTLS') return { strategy: 'mtls' };
    if (type === 'oauth2') {
      const flows: Json = swagger ? { [String(s.flow)]: s } : isObject(s.flows) ? s.flows : {};
      const scopesOf = (flow: Json) => {
        const all = Object.keys(isObject(flow.scopes) ? flow.scopes : {});
        const read = all.filter((scope) => !/(write|delete|admin|manage|create|update)/i.test(scope));
        return (read.length > 0 ? read : all).slice(0, 100);
      };
      const code = (flows.authorizationCode ?? flows.accessCode) as Json | undefined;
      if (isObject(code)) return { strategy: 'oauth2_authorization_code', endpoints: { authorizationUrl: String(code.authorizationUrl), tokenUrl: String(code.tokenUrl) }, scopes: scopesOf(code) };
      const client = (flows.clientCredentials ?? flows.application) as Json | undefined;
      if (isObject(client)) return { strategy: 'oauth2_client_credentials', endpoints: { tokenUrl: String(client.tokenUrl) }, scopes: scopesOf(client) };
      const password = flows.password as Json | undefined;
      if (isObject(password)) return { strategy: 'oauth2_password', endpoints: { tokenUrl: String(password.tokenUrl) }, scopes: scopesOf(password) };
      notes.push(`${name} uses an OAuth flow Silo cannot complete for a server (implicit); it is left out.`);
      return null;
    }
    if (type === 'openIdConnect') {
      notes.push(`${name} is OpenID Connect: its endpoints are at ${String(s.openIdConnectUrl)}; fill them in as an authorization-code strategy.`);
      return null;
    }
    return null;
  };

  const requirements: Json[] = Array.isArray(spec.root.security) ? (spec.root.security as Json[]) : Object.keys(schemes).map((name) => ({ [name]: [] }));
  const auth: Json[] = [];
  const seen = new Set<string>();
  for (const requirement of requirements) {
    const names = Object.keys(requirement);
    if (names.length === 0) {
      if (!seen.has('none')) auth.push({ strategy: 'none' });
      seen.add('none');
      continue;
    }
    const parts = names.map(strategyOf).filter((p): p is Json => p !== null);
    if (parts.length !== names.length) continue;
    const key = JSON.stringify(parts);
    if (seen.has(key)) continue;
    seen.add(key);
    auth.push(parts.length === 1 ? parts[0]! : { strategy: 'all_of', parts });
  }
  if (auth.length === 0) {
    auth.push({ strategy: 'none' });
    if (Object.keys(schemes).length === 0) notes.push('The specification declares no authentication. If the system needs a key, add it under authentication.');
  }
  return { auth, credentials };
}

/* ── Objects ────────────────────────────────────────────────────────────── */

export function compileOpenApi(input: unknown, options: { name?: string; specUrl?: string; baseUrl?: string } = {}): Compiled {
  const root = typeof input === 'string' ? (parseSpecification(input) as Json) : (input as Json);
  if (!isObject(root) || (!root.openapi && !root.swagger)) throw new Error('This is not an OpenAPI or Swagger document.');
  const spec = new Spec(root);
  const swagger = String(root.swagger ?? '').startsWith('2');
  const notes: string[] = [];
  const info = isObject(root.info) ? root.info : {};
  const title = String(options.name ?? info.title ?? 'API');

  const { baseUrl, parameters } = baseOf(spec, swagger, options, notes);
  const { auth, credentials } = authOf(spec, swagger, notes);
  const paths = isObject(root.paths) ? root.paths : {};
  const objects: Json[] = [];
  const names = new Set<string>();

  for (const [path, rawItem] of Object.entries(paths)) {
    const pathItem = spec.deref(rawItem);
    const get = isObject(pathItem.get) ? pathItem.get : null;
    if (!get || get.deprecated === true) continue;
    if (/\{[^}]+\}/.test(path)) {
      if (!/\{[^}]+\}$/.test(path)) notes.push(`${path} lists records inside another record; build it as a pipeline that reads the parent first.`);
      continue;
    }
    const response = responseSchema(spec, get, swagger);
    const segments = path.split('/').filter((s) => s && !/^v\d+(\.\d+)?$/i.test(s));
    const last = segments.at(-1) ?? String(get.operationId ?? 'record');
    const hint = singular(last);
    const shape = response ? listShape(spec, response, last) : null;
    if (!shape) continue;

    let objectName = hint;
    if (names.has(objectName)) objectName = singular(segments.slice(-2).join('_'));
    if (names.has(objectName)) continue;
    names.add(objectName);

    const { fields: compiled, jsonApi } = fieldsOf(spec, shape.item);
    if (compiled.length === 0) {
      notes.push(`${path} returns records whose fields the specification does not describe.`);
      continue;
    }
    const block = fieldsBlock(compiled);
    const fieldNames = block.fields.map((f) => f.name);
    const params = parametersOf(spec, pathItem, get);
    const query = params.filter((p) => p.in === 'query');
    const queryNames = query.map((p) => String(p.name));

    const read: Json = {
      request: { path },
      records: shape.recordsPath ? `{{ response.${keyPath(shape.recordsPath)} }}` : '{{ response }}',
      ...(Object.keys(block.expressions).length > 0 ? { fields: block.expressions } : {}),
    };

    /* Paging, proposed. */
    const sizeParam = query.find((p) => ['limit', 'per_page', 'perPage', 'page_size', 'pageSize', 'maxResults', 'size', 'count'].includes(String(p.name)));
    const maxSize = sizeParam ? Number(spec.schema(sizeParam.schema ?? sizeParam).maximum ?? 100) : null;
    const candidates = candidatesFromSchema({
      queryParams: queryNames,
      responseProperties: shape.topProperties,
      recordsPath: shape.recordsPath,
      hasLinkHeader: responseHeaders(spec, get).includes('link'),
      maxSize,
    });
    const chosen = candidates[0];
    const usesSizeParam = chosen && Object.values(chosen.values).includes(String(sizeParam?.name ?? '\u0000'));
    if (chosen) {
      const fragment = pagingFragment(chosen);
      if (fragment.page) read.page = fragment.page;
      if (isObject(fragment.request)) read.request = { ...(read.request as Json), ...fragment.request, query: { ...((fragment.request as Json).query as Json) } };
      notes.push(`${objectName}: paging proposed from ${chosen.because} Confirm it with a test read.`);
    } else {
      notes.push(`${objectName}: the specification shows no paging, so one page is read. Add paging if the list is longer.`);
    }

    /* Filters, where a parameter names a field. */
    const filters: Json = {};
    const lowerFields = new Map(fieldNames.map((f) => [f.toLowerCase(), f]));
    for (const param of query) {
      const name = String(param.name);
      if (chosen && Object.values(chosen.values).includes(name)) continue;
      const direct = lowerFields.get(name.toLowerCase());
      if (direct) {
        filters[direct] = { ...(filters[direct] as Json | undefined), eq: { query: { [name]: '{{ $string(value) }}' } } };
        continue;
      }
      const from = TEMPORAL_FROM.exec(name);
      const to = TEMPORAL_TO.exec(name);
      const stem = (from ?? to)?.[1]?.replace(/_$/, '');
      if (!stem && !['since', 'until'].includes(name)) continue;
      const base = stem || 'updated';
      const target = [base, `${base}_at`, `${base}At`, `${base}_date`, `${base}Date`].map((c) => lowerFields.get(c.toLowerCase())).find((f): f is string => f !== undefined && looksTemporal(f));
      if (!target) continue;
      const op = from || name === 'since' ? 'gte' : 'lte';
      filters[target] = { ...(filters[target] as Json | undefined), [op]: { query: { [name]: '{{ $string(value) }}' } } };
    }
    const pushdown: Json = {};
    if (Object.keys(filters).length > 0) pushdown.filters = filters;
    if (sizeParam && !usesSizeParam) pushdown.limit = { query: { [String(sizeParam.name)]: `{{ $string($min([limit, ${maxSize ?? 100}])) }}` } };
    if (Object.keys(pushdown).length > 0) read.pushdown = pushdown;

    const identifier = identifierOf(fieldNames, objectName);
    const object: Json = {
      name: objectName,
      ...(get.summary || get.description ? { description: String(get.summary ?? get.description).split('\n')[0]!.slice(0, 500) } : {}),
      identifier,
      fields: block.fields,
      read,
    };

    /* Writes, where the specification shows them beside the list. */
    const operations: Json = {};
    const post = isObject(pathItem.post) ? pathItem.post : null;
    const bodyFrom = (schema: Json | null) => {
      if (!schema || spec.typeOf(schema) !== 'object' || !isObject(schema.properties)) return null;
      const body: Json = {};
      for (const [key, value] of Object.entries(schema.properties)) {
        if (spec.schema(value).readOnly === true) continue;
        body[key] = `{{ values.${keyPath(key)} }}`;
      }
      return Object.keys(body).length > 0 ? body : null;
    };
    const idField = identifier[0]!;
    if (jsonApi && (post || Object.keys(paths).some((p) => p.startsWith(`${path}/{`)))) {
      notes.push(`${objectName}: writes are JSON:API documents ({ data: { type, attributes } }); add them in the builder.`);
    } else if (post) {
      const body = bodyFrom(requestBodySchema(spec, post, parametersOf(spec, pathItem, post), swagger));
      if (body) operations.create = { request: { method: 'POST', path, body }, identifier: { [idField]: `{{ response.${keyPath(idField)} }}` } };
    }
    const itemPath = jsonApi ? undefined : Object.keys(paths).find((p) => p.startsWith(`${path}/{`) && /^\{[^}]+\}$/.test(p.slice(path.length + 1)));
    if (itemPath) {
      const item = spec.deref(paths[itemPath]);
      const concrete = `${path}/{{ identifier.${keyPath(idField)} }}`;
      const updater = isObject(item.patch) ? ['PATCH', item.patch] : isObject(item.put) ? ['PUT', item.put] : null;
      if (updater) {
        const body = bodyFrom(requestBodySchema(spec, updater[1] as Json, parametersOf(spec, item, updater[1] as Json), swagger));
        if (body) operations.update = { request: { method: updater[0], path: concrete, body } };
      }
      if (isObject(item.delete)) operations.delete = { request: { method: 'DELETE', path: concrete } };
    }
    if (Object.keys(operations).length > 0) object.write = { operations };

    objects.push(object);
  }

  if (objects.length === 0) notes.push('No list endpoints were found. Add objects by hand, or derive them from the live system.');

  return {
    document: {
      schemaVersion: 2,
      identity: { name: title.slice(0, 128), provider: slug(title), version: 1, ...(info.description ? { description: String(info.description).replace(/\s+/g, ' ').slice(0, 500) } : {}) },
      transport: { kind: 'https_rest', baseUrl },
      ...(Object.keys(parameters).length > 0 ? { parameters } : {}),
      auth,
      ...(Object.keys(credentials).length > 0 ? { credentials } : {}),
      objects,
    },
    notes,
  };
}
