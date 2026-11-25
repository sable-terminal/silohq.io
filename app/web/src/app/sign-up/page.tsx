import type { Metadata } from 'next';
import { SignUp } from '../../views/entry/signUp.view.tsx';

export const metadata: Metadata = { title: 'Create an organisation' };

export default function Page() {
  return <SignUp />;
}
