/**
 * Four ways of paging, behind one interface.
 *
 * EVERY PROVIDER PAGES DIFFERENTLY AND THE ENGINE MUST NOT CARE. Offsets, opaque
 * cursors, page tokens, and RFC 5988 link headers. Normalised here so a connector
 * declares its style once and everything upstream asks the same question.
 *
 * IT ENDS AT THE LAST PAGE OR AT A LIMIT, NEVER "WHEN THE ROWS RUN OUT". A
 * provider returning a full page every time — because a filter is being ignored,
 * or a cursor is not advancing — is a loop that pages forever against somebody
 * else's API. The safety limit is what turns that into a bounded failure.
 */

export type PagingStyle = 'offset' | 'cursor' | 'page-token' | 'link-header';

export interface PageRequest {
  style: PagingStyle;
  pageSize: number;
  position?: string | number | null;
}

export interface PageResponse<T> {
  rows: T[];
  /** Where the next page starts. Null when there is none. */
  nextPosition: string | number | null;
  /** Set when the provider says how many there are. Most do not. */
  total?: number | null;
}

export interface PageParameters {
  query: Record<string, string>;
  /** For link-header paging, the absolute URL to fetch instead. */
  url?: string;
}

export function buildRequest(
  request: PageRequest,
  names: { limit: string; offset?: string; cursor?: string; pageToken?: string },
): PageParameters {
  const query: Record<string, string> = { [names.limit]: String(request.pageSize) };

  switch (request.style) {
    case 'offset':
      query[names.offset ?? 'offset'] = String(request.position ?? 0);
      return { query };

    case 'cursor':
      if (request.position != null) query[names.cursor ?? 'cursor'] = String(request.position);
      return { query };

    case 'page-token':
      if (request.position != null) query[names.pageToken ?? 'pageToken'] = String(request.position);
      return { query };

    case 'link-header':
      // The whole URL comes from the previous response's `next` link.
      return request.position != null ? { query: {}, url: String(request.position) } : { query };
  }
}

/**
 * Where the next page starts, read from a response.
 *
 * FOR OFFSET PAGING, A SHORT PAGE MEANS THE END. That is the only reliable
 * termination signal offset paging has, and it is why a provider that pads pages
 * breaks it — hence the safety limit in `paginate`.
 */
export function nextPosition(
  style: PagingStyle,
  input: {
    rowsReturned: number;
    pageSize: number;
    currentPosition?: string | number | null;
    cursorFromBody?: string | null;
    linkHeader?: string | null;
  },
): string | number | null {
  switch (style) {
    case 'offset': {
      if (input.rowsReturned < input.pageSize) return null;
      return Number(input.currentPosition ?? 0) + input.rowsReturned;
    }
    case 'cursor':
    case 'page-token':
      return input.cursorFromBody ?? null;
    case 'link-header':
      return parseLinkHeader(input.linkHeader)?.next ?? null;
  }
}

/** RFC 5988: `<https://…?page=2>; rel="next", <…>; rel="last"`. */
export function parseLinkHeader(header: string | null | undefined): Record<string, string> | null {
  if (!header) return null;
  const links: Record<string, string> = {};

  for (const part of header.split(',')) {
    const match = /<([^>]+)>\s*;\s*rel\s*=\s*"?([^";]+)"?/.exec(part.trim());
    if (match) links[match[2]!.trim()] = match[1]!;
  }

  return Object.keys(links).length > 0 ? links : null;
}

/**
 * Walk every page, stopping at the row budget or the safety limit.
 *
 * THE PAGE LIMIT IS NOT A TUNING PARAMETER, IT IS A CIRCUIT BREAKER. A cursor
 * that does not advance produces an infinite loop hammering a customer's system,
 * and the symptom is a job that never finishes rather than an error.
 */
export async function paginate<T>(
  style: PagingStyle,
  pageSize: number,
  maxRows: number,
  fetchPage: (position: string | number | null) => Promise<PageResponse<T>>,
  maxPages = 1000,
): Promise<{ rows: T[]; complete: boolean; pages: number }> {
  const rows: T[] = [];
  let position: string | number | null = null;
  let pages = 0;
  let seenPositions = new Set<string>();

  while (pages < maxPages && rows.length < maxRows) {
    const page = await fetchPage(position);
    pages++;
    rows.push(...page.rows);

    if (page.nextPosition == null) return { rows: rows.slice(0, maxRows), complete: true, pages };

    // A repeated position means the cursor is not advancing. Stopping here is
    // the difference between a bounded failure and an endless one.
    const key = String(page.nextPosition);
    if (seenPositions.has(key)) break;
    seenPositions.add(key);

    position = page.nextPosition;
  }

  return { rows: rows.slice(0, maxRows), complete: false, pages };
}
