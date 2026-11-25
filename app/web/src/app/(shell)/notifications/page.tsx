'use client';

import { Suspense } from 'react';
import { NotificationsPage } from '../../../views/support/notifications.view.tsx';

export default function Page() {
  return <Suspense fallback={null}><NotificationsPage /></Suspense>;
}
