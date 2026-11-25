'use client';

// A per-viewer convenience kept in this browser (a remembered panel, the sidebar's open areas):
// never a record. Storage can be unavailable (a private window, blocked site data); the value
// then lives for this page only.

import { useCallback, useEffect, useState } from 'react';

export function readStored<T>(key: string, fallback: T): T {
  try {
    const raw = window.localStorage.getItem(key);
    return raw === null ? fallback : JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function writeStored(key: string, value: unknown): void {
  try {
    if (value === undefined) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Kept for this page only.
  }
}

export function useStored<T>(key: string, fallback: T): [T, (value: T) => void] {
  const [value, setValue] = useState<T>(fallback);
  useEffect(() => setValue(readStored(key, fallback)), [key]);
  const set = useCallback((next: T) => {
    setValue(next);
    writeStored(key, next);
  }, [key]);
  return [value, set];
}
