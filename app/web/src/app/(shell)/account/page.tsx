'use client';

import { Suspense } from 'react';
import { AreaRedirect } from '../../../views/section.view.tsx';

export default function Page() {
  return <Suspense fallback={null}><AreaRedirect area="account" tabs={{}} fallback="profile/" /></Suspense>;
}
