'use client';

// The organisation's logo as an address an <img> can show (a blob: URL, which the page's
// content security policy allows), read once and kept a while; undefined while it is read and
// when the organisation has none.

import { useEffect, useState } from 'react';
import { useQuery } from '../data/query.data.ts';

export function useOrganisationLogo(): { url: string | undefined; status: 'loading' | 'none' | 'ready' } {
  const logo = useQuery('readOrganisationLogo', {}, { staleMs: 10 * 60_000 });
  const [url, setUrl] = useState<string | undefined>();
  useEffect(() => {
    if (logo.data === undefined) {
      setUrl(undefined);
      return;
    }
    const bytes = Uint8Array.from(atob(logo.data.contentBase64), (c) => c.charCodeAt(0));
    const made = URL.createObjectURL(new Blob([bytes], { type: logo.data.contentType }));
    setUrl(made);
    return () => URL.revokeObjectURL(made);
  }, [logo.data]);
  return { url, status: url !== undefined ? 'ready' : logo.status === 'error' ? 'none' : 'loading' };
}
