'use client';

// A menu of commands from a button: arrow keys move between items, Home and End jump, typing a
// letter goes to the next item starting with it, Enter or Space chooses, Escape closes and
// returns to the button. An item the person cannot use is shown disabled with the reason under
// its label (spec 33.3), never left out.

import Link from 'next/link';
import { useRef, type KeyboardEvent, type ReactElement } from 'react';
import type { Blocked } from '../data/query.data.ts';
import { Icon, type IconName } from './icon.component.tsx';
import { Popover, type TriggerProps } from './popover.component.tsx';
import type { Align, Side } from '../utils/position.util.ts';
import styles from './menu.component.module.css';

export interface MenuItem {
  label: string;
  description?: string | undefined;
  icon?: IconName | undefined;
  shortcut?: string | undefined;
  onSelect?: (() => void) | undefined;
  /** A page of this client: followed without reloading. */
  href?: string | undefined;
  disabled?: boolean | undefined;
  blocked?: Blocked | string | undefined;
  tone?: 'danger' | undefined;
  /** A choice among several (theme): shown ticked when chosen. */
  checked?: boolean | undefined;
}

export type MenuEntry = MenuItem | { separator: true } | { group: string };

const isItem = (entry: MenuEntry): entry is MenuItem => 'label' in entry;

export function Menu({ label, renderTrigger, items, side = 'bottom', align = 'end', header }: {
  label: string;
  renderTrigger: (props: TriggerProps) => ReactElement;
  items: readonly MenuEntry[];
  side?: Side;
  align?: Align;
  /** Shown above the items: who is signed in, say. */
  header?: ReactElement | undefined;
}) {
  return (
    <Popover label={label} renderTrigger={renderTrigger} role="menu" side={side} align={align} className={styles.menu}>
      {(close) => <MenuList items={items} close={close} header={header} />}
    </Popover>
  );
}

function MenuList({ items, close, header }: { items: readonly MenuEntry[]; close: () => void; header: ReactElement | undefined }) {
  const list = useRef<HTMLDivElement | null>(null);
  const focusables = () => [...(list.current?.querySelectorAll<HTMLElement>('[role^="menuitem"]') ?? [])];

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const all = focusables();
    const at = all.indexOf(document.activeElement as HTMLElement);
    const move = (to: number) => {
      event.preventDefault();
      all[(to + all.length) % all.length]?.focus();
    };
    switch (event.key) {
      case 'ArrowDown': move(at + 1); break;
      case 'ArrowUp': move(at < 0 ? all.length - 1 : at - 1); break;
      case 'Home': move(0); break;
      case 'End': move(all.length - 1); break;
      case 'Tab': close(); break;
      default:
        if (event.key.length === 1 && /\S/.test(event.key)) {
          const letter = event.key.toLowerCase();
          const next = [...all.slice(at + 1), ...all.slice(0, at + 1)].find((el) => (el.dataset['label'] ?? '').toLowerCase().startsWith(letter));
          if (next !== undefined) {
            event.preventDefault();
            next.focus();
          }
        }
    }
  };

  return (
    <div ref={list} className={styles.list} onKeyDown={onKeyDown}>
      {header !== undefined ? <div className={styles.header}>{header}</div> : null}
      {items.map((entry, i) => {
        if ('separator' in entry) return <div key={`s${i}`} role="separator" className={styles.separator} />;
        if (!isItem(entry)) return <div key={`g${i}`} role="presentation" className={styles.group}>{entry.group}</div>;
        const reason = typeof entry.blocked === 'string' ? entry.blocked : entry.blocked?.message;
        const inert = entry.disabled === true || reason !== undefined;
        const role = entry.checked === undefined ? 'menuitem' : 'menuitemradio';
        const body = (
          <>
            <span className={styles.icon}>{entry.checked === true ? <Icon name="check" size={16} /> : entry.icon !== undefined ? <Icon name={entry.icon} size={16} /> : null}</span>
            <span className={styles.text}>
              <span className={styles.label}>{entry.label}</span>
              {reason !== undefined || entry.description !== undefined ? <span className={styles.description}>{reason ?? entry.description}</span> : null}
            </span>
            {entry.shortcut !== undefined ? <kbd className={styles.shortcut}>{entry.shortcut}</kbd> : null}
          </>
        );
        const common = {
          role,
          tabIndex: -1,
          'data-label': entry.label,
          'aria-disabled': inert || undefined,
          'aria-checked': entry.checked,
          className: [styles.item, entry.tone === 'danger' ? styles.danger : ''].filter(Boolean).join(' '),
        };
        if (entry.href !== undefined && !inert) {
          return <Link key={entry.label} href={entry.href as never} {...common} onClick={() => close()}>{body}</Link>;
        }
        return (
          <button key={entry.label} type="button" {...common} onClick={() => {
            if (inert) return;
            close();
            entry.onSelect?.();
          }}>
            {body}
          </button>
        );
      })}
    </div>
  );
}
