'use client';

// The theme a person chose on this device (light, dark, or the device's own), kept in the
// browser only: a convenience, not a record.

import { useEffect, useState } from 'react';
import { readStored, writeStored } from './storage.hook.ts';

export type Theme = 'system' | 'light' | 'dark';
const KEY = 'silo.theme';

export function readTheme(): Theme {
  const value = readStored<string>(KEY, 'system');
  return value === 'light' || value === 'dark' ? value : 'system';
}

export function applyTheme(theme: Theme): void {
  if (theme === 'system') delete document.documentElement.dataset['theme'];
  else document.documentElement.dataset['theme'] = theme;
}

export function useTheme(): [Theme, (theme: Theme) => void] {
  const [theme, setTheme] = useState<Theme>('system');
  useEffect(() => {
    const chosen = readTheme();
    setTheme(chosen);
    applyTheme(chosen);
  }, []);
  return [theme, (next: Theme) => {
    setTheme(next);
    applyTheme(next);
    writeStored(KEY, next === 'system' ? undefined : next);
  }];
}

/** Applies the chosen theme on every page, the sign-in page included. */
export function ThemeSync(): null {
  useEffect(() => applyTheme(readTheme()), []);
  return null;
}
