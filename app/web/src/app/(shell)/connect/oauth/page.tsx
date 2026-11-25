'use client';

import { Suspense } from 'react';
import { OAuthReturn } from '../../../../views/connect/oauthReturn.view.tsx';

export default function Page() {
  return <Suspense fallback={null}><OAuthReturn /></Suspense>;
}
