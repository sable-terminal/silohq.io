'use client';

// The + menu: everything a person can make, grouped by what they are doing. Each item opens the
// place it is made in with its form open. An item the person may not make is shown disabled with
// the permission it needs.

import Link from 'next/link';
import { Button } from '../components/button.component.tsx';
import { Icon } from '../components/icon.component.tsx';
import { Popover } from '../components/popover.component.tsx';
import { usePermits } from '../data/query.data.ts';
import { CREATE } from '../navigation/create.navigation.ts';
import { useWorkspace } from './context.shell.tsx';
import styles from './create.shell.module.css';

export function CreateMenu() {
  const workspace = useWorkspace();
  const blockedOf = usePermits();
  return (
    <Popover label="Create" side="bottom" align="start" className={styles.panel}
      open={workspace.panel?.name === 'create'}
      onOpenChange={(open) => (open ? workspace.panel?.name !== 'create' && workspace.openPanel('create') : workspace.panel?.name === 'create' && workspace.closePanel())}
      renderTrigger={(props) => <Button {...props} variant="primary" icon="plus" aria-label="Create">New</Button>}>
      {(close) => (
        <div className={styles.grid}>
          {CREATE.map((group) => (
            <section key={group.label} className={styles.group} aria-labelledby={`create-${group.label}`}>
              <h2 id={`create-${group.label}`} className={styles.groupTitle}>{group.label}</h2>
              <ul className={styles.items}>
                {group.items.map((item) => {
                  const blocked = blockedOf(item.route);
                  const body = (
                    <>
                      <Icon name={item.icon} size={16} className={styles.icon} />
                      <span className={styles.text}>
                        <span className={styles.label}>{item.label}</span>
                        <span className={styles.description}>{blocked?.message ?? item.description}</span>
                      </span>
                    </>
                  );
                  return (
                    <li key={item.label}>
                      {blocked !== undefined ? (
                        <span className={styles.item} aria-disabled="true" tabIndex={0}>{body}</span>
                      ) : (
                        <Link href={item.href as never} className={styles.item} onClick={close}>{body}</Link>
                      )}
                    </li>
                  );
                })}
              </ul>
            </section>
          ))}
        </div>
      )}
    </Popover>
  );
}
