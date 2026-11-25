'use client';

// What a region shows when it has nothing to show yet, nothing at all, or a failure. A failure
// says what happened in the person's terms, offers what can be done (try again, sign in,
// contact support), and quotes the correlation id so support can find the request. A refusal
// the cell decided (a bound, spec 12.1) is stated as the answer it is, not as a fault.

import { useEffect, useState, type ReactNode } from 'react';
import { ApiError, isApiError } from '../api/client.api.ts';
import { Button } from './button.component.tsx';
import { CopyButton } from './copy.component.tsx';
import { Icon, type IconName } from './icon.component.tsx';
import { Spinner } from './spinner.component.tsx';
import styles from './states.component.module.css';

/** Asks the shell to open a new support ticket, quoting a request. */
export function contactSupport(reference?: { correlationId?: string | undefined; route?: string | undefined }): void {
  window.dispatchEvent(new CustomEvent('silo:support', { detail: reference ?? {} }));
}

interface Explained {
  title: string;
  detail: string;
  icon: IconName;
  retry: boolean;
  support: boolean;
}

/** A failure in the person's terms. */
export function explain(error: unknown): Explained {
  if (!isApiError(error)) {
    return { title: 'Something went wrong', detail: 'This part of the page failed. Try again; if it keeps failing, contact support.', icon: 'error', retry: true, support: true };
  }
  switch (error.kind) {
    case 'offline': return { title: 'You are offline', detail: 'Silo could not be reached. It will try again when your connection returns.', icon: 'offline', retry: true, support: false };
    case 'timeout': return { title: 'Silo did not answer in time', detail: 'The request took too long. Try again.', icon: 'clock', retry: true, support: true };
    case 'unauthenticated': return { title: 'Your session has ended', detail: 'Sign in again to carry on.', icon: 'lock', retry: false, support: false };
    case 'mfa': return { title: 'Confirm it is you', detail: 'Your session needs its second factor.', icon: 'lock', retry: false, support: false };
    case 'forbidden': return { title: 'You do not have access', detail: error.sentence, icon: 'lock', retry: false, support: false };
    case 'not_found': return { title: 'Not found', detail: 'It may have been archived or deleted, or you may not have access to it.', icon: 'info', retry: false, support: false };
    case 'paused': return { title: 'Changes are paused', detail: error.sentence, icon: 'pause', retry: false, support: false };
    case 'refused': return { title: 'Refused', detail: error.sentence, icon: 'info', retry: false, support: false };
    case 'overloaded': {
      const wait = error.retryAfterSeconds === undefined ? '' : ` Try again in ${error.retryAfterSeconds} seconds.`;
      return { title: 'Silo is busy', detail: `Silo is protecting itself under heavy load.${wait}`, icon: 'clock', retry: true, support: false };
    }
    case 'unavailable': return { title: 'A system could not be reached', detail: error.sentence, icon: 'warning', retry: true, support: true };
    case 'validation': case 'conflict': return { title: 'It could not be done', detail: error.sentence, icon: 'warning', retry: false, support: false };
    default: return { title: 'Something went wrong on Silo\'s side', detail: 'The request failed. Try again; if it keeps failing, contact support and quote the reference.', icon: 'error', retry: true, support: true };
  }
}

/** A failure inside a form or beside a control: one line, with the reference. */
export function ErrorMessage({ error, onRetry }: { error: unknown; onRetry?: (() => void) | undefined }) {
  const said = explain(error);
  const ref = error instanceof ApiError ? error.correlationId : undefined;
  const detail = said.title === 'It could not be done' || said.title === 'Refused' || said.title === 'You do not have access' || said.title === 'Changes are paused' ? said.detail : `${said.title}. ${said.detail}`;
  return (
    <div className={styles.inline} role="alert">
      <Icon name={said.icon} size={16} className={styles.inlineIcon} />
      <div className={styles.inlineText}>
        <span>{detail}</span>
        {ref !== undefined ? <span className={styles.reference}>Reference {ref} <CopyButton value={ref} label="Copy reference" /></span> : null}
      </div>
      {onRetry !== undefined && said.retry ? <Button size="sm" onClick={onRetry}>Try again</Button> : null}
    </div>
  );
}

/** A failure in place of a region's content. */
export function ErrorState({ error, onRetry, what }: { error: unknown; onRetry?: (() => void) | undefined; what?: string | undefined }) {
  const said = explain(error);
  const ref = error instanceof ApiError ? error.correlationId : undefined;
  const route = error instanceof ApiError ? error.route : undefined;
  return (
    <div className={styles.block} role="alert">
      <Icon name={said.icon} size={24} className={styles.blockIcon} />
      <h2 className={styles.blockTitle}>{what !== undefined && said.retry ? `${what} could not be loaded` : said.title}</h2>
      <p className={styles.blockDetail}>{said.detail}</p>
      {ref !== undefined ? <p className={styles.reference}>Reference {ref} <CopyButton value={ref} label="Copy reference" /></p> : null}
      <div className={styles.actions}>
        {onRetry !== undefined && said.retry ? <Button onClick={onRetry} icon="refresh">Try again</Button> : null}
        {said.support ? <Button variant="ghost" icon="ticket" onClick={() => contactSupport({ correlationId: ref, route })}>Contact support</Button> : null}
      </div>
    </div>
  );
}

/** Nothing here yet: what this place is for, and how to fill it. */
export function EmptyState({ icon = 'info', title, children, action }: { icon?: IconName; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className={styles.block}>
      <Icon name={icon} size={24} className={styles.blockIcon} />
      <h2 className={styles.blockTitle}>{title}</h2>
      {children !== undefined ? <div className={styles.blockDetail}>{children}</div> : null}
      {action !== undefined ? <div className={styles.actions}>{action}</div> : null}
    </div>
  );
}

/** Loading, said once for assistive technology; shown only after a moment, so a fast answer never flickers. */
export function Loading({ label = 'Loading', delayMs = 200, block = true }: { label?: string; delayMs?: number; block?: boolean }) {
  const [visible, setVisible] = useState(delayMs === 0);
  useEffect(() => {
    if (delayMs === 0) return undefined;
    const timer = setTimeout(() => setVisible(true), delayMs);
    return () => clearTimeout(timer);
  }, [delayMs]);
  return (
    <div className={block ? styles.loading : styles.loadingInline} role="status" aria-live="polite">
      {visible ? <><Spinner size={block ? 20 : 14} /><span>{label}…</span></> : <span className="visually-hidden">{label}…</span>}
    </div>
  );
}

/** Placeholder lines while a list or table loads. */
export function Skeleton({ rows = 5 }: { rows?: number }) {
  return (
    <div className={styles.skeleton} aria-hidden="true">
      {Array.from({ length: rows }, (_, i) => <div key={i} className={styles.skeletonRow} />)}
    </div>
  );
}
