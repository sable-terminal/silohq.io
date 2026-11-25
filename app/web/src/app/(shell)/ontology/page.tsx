'use client';

// The earlier client's area address: sent on to the section that holds it now.

import { Suspense } from 'react';
import { AreaRedirect } from '../../../views/section.view.tsx';

export default function Page() {
  return <Suspense fallback={null}><AreaRedirect area="ontology" tabs={{ model: 'model/', actions: 'actions/', proposals: 'proposals/', derive: 'derive/', versions: 'versions/' }} fallback="model/" /></Suspense>;
}
