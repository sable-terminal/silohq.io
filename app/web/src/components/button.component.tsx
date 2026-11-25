'use client';

// Buttons. A button that cannot be used now stays visible and focusable, says why (spec 33.3:
// disabled, never hidden), and ignores presses: aria-disabled rather than the disabled
// attribute, which would take it out of the tab order and hide the reason from a keyboard. A
// pending button shows that it is working and ignores further presses, so a double click
// never sends twice.

import Link from 'next/link';
import { useId, type ButtonHTMLAttributes, type MouseEvent, type ReactNode, type Ref } from 'react';
import type { Blocked } from '../data/query.data.ts';
import { Icon, type IconName } from './icon.component.tsx';
import { Spinner } from './spinner.component.tsx';
import { Tooltip } from './tooltip.component.tsx';
import styles from './button.component.module.css';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'link';

export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'disabled'> {
  variant?: ButtonVariant;
  size?: 'sm' | 'md';
  icon?: IconName | undefined;
  iconEnd?: IconName | undefined;
  pending?: boolean | undefined;
  disabled?: boolean | undefined;
  /** Why it cannot be used: shown, and read out with the button. */
  blocked?: Blocked | string | undefined;
  ref?: Ref<HTMLButtonElement> | undefined;
  children?: ReactNode;
}

export function Button({ variant = 'secondary', size = 'md', icon, iconEnd, pending, disabled, blocked, className, onClick, children, type = 'button', ref, ...rest }: ButtonProps) {
  const reasonId = useId();
  const reason = typeof blocked === 'string' ? blocked : blocked?.message;
  const inert = disabled === true || reason !== undefined || pending === true;
  const classes = [styles.button, styles[variant], styles[size], children === undefined || children === null ? styles.iconOnly : '', className ?? ''].filter(Boolean).join(' ');
  const button = (
    <button
      {...rest}
      ref={ref}
      type={type}
      className={classes}
      aria-disabled={inert || undefined}
      aria-busy={pending || undefined}
      aria-describedby={reason !== undefined ? [rest['aria-describedby'], reasonId].filter(Boolean).join(' ') : rest['aria-describedby']}
      onClick={(event: MouseEvent<HTMLButtonElement>) => {
        if (inert) {
          event.preventDefault();
          event.stopPropagation();
          return;
        }
        onClick?.(event);
      }}
    >
      {pending ? <Spinner size={14} /> : icon !== undefined ? <Icon name={icon} size={size === 'sm' ? 14 : 16} /> : null}
      {children !== undefined && children !== null ? <span className={styles.label}>{children}</span> : null}
      {iconEnd !== undefined ? <Icon name={iconEnd} size={size === 'sm' ? 14 : 16} /> : null}
    </button>
  );
  // The reason describes the button and is never part of its name, so it sits beside it.
  return reason !== undefined ? <><Tooltip content={reason}>{button}</Tooltip><span id={reasonId} className="visually-hidden">{reason}</span></> : button;
}

/** A button that is only an icon: its label is required, read out, and shown on hover. */
export function IconButton({ label, icon, shortcut, badge, tooltip = true, ...rest }: Omit<ButtonProps, 'children' | 'icon' | 'aria-label'> & {
  label: string;
  icon: IconName;
  /** Shown beside the label, e.g. "/". */
  shortcut?: string | undefined;
  /** A count beside the icon (unread notifications); read as part of the label. */
  badge?: number | undefined;
  tooltip?: boolean;
}) {
  const reason = typeof rest.blocked === 'string' ? rest.blocked : rest.blocked?.message;
  const spoken = badge !== undefined && badge > 0 ? `${label}, ${badge > 99 ? 'more than 99' : badge}` : label;
  const button = (
    <Button {...rest} variant={rest.variant ?? 'ghost'} icon={icon} aria-label={spoken} aria-keyshortcuts={shortcut}>
      {badge !== undefined && badge > 0 ? <span className={styles.badge} aria-hidden="true">{badge > 99 ? '99+' : badge}</span> : undefined}
    </Button>
  );
  if (!tooltip || reason !== undefined) return button;
  return <Tooltip content={shortcut === undefined ? label : <>{label} <kbd className={styles.kbd}>{shortcut}</kbd></>}>{button}</Tooltip>;
}

/** A link that looks like a button: for a control that goes to a page (Settings, "Open"). */
export function LinkButton({ href, variant = 'secondary', size = 'md', icon, children, label, className }: {
  href: string;
  variant?: ButtonVariant;
  size?: 'sm' | 'md';
  icon?: IconName | undefined;
  children?: ReactNode;
  /** For an icon-only link: its name, read out and shown on hover. */
  label?: string | undefined;
  className?: string | undefined;
}) {
  const iconOnly = children === undefined || children === null;
  const link = (
    <Link href={href as never} aria-label={iconOnly ? label : undefined}
      className={[styles.button, styles[variant], styles[size], iconOnly ? styles.iconOnly : '', className ?? ''].filter(Boolean).join(' ')}>
      {icon !== undefined ? <Icon name={icon} size={size === 'sm' ? 14 : 16} /> : null}
      {iconOnly ? null : <span className={styles.label}>{children}</span>}
    </Link>
  );
  return iconOnly && label !== undefined ? <Tooltip content={label}>{link}</Tooltip> : link;
}
