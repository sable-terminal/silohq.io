import type { Metadata } from 'next';
import { ResetPassword } from '../../views/entry/resetPassword.view.tsx';

export const metadata: Metadata = { title: 'Reset your password' };

export default function Page() {
  return <ResetPassword />;
}
