import type { Metadata } from 'next';
import { SignIn } from '../../views/entry/signIn.view.tsx';

export const metadata: Metadata = { title: 'Sign in' };

export default function Page() {
  return <SignIn />;
}
