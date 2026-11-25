'use client';

// Settings' first page: every configuration of the organisation, grouped, each saying what it is
// for. Configuration only (spec 33.4): product surfaces live in the sidebar's areas.

import Link from 'next/link';
import { Icon } from '../../components/icon.component.tsx';
import { Page } from '../../components/page.component.tsx';
import { SETTINGS } from '../../navigation/settings.navigation.ts';
import { usePlaceGate } from './frame.view.tsx';
import styles from './home.view.module.css';

export function SettingsHome() {
  const gate = usePlaceGate();
  return (
    <Page title="Settings" description="How your organisation is set up: people, sign-in, security, change control, data and billing.">
      {SETTINGS.map((group) => (
        <section key={group.id} className={styles.group} aria-labelledby={`settings-${group.id}`}>
          <h2 id={`settings-${group.id}`} className={styles.groupTitle}>{group.label}</h2>
          <ul className={styles.grid}>
            {group.items.map((place) => {
              const blocked = gate(place);
              const body = (
                <>
                  {place.icon !== undefined ? <Icon name={place.icon} size={18} className={styles.icon} /> : null}
                  <span className={styles.text}>
                    <span className={styles.label}>{place.label}</span>
                    <span className={styles.purpose}>{blocked ?? place.purpose}</span>
                  </span>
                </>
              );
              return (
                <li key={place.href}>
                  {blocked !== undefined
                    ? <span className={styles.card} aria-disabled="true">{body}</span>
                    : <Link href={place.href as never} className={styles.card}>{body}</Link>}
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </Page>
  );
}
