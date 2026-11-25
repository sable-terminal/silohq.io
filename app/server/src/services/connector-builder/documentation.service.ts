// The AI builder's inputs that are addresses, not documents (spec 16.3): a specification or
// documentation URL, read and recognised as what it is; or a system's base URL alone, whose
// well-known description addresses are tried in turn. What is found is drafted as the builder
// drafts any document: a specification without a model, documentation written for people
// through the model (it never sees a record value).

import type { Documentation } from '../../contracts/connector-builder/build.contract.ts';

/** Well-known addresses of a service's own description, on its base URL, in the order tried. */
export const WELL_KNOWN = ['/openapi.json', '/openapi.yaml', '/swagger.json', '/v3/api-docs', '/api-docs', '/swagger/v1/swagger.json',
  '/.well-known/openapi.json', '/$metadata', '?wsdl'] as const;

const MAX_TEXT = 20_000;

/** A fetched document as the builder's documentation: a description it compiles, or text for the model. */
export function recognise(text: string, contentType: string, url: string): { documentation: Exclude<Documentation, { kind: 'email' | 'url' | 'base_url' }>; truncated: boolean } {
  const trimmed = text.trimStart();
  if (trimmed.startsWith('{')) {
    try {
      const doc = JSON.parse(trimmed) as Record<string, unknown>;
      if (typeof doc['openapi'] === 'string' || typeof doc['swagger'] === 'string') return { documentation: { kind: 'openapi', text }, truncated: false };
      if (doc['__schema'] !== undefined || (doc['data'] as Record<string, unknown> | undefined)?.['__schema'] !== undefined) {
        return { documentation: { kind: 'graphql', text }, truncated: false };
      }
    } catch {
      // Not JSON after all: read on.
    }
  }
  if (/^(openapi|swagger)\s*:/m.test(trimmed.slice(0, 4_000))) return { documentation: { kind: 'openapi', text }, truncated: false };
  if (/<(\w+:)?Edmx[\s>]/.test(trimmed.slice(0, 4_000))) return { documentation: { kind: 'odata', text }, truncated: false };
  if (/<(\w+:)?definitions[\s>]/.test(trimmed.slice(0, 4_000)) && /wsdl/i.test(trimmed.slice(0, 4_000))) return { documentation: { kind: 'wsdl', text }, truncated: false };
  if (!/<html/i.test(trimmed.slice(0, 2_000)) && /(^|\n)\s*(type\s+Query\b|schema\s*\{)/.test(trimmed)) return { documentation: { kind: 'graphql', text }, truncated: false };
  // Documentation for people: an HTML page's text, its title the page's own; plain text as it is.
  const html = contentType.includes('html') || /<html/i.test(trimmed.slice(0, 2_000));
  const title = (html ? /<title[^>]*>([^<]{1,200})<\/title>/i.exec(trimmed)?.[1]?.trim() : undefined) || new URL(url).host;
  const words = html
    ? trimmed.replace(/<(script|style|nav|footer)[\s\S]*?<\/\1>/gi, ' ').replace(/<br\s*\/?>|<\/(p|div|li|h[1-6]|tr|pre)>/gi, '\n').replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
    : trimmed;
  const clean = words.replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n\n').trim();
  return { documentation: { kind: 'text', title: title.slice(0, 200), text: clean.slice(0, MAX_TEXT) || title }, truncated: clean.length > MAX_TEXT };
}

/** Whether a recognised document is a service's own description (what the base URL alone is looked for as). */
export const isDescription = (d: { kind: string }): boolean => d.kind === 'openapi' || d.kind === 'wsdl' || d.kind === 'odata' || d.kind === 'graphql';
