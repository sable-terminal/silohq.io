// Small labels: a state (with words, never colour alone), a count, a marking.

import type { ReactNode } from 'react';
import { Icon, type IconName } from './icon.component.tsx';
import styles from './badge.component.module.css';

export type Tone = 'neutral' | 'info' | 'ok' | 'warn' | 'danger' | 'accent';

export function Badge({ tone = 'neutral', icon, children, title }: { tone?: Tone; icon?: IconName | undefined; children: ReactNode; title?: string | undefined }) {
  return (
    <span className={`${styles.badge} ${styles[tone]}`} title={title}>
      {icon !== undefined ? <Icon name={icon} size={12} /> : null}
      {children}
    </span>
  );
}

/** A state as a dot and its word: running, failed, paused. */
export function Status({ tone, children }: { tone: Tone; children: ReactNode }) {
  return (
    <span className={styles.status}>
      <span className={`${styles.dot} ${styles[`dot_${tone}`]}`} aria-hidden="true" />
      {children}
    </span>
  );
}

/** A marking on data (spec 57.5): always shown in full, never abbreviated away. */
export function Marking({ children }: { children: ReactNode }) {
  return <span className={styles.marking}><Icon name="shield" size={12} />{children}</span>;
}
