'use client';

// The organisation's state, above every page (guarantee 5): writes paused for a cell migration,
// Silo staff with access right now, the network gone, the cell shedding load, the session about
// to end. Each says what it means for the person and what happens next.

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Banner } from '../components/banner.component.tsx';
import { Time } from '../components/time.component.tsx';
import { useBlocked, useClientStatus, useQuery } from '../data/query.data.ts';
import { formatTime } from '../utils/format.util.ts';
import { useWorkspace } from './context.shell.tsx';
import styles from './banners.shell.module.css';

const WARN_BEFORE_MS = 10 * 60_000;

export function Banners() {
  const workspace = useWorkspace();
  const status = useClientStatus();
  const staffBlocked = useBlocked('listOperatorAccessSessions');
  const staff = useQuery('listOperatorAccessSessions', staffBlocked === undefined ? { query: { status: 'active', limit: 5 } } : null, { refreshMs: 60_000 });
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);

  const migration = workspace.residency?.migration;
  const endsAt = Date.parse(workspace.session.absoluteExpiresAt);
  const ending = Number.isFinite(endsAt) && endsAt - now < WARN_BEFORE_MS && endsAt > now;
  const active = staff.data?.sessions ?? [];

  const banners = [
    status.paused ? (
      <Banner key="paused" tone="warn" title="Changes are paused" urgent>
        Your organisation is moving to another Silo cell. Reading goes on; changes wait until the move completes
        {migration?.windowEndsAt != null ? <>, expected by <Time value={migration.windowEndsAt} exact /></> : null}.
      </Banner>
    ) : null,
    active.length > 0 ? (
      <Banner key="staff" tone="warn" title="Silo staff have access to your organisation"
        action={<Link href="/governance/staff/">Review</Link>}>
        {active.map((s) => `${s.operatorDisplayName}${s.ticketReference === null ? '' : ` (ticket ${s.ticketReference})`}${s.expiresAt === null ? '' : ` until ${formatTime(s.expiresAt)}`}`).join('; ')}.
      </Banner>
    ) : null,
    status.offline ? (
      <Banner key="offline" tone="danger" title="You are offline" urgent>
        What you see may be out of date. Silo reads it again when your connection returns.
      </Banner>
    ) : null,
    status.overloadedUntil !== undefined ? (
      <Banner key="busy" tone="info" title="Silo is busy">
        It is protecting itself under heavy load: some requests wait and are tried again on their own.
      </Banner>
    ) : null,
    ending ? (
      <Banner key="ending" tone="info" title={`Your session ends at ${formatTime(endsAt)}`}>
        Save what you are working on. You will be asked to sign in again, and come back to this page.
      </Banner>
    ) : null,
  ].filter(Boolean);

  if (banners.length === 0) return null;
  return <div className={styles.banners}>{banners}</div>;
}
