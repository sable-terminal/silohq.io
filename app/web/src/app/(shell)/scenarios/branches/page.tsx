'use client';

import { Suspense } from 'react';
import { SectionPage } from '../../../../views/section.view.tsx';

export default function Page() {
  return <Suspense fallback={null}><SectionPage href="/scenarios/branches/" /></Suspense>;
}
