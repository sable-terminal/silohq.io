import type { Metadata } from 'next';
import { AcceptInvitation } from '../../views/entry/acceptInvitation.view.tsx';

export const metadata: Metadata = { title: 'Join your organisation' };

export default function Page() {
  return <AcceptInvitation />;
}
