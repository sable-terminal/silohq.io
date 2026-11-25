'use client';

import { useSearchParams } from 'next/navigation';
import { Suspense } from 'react';
import { AreaRedirect } from '../../../views/section.view.tsx';
import { SettingsHome } from '../../../views/settings/home.view.tsx';

/** The earlier client's settings tabs (/settings/?tab=people), sent on to their pages. */
const TABS = { people: 'people/', roles: 'roles/', scopes: 'scopes/', markings: 'markings/', sharing: 'sharing/', sso: 'sso/', billing: 'billing/' };

function Settings() {
  const tab = useSearchParams().get('tab');
  if (tab === null) return <SettingsHome />;
  if (tab === 'account') return <AreaRedirect area="account" tabs={{}} fallback="profile/" />;
  return <AreaRedirect area="settings" tabs={TABS} fallback="" />;
}

export default function Page() {
  return <Suspense fallback={null}><Settings /></Suspense>;
}
