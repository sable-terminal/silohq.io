'use client';

import { Suspense } from 'react';
import { HelpCentre } from '../../../views/help/centre.view.tsx';

export default function Page() {
  return <Suspense fallback={null}><HelpCentre /></Suspense>;
}
