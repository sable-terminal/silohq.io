'use client';

// The earlier client's area address: sent on to the section that holds it now.

import { Suspense } from 'react';
import { AreaRedirect } from '../../../views/section.view.tsx';

export default function Page() {
  return <Suspense fallback={null}><AreaRedirect area="scenarios" tabs={{ scenarios: 'list/', new: 'list/?new=1', graph: 'graph/' }} byParam={{ scenario: 'list/', run: 'list/' }} fallback="list/" /></Suspense>;
}
