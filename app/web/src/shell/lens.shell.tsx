'use client';

// The Lens chip (spec 38.9): which of the person's Lenses applies, across Explorer, object views,
// the Clone Canvas, Ask and Recognition. A Lens belongs to the membership; the one chosen is kept
// in this browser for that membership. Choosing none shows the shared ontology alone.

import Link from 'next/link';
import { Button } from '../components/button.component.tsx';
import { Icon } from '../components/icon.component.tsx';
import { Popover } from '../components/popover.component.tsx';
import { ErrorMessage, Loading } from '../components/states.component.tsx';
import { useQuery } from '../data/query.data.ts';
import { useWorkspace } from './context.shell.tsx';
import styles from './lens.shell.module.css';

export function LensChip() {
  const workspace = useWorkspace();
  const label = workspace.lens === undefined ? 'No Lens' : workspace.lens.name;
  return (
    <Popover label="Choose a Lens" side="bottom" align="start" className={styles.panel}
      open={workspace.panel?.name === 'lens'}
      onOpenChange={(open) => (open ? workspace.panel?.name !== 'lens' && workspace.openPanel('lens') : workspace.panel?.name === 'lens' && workspace.closePanel())}
      renderTrigger={(props) => (
        <Button {...props} variant="ghost" icon="lens" iconEnd="chevronDown" className={styles.chip} aria-label={`Lens: ${label}. Choose a Lens`}>
          <span className={styles.chipText}>{label}</span>
        </Button>
      )}>
      {(close) => <LensList close={close} />}
    </Popover>
  );
}

function LensList({ close }: { close: () => void }) {
  const workspace = useWorkspace();
  const mine = useQuery('listRecognitionLenses', {});
  const shared = useQuery('listSharedRecognitionLenses', {});
  const choose = (lens: { id: string; name: string } | undefined) => {
    workspace.setLens(lens);
    close();
  };
  const option = (lens: { id: string; name: string } | undefined, detail?: string) => {
    const chosen = workspace.lens?.id === lens?.id;
    return (
      <li key={lens?.id ?? 'none'}>
        <button type="button" className={styles.option} aria-pressed={chosen} onClick={() => choose(lens)}>
          <span className={styles.tick}>{chosen ? <Icon name="check" size={14} /> : null}</span>
          <span className={styles.text}>
            <span>{lens?.name ?? 'No Lens'}</span>
            <span className={styles.detail}>{detail ?? (lens === undefined ? 'The shared ontology alone' : '')}</span>
          </span>
        </button>
      </li>
    );
  };
  return (
    <div className={styles.body}>
      <p className={styles.intro}>A Lens is your private layer over the shared ontology: your dispositions, links and working sets.</p>
      <ul className={styles.list}>
        {option(undefined)}
        {mine.data?.lenses.map((lens) => option({ id: lens.id, name: lens.name }, 'Yours'))}
        {shared.data?.lenses.map((lens) => option({ id: lens.id, name: lens.name }, 'Shared with you'))}
      </ul>
      {mine.status === 'loading' ? <Loading label="Loading your Lenses" block={false} /> : null}
      {mine.status === 'error' ? <ErrorMessage error={mine.error} onRetry={mine.refetch} /> : null}
      <div className={styles.foot}>
        <Link href="/explorer/lenses/?new=1" onClick={close}>New Lens</Link>
        <Link href="/explorer/lenses/" onClick={close}>Manage Lenses</Link>
      </div>
    </div>
  );
}
