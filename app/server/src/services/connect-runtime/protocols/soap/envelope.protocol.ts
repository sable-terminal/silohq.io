// SOAP envelopes (spec 14.4): built from a manifest's operation and the values of its
// declared parameters, and read back into plain values. Pure.
//
// - Built: the envelope of the protocol's version, the operation's request element in its
//   namespace, and one child element per parameter with a value, in the order declared. Names
//   come from the manifest (checked as XML names at save); values only ever become element
//   text, escaped. A value XML cannot carry is refused, never dropped.
// - Read: a SOAP message carries no DTD (SOAP 1.1 and 1.2 forbid one), so a response with a
//   DOCTYPE is refused before it is parsed: no entity of the source's is ever expanded.
//   Namespace prefixes are removed, entities decoded once, CDATA kept as written; an element
//   with xsi:nil is null, attributes are dropped, and an element's text is its value.
// - A Fault is classified by its code: the request's fault (1.1 Client, 1.2 Sender, and a
//   version or header the source does not accept) is not retried; the source's (Server,
//   Receiver) is.

import { XMLParser } from 'fast-xml-parser';
import type { ErrorMeaning, SoapSource } from '../../../../contracts/connect/manifest.contract.ts';
import { AppError } from '../../../../utils/errors.util.ts';
import { SourceError } from '../../engine.service.ts';

export type SoapVersion = '1.1' | '1.2';

const ENVELOPE_NAMESPACE: Readonly<Record<SoapVersion, string>> = {
  '1.1': 'http://schemas.xmlsoap.org/soap/envelope/',
  '1.2': 'http://www.w3.org/2003/05/soap-envelope',
};

/** Characters XML 1.0 cannot carry, even escaped: controls other than tab and line breaks, U+FFFE, U+FFFF, and lone surrogates. */
const NOT_XML = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/;
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

export function escapeText(text: string): string {
  if (NOT_XML.test(text) || LONE_SURROGATE.test(text)) {
    throw new AppError('validation', 'a value holds a character XML cannot carry', { code: 'soap.value_invalid_character' });
  }
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

/** A parameter's value as element texts: a scalar once, a list once per item, null or absent not at all. */
function texts(value: unknown): string[] {
  if (value === null || value === undefined) return [];
  if (Array.isArray(value)) return value.flatMap(texts);
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return [String(value)];
  throw new AppError('integrity', 'a SOAP parameter takes a value or a list of values', { code: 'soap.value_not_scalar' });
}

/** The request envelope: the operation's element with its parameters, in the order the manifest declares them. */
export function buildEnvelope(version: SoapVersion, source: Pick<SoapSource, 'operation' | 'namespace' | 'qualified' | 'parameters'>,
  values: Readonly<Record<string, unknown>>): string {
  const element = (name: string) => (source.qualified ? `m:${name}` : name);
  const children = source.parameters.flatMap((p) => texts(values[p.name]).map((t) => `<${element(p.name)}>${escapeText(t)}</${element(p.name)}>`));
  return '<?xml version="1.0" encoding="utf-8"?>'
    + `<soap:Envelope xmlns:soap="${ENVELOPE_NAMESPACE[version]}"><soap:Body>`
    + `<m:${source.operation} xmlns:m="${escapeText(source.namespace).replaceAll('"', '&quot;')}">${children.join('')}</m:${source.operation}>`
    + '</soap:Body></soap:Envelope>';
}

/** The content type and headers the version sends its action in. */
export function framing(version: SoapVersion, action: string | undefined): { contentType: string; headers: Record<string, string> } {
  if (version === '1.1') return { contentType: 'text/xml; charset=utf-8', headers: { SOAPAction: `"${action ?? ''}"` } };
  return { contentType: `application/soap+xml; charset=utf-8${action === undefined ? '' : `; action="${action}"`}`, headers: {} };
}

const parser = new XMLParser({
  ignoreAttributes: false, attributeNamePrefix: '@_', removeNSPrefix: true, parseTagValue: false, parseAttributeValue: false, trimValues: true,
  processEntities: true, htmlEntities: true,
});

/** Plain values: nil is null, attributes go, an element holding only text is its text. */
function plain(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(plain);
  if (node === null || typeof node !== 'object') return node;
  const record = node as Record<string, unknown>;
  if (record['@_nil'] === 'true' || record['@_nil'] === '1') return null;
  const keys = Object.keys(record).filter((k) => !k.startsWith('@_'));
  if (keys.length === 0) return '';
  if (keys.length === 1 && keys[0] === '#text') return record['#text'];
  return Object.fromEntries(keys.map((k) => [k, plain(record[k])]));
}

/** The response's Body, as plain values. */
export function readEnvelope(text: string): Record<string, unknown> {
  if (/<!DOCTYPE/i.test(text)) throw new SourceError('upstream', { reason: 'response_dtd' });
  let parsed: Record<string, unknown>;
  try {
    parsed = parser.parse(text) as Record<string, unknown>;
  } catch {
    throw new SourceError('upstream', { reason: 'response_not_xml' });
  }
  const envelope = parsed['Envelope'];
  if (envelope === null || typeof envelope !== 'object' || Array.isArray(envelope)) throw new SourceError('upstream', { reason: 'response_not_soap' });
  const body = plain((envelope as Record<string, unknown>)['Body']);
  return body !== null && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : {};
}

const localName = (code: unknown): string | undefined => (typeof code === 'string' ? code.slice(code.lastIndexOf(':') + 1) : undefined);

/** A Fault's meaning by its code (1.1 faultcode, 1.2 Code/Value), or undefined where the Body holds none. */
export function faultOf(body: unknown): ErrorMeaning | undefined {
  const fault = body !== null && typeof body === 'object' ? (body as Record<string, unknown>)['Fault'] : undefined;
  if (fault === undefined || fault === null || typeof fault !== 'object') return undefined;
  const f = fault as Record<string, unknown>;
  const code = localName(f['faultcode']) ?? localName((f['Code'] as Record<string, unknown> | undefined)?.['Value']);
  switch (code) {
    case 'Client':
    case 'Sender':
    case 'VersionMismatch':
    case 'MustUnderstand':
    case 'DataEncodingUnknown':
      return 'validation';
    default:
      return 'upstream';
  }
}
