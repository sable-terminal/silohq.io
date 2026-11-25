import type { Metadata } from 'next';
import { SsoReturn } from '../../../views/entry/ssoReturn.view.tsx';

export const metadata: Metadata = { title: 'Signing in' };

export default function Page() {
  return <SsoReturn protocol="oidc" />;
}
