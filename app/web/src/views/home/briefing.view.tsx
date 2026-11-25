'use client';

// Home as a briefing (spec 33.7): what needs this person's attention since they last looked, in
// five sections in fixed order: approvals waiting, Crons that fired, findings, favourited
// clones, and favourited apps with the dashboard's tiles. An empty section collapses to one line;
// a section whose source could not be read says so rather than looking empty. Reading the
// briefing moves "since last visit" on; within this tab the briefing keeps the marker it opened
// with, so reloading the page does not empty it.

import Link from 'next/link';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { Output } from '../../api/client.api.ts';
import { Badge } from '../../components/badge.component.tsx';
import { Icon, type IconName } from '../../components/icon.component.tsx';
import { Page } from '../../components/page.component.tsx';
import { QueryView } from '../../components/query.component.tsx';
import { Time } from '../../components/time.component.tsx';
import { useMutation, useQuery } from '../../data/query.data.ts';
import { approvalHref, appHref, cronHref, findingHref, objectHref } from '../../navigation/links.navigation.ts';
import { usePageContext, useWorkspace } from '../../shell/context.shell.tsx';
import { formatTime } from '../../utils/format.util.ts';
import styles from './briefing.view.module.css';

type Briefing = Output<'readBriefing'>;
type Section<T> = { status: 'ok'; items: T[]; more: boolean } | { status: 'unavailable'; reason: string };

const SINCE_KEY = 'silo.briefing.since';

const RISK: Record<string, string> = { data: 'Data change', bulk: 'Bulk change', external: 'Change to an outside system', physical: 'Physical action' };
const SUBJECT: Record<string, string> = { mutation: 'Action', purge: 'Wipe of stored data', discovery_scan: 'Discovery scan', declassification: 'Declassification' };
const OUTCOME: Record<string, string> = { met: 'condition met', not_met: 'condition not met', indeterminate: 'condition could not be decided' };
const ACTION: Record<string, string> = {
  proposed: 'proposed an Action', executed: 'ran an Action', delivered: 'delivered a report', succeeded: 'notified', failed: 'an action failed', skipped: 'skipped',
};

function greeting(now = new Date()): string {
  const hour = now.getHours();
  return hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
}

/** One of the five sections: its items, one line when empty, or why its source could not be read. */
function Block<T>({ id, title, icon, section, empty, all, children }: {
  id: string;
  title: string;
  icon: IconName;
  section: Section<T>;
  empty: string;
  all?: { href: string; label: string };
  children: (item: T) => ReactNode;
}) {
  const heading = <h2 id={id} className={styles.title}><Icon name={icon} size={16} />{title}</h2>;
  if (section.status === 'unavailable') {
    return (
      <section className={styles.line} aria-labelledby={id}>
        {heading}<span className={styles.problem}>could not be read: {section.reason}</span>
      </section>
    );
  }
  if (section.items.length === 0) {
    return (
      <section className={styles.line} aria-labelledby={id}>
        {heading}<span className={styles.muted}>{empty}</span>
      </section>
    );
  }
  return (
    <section className={styles.card} aria-labelledby={id}>
      <div className={styles.head}>
        {heading}
        <Badge tone="info">{section.items.length}{section.more ? '+' : ''}</Badge>
        {all !== undefined ? <Link href={all.href as never} className={styles.all}>{all.label}</Link> : null}
      </div>
      <ul className={styles.items}>{section.items.map(children)}</ul>
    </section>
  );
}

export function Briefing() {
  const workspace = useWorkspace();
  const [since, setSince] = useState<string | null | undefined>(undefined);
  // This tab keeps the marker it opened with; a new tab starts from the person's last visit.
  useEffect(() => {
    try {
      setSince(window.sessionStorage.getItem(SINCE_KEY));
    } catch {
      setSince(null);
    }
  }, []);
  const briefing = useQuery('readBriefing', since === undefined ? null : { query: since === null ? {} : { since } }, { refreshMs: 120_000 });
  const seen = useMutation('markHomeSeen', { refresh: false });
  const marked = useRef(false);
  useEffect(() => {
    if (briefing.data === undefined || marked.current) return;
    marked.current = true;
    const read = briefing.data;
    void seen.run({}).then((outcome) => {
      if (!outcome.ok || since !== null) return;
      try {
        window.sessionStorage.setItem(SINCE_KEY, outcome.data.previous ?? read.since ?? outcome.data.seenAt);
      } catch {
        // A convenience only.
      }
    });
  }, [briefing.data, seen, since]);

  usePageContext({
    scope: { kind: 'page', page: 'home' },
    scopeLabel: 'Home',
    status: briefing.data === undefined ? undefined : `Briefing as of ${formatTime(briefing.data.generatedAt)}`,
  });

  const data = briefing.data;
  return (
    <Page title={`${greeting()}, ${workspace.person.firstName}`}
      description={data === undefined ? 'What needs your attention.'
        : data.since === null ? 'What needs your attention from the last seven days.'
        : <>What needs your attention since you last looked, <Time value={data.since} />.</>}>
      <QueryView query={briefing} what="Your briefing" skeleton>
        {(b: Briefing) => (
          <div className={styles.briefing}>
            <Block id="briefing-approvals" title="Approvals waiting" icon="check" section={b.approvals} empty="nothing waits for you"
              all={{ href: '/governance/approvals/', label: 'All approvals' }}>
              {(a) => (
                <li key={a.chainId} className={styles.item}>
                  <Link href={approvalHref(a.chainId) as never} className={styles.link}>{a.riskClass === null ? SUBJECT[a.subjectKind] : RISK[a.riskClass]}</Link>
                  <span className={styles.meta}>
                    {a.approvalsReceived} of {a.approvalsRequired} approvals · requested <Time value={a.createdAt} /> · expires <Time value={a.expiresAt} />
                  </span>
                </li>
              )}
            </Block>
            <Block id="briefing-crons" title="Crons that fired" icon="cron" section={b.crons} empty="none of your Crons ran"
              all={{ href: '/governance/crons/', label: 'All Crons' }}>
              {(c) => (
                <li key={c.runId} className={styles.item}>
                  <Link href={cronHref(c.cronId) as never} className={styles.link}>{c.cronName}</Link>
                  <span className={styles.meta}>
                    {[c.conditionOutcome === null ? undefined : OUTCOME[c.conditionOutcome], ...c.actions.map((x) => ACTION[x.outcome]),
                      c.status === 'failed' ? 'the run failed' : undefined, c.owned ? undefined : 'followed'].filter(Boolean).join(' · ')}
                    {' · '}<Time value={c.startedAt} />
                  </span>
                </li>
              )}
            </Block>
            <Block id="briefing-findings" title="Findings" icon="sparkle" section={b.findings} empty="no new findings on what you follow"
              all={{ href: '/explorer/findings/', label: 'All findings' }}>
              {(f) => (
                <li key={f.findingId} className={styles.item}>
                  <Link href={findingHref(f.findingId) as never} className={styles.link}>
                    {f.detectorLabel} on {f.objectCount} {f.objectCount === 1 ? f.objectTypeName : f.objectTypePlural}
                  </Link>
                  <span className={styles.meta}>{f.sets.map((s) => s.name).join(' · ')}{f.sets.length > 0 ? ' · ' : ''}<Time value={f.raisedAt} /></span>
                </li>
              )}
            </Block>
            <Block id="briefing-clones" title="Favourited clones" icon="clones" section={b.clones} empty="you have favourited no objects">
              {(o) => (
                <li key={o.favouriteId} className={styles.item}>
                  <Link href={objectHref({ objectTypeId: o.objectTypeId, objectId: o.objectRef }) as never} className={styles.link}>{o.objectTypeName}</Link>
                  <span className={styles.meta}>{o.objectRef}</span>
                </li>
              )}
            </Block>
            <section className={styles.pair} aria-label="Favourited apps and your dashboard">
              <Block id="briefing-apps" title="Favourited apps" icon="studio" section={b.apps} empty="you have favourited no apps"
                all={{ href: '/studio/apps/', label: 'All apps' }}>
                {(a) => (
                  <li key={a.favouriteId} className={styles.item}>
                    <Link href={appHref(a.appId) as never} className={styles.link}>{a.name}</Link>
                  </li>
                )}
              </Block>
              <Block id="briefing-dashboard" title="Your dashboard" icon="chart" section={b.dashboard} empty="favourite a saved view to add it here"
                all={{ href: '/ask/dashboard/', label: 'Open the dashboard' }}>
                {(t) => (
                  <li key={t.tileId} className={styles.item}>
                    <Link href="/ask/dashboard/" className={styles.link}>{t.name}</Link>
                    <span className={styles.meta}>{t.lastRunAt === null ? 'not run yet' : <>last run <Time value={t.lastRunAt} /></>}</span>
                  </li>
                )}
              </Block>
            </section>
          </div>
        )}
      </QueryView>
    </Page>
  );
}
