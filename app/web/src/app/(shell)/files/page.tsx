'use client';

// The earlier client's area address: sent on to the section that holds it now.

import { Suspense } from 'react';
import { AreaRedirect } from '../../../views/section.view.tsx';

export default function Page() {
  return <Suspense fallback={null}><AreaRedirect area="files" tabs={{ media: 'media/' }} fallback="all/" byParam={{ mediaSet: 'media/' }} /></Suspense>;
}
