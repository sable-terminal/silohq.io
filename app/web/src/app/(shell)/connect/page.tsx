'use client';

// The earlier client's area address: sent on to the section that holds it now.

import { Suspense } from 'react';
import { AreaRedirect } from '../../../views/section.view.tsx';

export default function Page() {
  return <Suspense fallback={null}><AreaRedirect area="connect" tabs={{ connections: 'connections/', new: 'connections/?new=1', agents: 'agents/', webhooks: 'webhooks/' }} fallback="connections/" /></Suspense>;
}
