import { XMLBuilder, XMLParser } from 'fast-xml-parser';
import { checkNodes, FormatError, type FormatParser } from './contract.format';

/**
 * XML, both ways.
 *
 * ── READING ───────────────────────────────────────────────────────────────
 *
 * Attributes are `@name`, text beside attributes is `#text`, and namespace
 * prefixes are dropped unless the manifest keeps them — `soap:Body` and
 * `env:Body` are the same element. VALUES STAY STRINGS: an id of `00123` parsed
 * as a number becomes `123`, a sixteen-digit account number loses its last
 * digits, and nothing downstream could tell. An expression that wants a number
 * says `$number()`.
 *
 * ONE CHILD IS NOT AN ARRAY IN XML, which is how a single-record response loses
 * its record. `arrays` names the paths that are always arrays.
 *
 * NO DOCTYPE, SO NO DECLARED ENTITIES (MANIFEST-V2 §9.6). An internal entity
 * expanded a billion times is a few hundred bytes of input, and a DOCTYPE is the
 * only place one can be declared — so it is refused outright, because no API
 * response needs one. What IS decoded is what every document may contain: the
 * five XML entities and numeric character references, once, never inside
 * CDATA. Leaving them encoded turned `Smith & Sons` into `Smith &amp; Sons` in
 * every SOAP, S3 and SAP answer.
 *
 * ── WRITING ───────────────────────────────────────────────────────────────
 *
 * The exact inverse (§9.3): `@name` is an attribute, `#text` is text beside
 * attributes, `xmlns:*` are ordinary attributes, an array is repeated siblings,
 * and key order is preserved — which is what a strict WS-I service checks.
 */

const matches = (jpath: string, arrays: string[]) =>
  arrays.some((path) => jpath === path || jpath.endsWith(`.${path}`));

export function parseXml(text: string, options: { arrays?: string[]; removeNamespaces?: boolean } = {}): unknown {
  if (/<!DOCTYPE/i.test(text)) throw new FormatError('xml', 'The response declares a DOCTYPE, which Silo does not read.');

  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@',
    textNodeName: '#text',
    removeNSPrefix: options.removeNamespaces ?? true,
    parseTagValue: false,
    parseAttributeValue: false,
    trimValues: true,
    processEntities: true,
    /* Numeric character references — `&#169;`, `&#x2019;` — which XML defines for every document. */
    htmlEntities: true,
    isArray: (_name: string, jpath: unknown) => matches(String(jpath), options.arrays ?? []),
  });

  try {
    return parser.parse(text, true);
  } catch (error) {
    throw new FormatError('xml', `The response is not XML: ${error instanceof Error ? error.message : 'unreadable'}.`);
  }
}

/** A tree to XML text, the inverse of `parseXml`. */
export function serialiseXml(tree: unknown): string {
  const builder = new XMLBuilder({
    ignoreAttributes: false,
    attributeNamePrefix: '@',
    textNodeName: '#text',
    format: false,
    suppressEmptyNode: false,
    processEntities: true,
  });
  return builder.build(tree) as string;
}

export const xml: FormatParser = {
  name: 'xml',
  contentTypes: ['application/xml', 'text/xml', 'application/soap+xml', '+xml'],
  binary: false,
  parse({ input, options }) {
    const out = parseXml(String(input), { arrays: options.arrays, removeNamespaces: options.removeNamespaces });
    checkNodes('xml', out);
    return out;
  },
};
