import { XMLParser } from 'fast-xml-parser';
import { fieldsBlock, identifierOf, singular, slug, type Compiled, type CompiledField, type FieldType } from './shared.compile';

/**
 * A WSDL 1.1 service, document/literal, as a version 2 draft.
 *
 * Each operation whose name says it reads — Get, List, Find, Search, Query,
 * Read, Fetch, Retrieve — becomes an object. Its request is the input element,
 * written with the target namespace; its records are found by walking the
 * output element down to the element that repeats; its fields are that
 * element's children, typed from the schema. RPC-style operations and schemas
 * imported from elsewhere are named in the notes rather than guessed at.
 */

type Node = Record<string, unknown>;
const list = <T>(v: T | T[] | undefined | null): T[] => (v === undefined || v === null ? [] : Array.isArray(v) ? v : [v]);
const local = (qname: unknown): string => String(qname ?? '').replace(/^.*:/, '');

const XSD_TYPES: Record<string, FieldType> = {
  string: 'string', normalizedString: 'string', token: 'string', anyURI: 'string', ID: 'string', guid: 'string',
  int: 'number', integer: 'number', long: 'number', short: 'number', byte: 'number', decimal: 'number', double: 'number', float: 'number',
  unsignedInt: 'number', unsignedLong: 'number', unsignedShort: 'number', nonNegativeInteger: 'number', positiveInteger: 'number',
  boolean: 'boolean', dateTime: 'datetime', date: 'date', time: 'string',
};

const READS = /^(get|list|find|search|query|read|fetch|retrieve|select|lookup)/i;
const PAGE_SIZE = /^(page_?size|max_?results|count|limit|top|batch_?size)$/i;
const PAGE_NUMBER = /^(page|page_?number|page_?index)$/i;

class Schema {
  readonly elements = new Map<string, Node>();
  readonly types = new Map<string, Node>();

  add(schema: Node): void {
    for (const e of list(schema.element as Node[])) this.elements.set(String(e['@name']), e);
    for (const t of list(schema.complexType as Node[])) this.types.set(String(t['@name']), t);
    for (const t of list(schema.simpleType as Node[])) this.types.set(String(t['@name']), { simple: t });
  }

  /** The child elements of an element's (or a type's) sequence, all or choice. */
  children(owner: Node, depth = 0): Node[] {
    if (depth > 8) return [];
    let complex = list(owner.complexType as Node | Node[] | undefined)[0];
    if (!complex && owner['@type']) complex = this.types.get(local(owner['@type']));
    if (!complex && owner['@name'] && (owner.sequence || owner.all || owner.choice || owner.complexContent)) complex = owner;
    if (!complex) return [];
    const extension = (complex.complexContent as Node | undefined)?.extension as Node | undefined;
    const base = extension?.['@base'] ? this.children({ '@type': extension['@base'] }, depth + 1) : [];
    const body = (extension ?? complex) as Node;
    const group = (body.sequence ?? body.all ?? body.choice) as Node | undefined;
    const own = list(group?.element as Node[]).map((e) => (e['@ref'] ? (this.elements.get(local(e['@ref'])) ?? e) : e));
    return [...base, ...own];
  }

  typeOf(element: Node): FieldType {
    const named = local(element['@type']);
    if (XSD_TYPES[named]) return XSD_TYPES[named]!;
    const found = this.types.get(named);
    if (found?.simple) {
      const restriction = (found.simple as Node).restriction as Node | undefined;
      return XSD_TYPES[local(restriction?.['@base'])] ?? 'string';
    }
    if (found || list(element.complexType as Node[]).length > 0) return 'json';
    return 'string';
  }

  repeats(element: Node): boolean {
    const max = String(element['@maxOccurs'] ?? '1');
    return max === 'unbounded' || Number(max) > 1;
  }

  /** From an element down to the one that repeats: the path, and the repeating element. */
  records(element: Node, path: string[] = [], depth = 0): { path: string[]; item: Node } | null {
    if (depth > 5) return null;
    for (const child of this.children(element)) {
      const name = String(child['@name'] ?? local(child['@ref']));
      if (this.repeats(child) && this.children(child).length > 0) return { path: [...path, name], item: child };
    }
    for (const child of this.children(element)) {
      const name = String(child['@name'] ?? local(child['@ref']));
      const deeper = this.records(child, [...path, name], depth + 1);
      if (deeper) return deeper;
    }
    return null;
  }
}

export function compileWsdl(text: string, options: { name?: string; wsdlUrl?: string; endpoint?: string } = {}): Compiled {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@',
    removeNSPrefix: true,
    isArray: (name) => ['element', 'complexType', 'simpleType', 'message', 'part', 'operation', 'port', 'schema', 'binding', 'portType', 'service', 'import', 'Policy'].includes(name),
  });
  const parsed = parser.parse(text) as Node;
  const definitions = parsed.definitions as Node | undefined;
  if (!definitions) throw new Error('This is not a WSDL document.');
  const notes: string[] = [];
  const targetNamespace = String(definitions['@targetNamespace'] ?? '');

  const schema = new Schema();
  for (const types of list(definitions.types as Node)) {
    for (const s of list((types as Node).schema as Node[])) {
      schema.add(s);
      if (list(s.import as Node[]).some((i) => i['@schemaLocation'])) notes.push('The WSDL imports schemas from other files; types defined there are not known here.');
    }
  }
  const schemaNamespace = (() => {
    for (const types of list(definitions.types as Node)) for (const s of list((types as Node).schema as Node[])) if (s['@targetNamespace']) return String(s['@targetNamespace']);
    return targetNamespace;
  })();

  const messages = new Map(list(definitions.message as Node[]).map((m) => [String(m['@name']), m]));
  const elementOf = (messageName: unknown): Node | null => {
    const message = messages.get(local(messageName));
    const part = list(message?.part as Node[])[0];
    if (!part) return null;
    if (part['@element']) return schema.elements.get(local(part['@element'])) ?? null;
    return null;
  };

  const bindings = list(definitions.binding as Node[]);
  const soap12 = bindings.some((b) => Object.keys(b).some((k) => k === 'binding') && JSON.stringify(b).includes('soap12'));
  const actions = new Map<string, string>();
  for (const binding of bindings) {
    for (const op of list(binding.operation as Node[])) {
      const soapOp = op.operation as Node | Node[] | undefined;
      const action = list(soapOp as Node[]).map((o) => o['@soapAction']).find(Boolean);
      if (action !== undefined) actions.set(String(op['@name']), String(action));
      if (JSON.stringify(binding).includes('"@style":"rpc"')) notes.push(`${String(binding['@name'])} is RPC style; only document/literal operations are drafted.`);
    }
  }
  const address = (() => {
    for (const service of list(definitions.service as Node[])) for (const port of list(service.port as Node[])) {
      const a = port.address as Node | undefined;
      if (a?.['@location']) return String(a['@location']);
    }
    return null;
  })();
  const endpoint = options.endpoint ?? address;
  if (!endpoint) throw new Error('The WSDL names no service address; give the endpoint.');

  const objects: Array<Record<string, unknown>> = [];
  const names = new Set<string>();
  for (const portType of list(definitions.portType as Node[])) {
    for (const op of list(portType.operation as Node[])) {
      const opName = String(op['@name']);
      if (!READS.test(opName)) continue;
      const input = elementOf((op.input as Node | undefined)?.['@message']);
      const output = elementOf((op.output as Node | undefined)?.['@message']);
      if (!input || !output) {
        notes.push(`${opName}: its messages are not document/literal elements, so it is not drafted.`);
        continue;
      }
      const found = schema.records(output);
      if (!found) {
        notes.push(`${opName}: nothing in its response repeats, so it reads one record at most; not drafted.`);
        continue;
      }
      const fields: CompiledField[] = schema
        .children(found.item)
        .filter((c) => c['@name'])
        .map((c) => ({ name: String(c['@name']), type: schema.typeOf(c) }));
      if (fields.length === 0) continue;

      /* The request: the input element with what it requires, page sizes filled in. */
      const inputName = String(input['@name']);
      const body: Record<string, unknown> = { '@xmlns:tns': schemaNamespace };
      const blanks: string[] = [];
      for (const child of schema.children(input)) {
        const name = String(child['@name'] ?? '');
        if (!name) continue;
        const required = String(child['@minOccurs'] ?? '1') !== '0';
        if (PAGE_SIZE.test(name)) body[`tns:${name}`] = '100';
        else if (PAGE_NUMBER.test(name)) body[`tns:${name}`] = '1';
        else if (required) {
          body[`tns:${name}`] = '';
          blanks.push(name);
        }
      }
      if (blanks.length > 0) notes.push(`${opName} requires ${blanks.join(', ')}; fill them in before a read.`);

      const outputName = String(output['@name']);
      const path = ['Envelope', 'Body', outputName, ...found.path].join('.');
      let objectName = singular(found.path.at(-1) ?? opName.replace(READS, ''));
      if (names.has(objectName)) objectName = singular(opName.replace(READS, '')) || opName;
      if (names.has(objectName)) continue;
      names.add(objectName);
      const block = fieldsBlock(fields);
      objects.push({
        name: objectName,
        identifier: identifierOf(block.fields.map((f) => f.name), objectName),
        fields: block.fields,
        read: {
          request: { ...(actions.has(opName) ? { action: actions.get(opName) } : {}), body: { [`tns:${inputName}`]: body } },
          format: 'xml',
          formatOptions: { arrays: [path] },
          records: `{{ response.${path} }}`,
        },
      });
      if (Object.keys(body).some((k) => /page/i.test(k))) notes.push(`${objectName}: reads the first page; add paging on the page number if lists are long.`);
    }
  }

  const usernameToken = JSON.stringify(definitions).includes('UsernameToken');
  if (!usernameToken) notes.push('The WSDL does not say how it authenticates; WS-Security and basic are both offered.');
  const title = options.name ?? String(definitions['@name'] ?? list(definitions.service as Node[])[0]?.['@name'] ?? new URL(endpoint).hostname);
  return {
    document: {
      schemaVersion: 2,
      identity: { name: title.slice(0, 128), provider: slug(title), version: 1 },
      transport: { kind: 'soap', endpoint, soapVersion: soap12 ? '1.2' : '1.1', ...(options.wsdlUrl ? { wsdlUrl: options.wsdlUrl } : {}) },
      auth: usernameToken ? [{ strategy: 'ws_security' }] : [{ strategy: 'ws_security' }, { strategy: 'basic' }],
      objects,
    },
    notes,
  };
}
