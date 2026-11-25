'use client';

import type { ReactNode } from 'react';
import { SETTINGS } from '../../../navigation/settings.navigation.ts';
import { SettingsFrame } from '../../../views/settings/frame.view.tsx';

export default function Layout({ children }: { children: ReactNode }) {
  return <SettingsFrame title="Settings" groups={SETTINGS}>{children}</SettingsFrame>;
}
