'use client';

// Page state kept in the URL (guarantee 6): the tab, the filter, the selected item. Reading a
// parameter follows navigation; setting one replaces the URL (or pushes it, for a step the
// person will want Back to undo) without scrolling or reloading.

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useCallback } from 'react';

export type SetParams = (changes: Record<string, string | undefined | null>, options?: { push?: boolean }) => void;

export function useParams(): [URLSearchParams, SetParams] {
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const set = useCallback<SetParams>((changes, options = {}) => {
    const next = new URLSearchParams(window.location.search);
    for (const [key, value] of Object.entries(changes)) {
      if (value === undefined || value === null || value === '') next.delete(key);
      else next.set(key, value);
    }
    const query = next.toString();
    const href = `${pathname}${query === '' ? '' : `?${query}`}${window.location.hash}`;
    if (options.push) router.push(href as never, { scroll: false });
    else router.replace(href as never, { scroll: false });
  }, [router, pathname]);
  return [new URLSearchParams(params.toString()), set];
}

export function useParam(name: string): [string | undefined, (value: string | undefined | null, options?: { push?: boolean }) => void] {
  const [params, set] = useParams();
  const value = params.get(name) ?? undefined;
  const setOne = useCallback((next: string | undefined | null, options?: { push?: boolean }) => set({ [name]: next }, options), [set, name]);
  return [value, setOne];
}
