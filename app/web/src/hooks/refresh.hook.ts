'use client';

// Reads something again every few seconds while work it shows is under way (a test run, a
// re-check, a scan), and stops once it settles: a page left open never polls for nothing.

import { useEffect } from 'react';

export function useRefreshWhile(working: boolean, refetch: () => void, everyMs = 4000): void {
  useEffect(() => {
    if (!working) return undefined;
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') refetch();
    }, everyMs);
    return () => clearInterval(timer);
  }, [working, refetch, everyMs]);
}
