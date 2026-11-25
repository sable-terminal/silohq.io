'use client';

// The notifications panel (spec 33.2): newest first, unread marked in words as well as weight,
// each saying what happened and linking to where it is dealt with. Opening one marks it read;
// an escalation that asks for acknowledgement is acknowledged here. A notification carries
// references only, never values: its text is the client's, from its kind.

import Link from 'next/link';
import type { Output } from '../api/client.api.ts';
import { Button } from '../components/button.component.tsx';
import { Icon, type IconName } from '../components/icon.component.tsx';
import { PagesView } from '../components/query.component.tsx';
import { EmptyState, ErrorMessage } from '../components/states.component.tsx';
import { TabPanel, Tabs, type TabDef } from '../components/tabs.component.tsx';
import { Time } from '../components/time.component.tsx';
import { useData, useMutation, usePages } from '../data/query.data.ts';
import { hrefWith } from '../utils/href.util.ts';
import { useStored } from '../hooks/storage.hook.ts';
import { useWorkspace } from './context.shell.tsx';
import styles from './notifications.shell.module.css';

type Notification = Output<'listNotifications'>['notifications'][number];

/** What a notification says, where it is dealt with, and its icon. */
export function describe(n: Notification): { text: string; href: string; icon: IconName } {
  switch (n.kind) {
    case 'cron_notify': return { text: 'A Cron you own sent you its result', href: hrefWith('/governance/crons/', { runAction: n.automationRunActionId }), icon: 'cron' };
    case 'cron_escalate': return { text: 'A Cron escalated to you and asks for acknowledgement', href: hrefWith('/governance/crons/', { runAction: n.automationRunActionId }), icon: 'warning' };
    case 'approval_waiting': return { text: 'An approval is waiting for you', href: hrefWith('/governance/approvals/', { chain: n.approvalChainId }), icon: 'check' };
    case 'finding_new': return { text: 'A new finding on objects you follow', href: hrefWith('/explorer/findings/', { finding: n.findingId }), icon: 'sparkle' };
    case 'scenario_run_complete': return { text: 'A scenario run finished', href: hrefWith('/scenarios/list/', { run: n.simulationRunId }), icon: 'scenarios' };
    case 'operator_access_waiting': return { text: 'Silo staff ask to access your organisation', href: hrefWith('/governance/staff/', { session: n.operatorAccessSessionId }), icon: 'lock' };
    case 'operator_access_emergency': return { text: 'Silo staff used emergency access to your organisation', href: hrefWith('/governance/staff/', { session: n.operatorAccessSessionId }), icon: 'warning' };
    case 'action_completed': return { text: 'An Action you started finished', href: hrefWith('/governance/changes/', { receipt: n.receiptId }), icon: 'success' };
    case 'action_event_dead_lettered': return { text: 'An Action event could not be delivered', href: hrefWith('/connect/webhooks/', { subscription: n.actionEventSubscriptionId }), icon: 'error' };
    case 'object_view_layout_invalidated': return { text: 'An object view layout needs review', href: hrefWith('/studio/layouts/', { layout: n.objectViewLayoutId }), icon: 'panelRight' };
    case 'element_deprecated': return { text: 'Something in the ontology you rely on is deprecated', href: hrefWith('/ontology/model/', { element: n.ontologyElementId }), icon: 'ontology' };
    case 'element_retiring': return { text: 'Something in the ontology you rely on is being retired', href: hrefWith('/ontology/model/', { element: n.ontologyElementId }), icon: 'ontology' };
    case 'pipeline_run_failed': return { text: 'A scheduled run of a pipeline you own failed', href: hrefWith('/studio/pipelines/', { run: n.pipelineRunId }), icon: 'error' };
    case 'support_replied': return { text: 'Silo support replied to your ticket', href: hrefWith('/support/', { ticket: n.supportTicketId }), icon: 'ticket' };
  }
}

const TABS: TabDef<'unread' | 'all'>[] = [{ id: 'unread', label: 'Unread' }, { id: 'all', label: 'All' }];

export function NotificationsPanel({ page = false }: { page?: boolean } = {}) {
  const workspace = useWorkspace();
  const { cache } = useData();
  const [tab, setTab] = useStored<'unread' | 'all'>('silo.notifications.tab', 'unread');
  const pages = usePages('listNotifications', (cursor) => ({ query: { limit: 30, ...(tab === 'unread' ? { unread: 'true' } : {}), ...(cursor === undefined ? {} : { cursor }) } }),
    (page) => page.nextCursor, [tab]);
  const markRead = useMutation('markNotificationRead');
  const acknowledge = useMutation('acknowledgeNotification');

  const open = (n: Notification) => {
    workspace.closePanel();
    if (n.readAt === null) {
      void markRead.run({ params: { notificationId: n.id } }).then(() => cache.invalidate((name) => name === 'listNotifications'));
    }
  };

  return (
    <div className={page ? styles.page : styles.panel}>
      {page ? null : (
        <div className={styles.head}>
          <h2 className={styles.title}>Notifications</h2>
          <span className={styles.links}>
            <Link href="/notifications/" className={styles.settings} onClick={() => workspace.closePanel()}>All</Link>
            <Link href="/account/devices/" className={styles.settings} onClick={() => workspace.closePanel()}>Where they go</Link>
          </span>
        </div>
      )}
      <Tabs label="Notifications" tabs={TABS} current={tab} onChange={setTab} group="notifications-" />
      <TabPanel id={tab} group="notifications-">
        {acknowledge.error !== undefined ? <ErrorMessage error={acknowledge.error} /> : null}
        <div className={styles.list}>
          <PagesView pages={pages} what="Notifications" isEmpty={(p) => p.every((page) => page.notifications.length === 0)}
            empty={<EmptyState icon="bell" title={tab === 'unread' ? 'You are up to date' : 'Nothing yet'}>Silo tells you here when something needs you.</EmptyState>}>
            {(list) => (
              <ul className={styles.items}>
                {list.flatMap((page) => page.notifications).map((n) => {
                  const { text, href, icon } = describe(n);
                  const due = n.acknowledgeDueAt !== null && n.acknowledgedAt === null;
                  return (
                    <li key={n.id} className={[styles.item, n.readAt === null ? styles.unread : ''].join(' ')}>
                      <Icon name={icon} size={16} className={styles.icon} />
                      <div className={styles.body}>
                        <Link href={href as never} className={styles.link} onClick={() => open(n)}>
                          {n.readAt === null ? <span className="visually-hidden">Unread: </span> : null}
                          {text}
                        </Link>
                        <span className={styles.when}><Time value={n.createdAt} />{due ? <> · acknowledge by <Time value={n.acknowledgeDueAt} /></> : null}</span>
                        {due ? (
                          <div>
                            <Button size="sm" pending={acknowledge.pending} blocked={acknowledge.blocked}
                              onClick={() => void acknowledge.run({ params: { notificationId: n.id } })}>Acknowledge</Button>
                          </div>
                        ) : null}
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </PagesView>
        </div>
      </TabPanel>
    </div>
  );
}
