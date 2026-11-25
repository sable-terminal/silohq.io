'use client';

import { Suspense } from 'react';
import { SupportPage } from '../../../views/support/page.view.tsx';

export default function Page() {
  return <Suspense fallback={null}><SupportPage /></Suspense>;
}
