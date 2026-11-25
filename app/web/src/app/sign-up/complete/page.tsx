import type { Metadata } from 'next';
import { CompleteSignUp } from '../../../views/entry/signUp.view.tsx';

export const metadata: Metadata = { title: 'Create your organisation' };

export default function Page() {
  return <CompleteSignUp />;
}
