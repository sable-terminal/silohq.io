// A message across a page or region: the organisation's state, a warning about what is shown,
// the outcome of something just done. Its role follows its urgency: an alert is read out at
// once, a status when the reader is free.

import type { ReactNode } from 'react';
import { Icon, type IconName } from './icon.component.tsx';
import styles from './banner.component.module.css';

const ICONS: Record<string, IconName> = { info: 'info', ok: 'success', warn: 'warning', danger: 'error' };

export function Banner({ tone = 'info', title, children, action, urgent = false }: {
  tone?: 'info' | 'ok' | 'warn' | 'danger';
  title?: ReactNode;
  children?: ReactNode;
  action?: ReactNode;
  urgent?: boolean;
}) {
  return (
    <div className={`${styles.banner} ${styles[tone]}`} role={urgent ? 'alert' : 'status'}>
      <Icon name={ICONS[tone]!} size={16} className={styles.icon} />
      <div className={styles.text}>
        {title !== undefined ? <strong className={styles.title}>{title}</strong> : null}
        {children !== undefined ? <span>{children}</span> : null}
      </div>
      {action !== undefined ? <div className={styles.action}>{action}</div> : null}
    </div>
  );
}
