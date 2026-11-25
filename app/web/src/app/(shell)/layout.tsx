'use client';

import type { ReactNode } from 'react';
import { Workspace } from '../../shell/workspace.shell.tsx';

export default function ShellLayout({ children }: { children: ReactNode }) {
  return <Workspace>{children}</Workspace>;
}
