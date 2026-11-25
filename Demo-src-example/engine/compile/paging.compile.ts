import { expandPreset, PAGE_PRESETS } from '../compat/presets.compat';

/**
 * How a list pages, guessed from what can be seen — and only ever PROPOSED.
 *
 * A specification's parameter names or a live response's shape suggest a
 * paging scheme; neither proves one. Derivation fetches a second page with the
 * best candidate and keeps it only if the records differ. What a compiler
 * cannot confirm, it writes as a note.
 */

export interface PagingCandidate {
  preset: string;
  values: Record<string, string>;
  /** Why this was proposed, for the builder's note. */
  because: string;
}

const CURSOR_PARAMS = ['cursor', 'page_token', 'pageToken', 'next_token', 'nextToken', 'after', 'starting_after', 'continuation', 'continuationToken', 'marker', 'start_cursor'];
const CURSOR_FIELDS = ['next_cursor', 'nextCursor', 'next_page_token', 'nextPageToken', 'cursor', 'next_token', 'nextToken', 'continuation', 'continuationToken', 'next_marker', 'marker', 'endCursor'];
const SIZE_PARAMS = ['limit', 'per_page', 'perPage', 'page_size', 'pageSize', 'size', 'count', 'maxResults', 'max_results', 'top', '$top'];

const preset = (id: string, values: Record<string, string>, because: string): PagingCandidate => ({ preset: id, values, because });

/** From a list operation's query parameters and its response's top-level property names. */
export function candidatesFromSchema(input: { queryParams: string[]; responseProperties: string[]; recordsPath: string | null; hasLinkHeader: boolean; maxSize?: number | null }): PagingCandidate[] {
  const params = new Set(input.queryParams);
  const props = new Set(input.responseProperties);
  const size = String(Math.min(input.maxSize ?? 100, 100));
  const sizeParam = SIZE_PARAMS.find((p) => params.has(p));
  const out: PagingCandidate[] = [];

  if (input.hasLinkHeader) out.push(preset('link_header', {}, 'The response declares a Link header.'));
  if (params.has('starting_after') && props.has('has_more') && input.recordsPath) {
    out.push(preset('last_record_id', { param: 'starting_after', records: input.recordsPath, id: 'id', more: 'has_more' }, 'starting_after with has_more.'));
  }
  const cursorParam = CURSOR_PARAMS.find((p) => params.has(p));
  const cursorField = CURSOR_FIELDS.find((f) => props.has(f));
  if (cursorParam && cursorField) out.push(preset('cursor_query', { param: cursorParam, path: cursorField }, `${cursorParam} in the query, ${cursorField} in the response.`));
  for (const next of ['next', 'next_url', 'nextUrl', 'next_page_url', 'nextPageUrl', '@odata.nextLink']) {
    if (props.has(next)) out.push(preset('next_url_in_body', { path: next.includes('.') || next.includes('@') ? `\`${next}\`` : next }, `The response carries ${next}.`));
  }
  if ((params.has('startAt') || params.has('start')) && props.has('total')) {
    const start = params.has('startAt') ? 'startAt' : 'start';
    out.push(preset('offset_total', { start, sizeParam: sizeParam ?? 'maxResults', size, total: 'total' }, `${start} with a total.`));
  }
  if (params.has('offset') && sizeParam) out.push(preset('offset_limit', { offset: 'offset', limit: sizeParam, size }, `offset and ${sizeParam}.`));
  if ((params.has('page') || params.has('page_number') || params.has('pageNumber')) && sizeParam) {
    const page = params.has('page') ? 'page' : params.has('page_number') ? 'page_number' : 'pageNumber';
    out.push(preset('page_number', { page, sizeParam, size, first: '1' }, `${page} and ${sizeParam}.`));
  }
  return out;
}

/** From a live response: the same signals, read off the values rather than a schema. */
export function candidatesFromResponse(input: { body: unknown; headers: Record<string, string | string[]>; recordsPath: string | null; queryParams: string[] }): PagingCandidate[] {
  const top = input.body && typeof input.body === 'object' && !Array.isArray(input.body) ? Object.keys(input.body as Record<string, unknown>) : [];
  const link = input.headers.link;
  const hasNext = (Array.isArray(link) ? link.join(',') : link ?? '').includes('rel="next"');
  const found = candidatesFromSchema({ queryParams: input.queryParams, responseProperties: top, recordsPath: input.recordsPath, hasLinkHeader: hasNext });
  /* A live response with a cursor field needs no declared parameter to try one. */
  const cursorField = CURSOR_FIELDS.find((f) => top.includes(f));
  if (cursorField && !found.some((c) => c.preset === 'cursor_query')) {
    for (const param of ['cursor', 'page_token', 'after']) found.push(preset('cursor_query', { param, path: cursorField }, `${cursorField} in the response; trying ${param}.`));
  }
  if (found.length === 0) {
    found.push(preset('page_number', { page: 'page', sizeParam: 'per_page', size: '100', first: '1' }, 'Nothing announced a scheme; trying page numbers.'));
    found.push(preset('offset_limit', { offset: 'offset', limit: 'limit', size: '100' }, 'Nothing announced a scheme; trying an offset.'));
  }
  return found;
}

/** A candidate as the read fragment it writes. */
export function pagingFragment(candidate: PagingCandidate): Record<string, unknown> {
  const found = PAGE_PRESETS.find((p) => p.id === candidate.preset);
  return found ? expandPreset(found, candidate.values) : {};
}
