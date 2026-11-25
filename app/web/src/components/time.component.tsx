'use client';

// A moment, written relative to now ("5 minutes ago") with the exact time on hover and in the
// markup; kept current while shown. Before the page is in the browser, the exact date shows.

import { useEffect, useState } from 'react';
import { formatDateTime, formatRelative } from '../utils/format.util.ts';

let ticking: Set<() => void> | undefined;
function tick(listener: () => void): () => void {
  if (ticking === undefined) {
    ticking = new Set();
    setInterval(() => ticking?.forEach((l) => l()), 30_000);
  }
  ticking.add(listener);
  return () => ticking?.delete(listener);
}

export function Time({ value, exact = false }: { value: string | null | undefined; exact?: boolean }) {
  const [now, setNow] = useState<number | undefined>(undefined);
  useEffect(() => {
    setNow(Date.now());
    return tick(() => setNow(Date.now()));
  }, []);
  if (value === null || value === undefined) return <span>—</span>;
  const absolute = formatDateTime(value);
  return (
    <time dateTime={value} title={absolute}>
      {exact || now === undefined ? absolute : formatRelative(value, now)}
    </time>
  );
}
