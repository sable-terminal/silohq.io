'use client';

import type { ReactNode } from 'react';
import { ACCOUNT } from '../../../navigation/account.navigation.ts';
import { SettingsFrame } from '../../../views/settings/frame.view.tsx';

export default function Layout({ children }: { children: ReactNode }) {
  return <SettingsFrame title="Account" groups={[{ label: 'Account', items: ACCOUNT }]}>{children}</SettingsFrame>;
}
