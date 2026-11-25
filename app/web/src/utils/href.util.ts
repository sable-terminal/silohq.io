// Where the client may send a person: only a path of this origin's own pages, so a link can never
// send someone elsewhere (an open redirect) or to the API.

export function safeNext(value: string | null | undefined): string {
  if (value === null || value === undefined || value === '') return '/';
  if (!value.startsWith('/') || value.startsWith('//') || value.startsWith('/\\') || /[\u0000-\u001f]/.test(value)) return '/';
  if (value === '/api' || value.startsWith('/api/') || value.startsWith('/sign-in') || value.startsWith('/sso/')) return '/';
  return value;
}

/** The sign-in page, returning here afterwards. */
export function signInHref(here: string, step?: 'mfa'): string {
  const params = new URLSearchParams();
  if (here !== '/') params.set('next', here);
  if (step !== undefined) params.set('step', step);
  const query = params.toString();
  return `/sign-in/${query === '' ? '' : `?${query}`}`;
}

/** The page the person is on now, path and query. */
export function here(): string {
  return `${window.location.pathname}${window.location.search}`;
}

/** A page of this client with a query: undefined values left out. */
export function hrefWith(path: string, query: Record<string, string | number | boolean | undefined | null>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) if (value !== undefined && value !== null && value !== '') params.set(key, String(value));
  const text = params.toString();
  return text === '' ? path : `${path}?${text}`;
}
