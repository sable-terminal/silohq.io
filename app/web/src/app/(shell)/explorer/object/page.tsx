'use client';

import { Suspense } from 'react';
import { ObjectPage } from '../../../../views/explorer/object.view.tsx';

export default function Page() {
  return <Suspense fallback={null}><ObjectPage /></Suspense>;
}
