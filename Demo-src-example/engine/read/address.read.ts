import { refusal } from '../../utils/error.util';

/**
 * The base address and a path, joined — and the only way a path reaches a URL.
 *
 * REFUSES AN ABSOLUTE OR PROTOCOL-RELATIVE PATH, a `.` or `..` segment, and
 * anything that ends up outside the base address's own path (MANIFEST-V2 §9.2).
 * A path is built from values a question and a response supplied; it must never
 * be able to choose which endpoint receives a credentialed request.
 */
export function joinPath(base: URL, path: string | null): URL {
  const raw = path ?? '';
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.startsWith('//')) {
    throw refusal({ message: 'A request path may not name another address.', code: 'refusal.request_unbuildable' });
  }
  const [pathPart, queryPart] = splitOnce(raw, '?');
  const basePath = base.pathname.replace(/\/+$/, '');
  const joined = pathPart === '' ? base.pathname : `${basePath}/${pathPart.replace(/^\/+/, '')}`;
  const segments = joined.split('/');
  if (segments.some((segment) => segment === '.' || segment === '..' || /^%2e(%2e)?$/i.test(segment) || /^\.%2e$|^%2e\.$/i.test(segment))) {
    throw refusal({ message: 'A request path may not step outside the connection’s address.', code: 'refusal.request_unbuildable' });
  }
  if (!joined.startsWith(basePath)) {
    throw refusal({ message: 'A request path may not step outside the connection’s address.', code: 'refusal.request_unbuildable' });
  }
  const url = new URL(base.origin);
  url.pathname = joined;
  url.search = [base.search.replace(/^\?/, ''), queryPart ?? ''].filter(Boolean).join('&');
  return url;
}

const splitOnce = (text: string, on: string): [string, string | undefined] => {
  const at = text.indexOf(on);
  return at === -1 ? [text, undefined] : [text.slice(0, at), text.slice(at + 1)];
};
