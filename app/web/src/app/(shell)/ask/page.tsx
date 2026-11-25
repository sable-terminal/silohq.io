'use client';

// The earlier client's Ask address: sent on to the section that holds it now.

import { Suspense } from 'react';
import { AreaRedirect } from '../../../views/section.view.tsx';

export default function Page() {
  return <Suspense fallback={null}><AreaRedirect area="ask" param="mode" tabs={{ dashboard: 'dashboard/' }} fallback="threads/" /></Suspense>;
}
