'use client';

// The notifications page: every notification, and the page an emailed or pushed link opens
// (?id=, with ?organisation= naming whose it is). Opened from a link, it reads the item, marks it
// read and goes on to where it is dealt with; an item of another organisation says so and offers
// to switch.

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef } from 'react';
import { Button } from '../../components/button.component.tsx';
import { Page } from '../../components/page.component.tsx';
import { EmptyState, ErrorState, Loading } from '../../components/states.component.tsx';
import { useMutation, useQuery } from '../../data/query.data.ts';
import { useParams } from '../../hooks/params.hook.ts';
import { usePageContext, useWorkspace } from '../../shell/context.shell.tsx';
import { describe, NotificationsPanel } from '../../shell/notifications.shell.tsx';

function Opening({ id }: { id: string }) {
  const router = useRouter();
  const item = useQuery('readNotification', { params: { notificationId: id } });
  const markRead = useMutation('markNotificationRead');
  const done = useRef(false);
  useEffect(() => {
    if (item.data === undefined || done.current) return;
    done.current = true;
    const n = item.data.notification;
    const go = () => router.replace(describe(n).href as never);
    if (n.readAt === null) void markRead.run({ params: { notificationId: n.id } }).finally(go);
    else go();
  }, [item.data, markRead, router]);
  if (item.status === 'error') {
    return <ErrorState error={item.error} what="This notification" onRetry={item.refetch} />;
  }
  return <Loading label="Opening the notification" />;
}

export function NotificationsPage() {
  const workspace = useWorkspace();
  const [params] = useParams();
  const id = params.get('id') ?? undefined;
  const organisation = params.get('organisation') ?? undefined;
  const here = workspace.memberships.find((m) => m.current);
  const other = organisation === undefined || organisation === here?.organisationSlug ? undefined
    : workspace.memberships.find((m) => m.organisationSlug === organisation && m.status === 'active');
  usePageContext({});

  if (id !== undefined && organisation !== undefined && organisation !== here?.organisationSlug) {
    return (
      <Page title="Notifications" width="narrow">
        <EmptyState icon="building" title={other === undefined ? 'This notification is for another organisation' : `This notification is for ${other.organisationName}`}
          action={other === undefined ? <Link href="/notifications/">Your notifications here</Link>
            : <Button variant="primary" onClick={() => void workspace.switchOrganisation(other.organisationId)}>Switch to {other.organisationName}</Button>}>
          You are signed in to {here?.organisationName ?? 'another organisation'}. {other === undefined ? 'You are not a member of the one it is for.' : 'Switch, then open the link again.'}
        </EmptyState>
      </Page>
    );
  }
  if (id !== undefined) return <Opening id={id} />;
  return (
    <Page title="Notifications" description="What Silo has told you, newest first. Opening one marks it read." width="narrow"
      actions={<Link href="/account/devices/">Where notifications go</Link>}>
      <NotificationsPanel page />
    </Page>
  );
}
