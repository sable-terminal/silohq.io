'use client';

// The Ask panel (spec 33.6), on the right of every page: a question here starts a thread scoped
// to the page, as references and definitions, never values shown on it, and the conversation
// goes on in the panel (Ask's own thread view, compact). Collapsed to a strip, its open state kept
// per person.

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import type { Input } from '../api/client.api.ts';
import { IconButton } from '../components/button.component.tsx';
import { useMutation } from '../data/query.data.ts';
import { threadHref } from '../navigation/links.navigation.ts';
import { areaOf } from '../navigation/places.navigation.ts';
import { Composer, ThreadView } from '../views/ask/thread.view.tsx';
import { useWorkspace, type AskScope } from './context.shell.tsx';
import styles from './ask.shell.module.css';

const RAIL_PAGES = ['home', 'explorer', 'clones', 'studio', 'ask', 'scenarios', 'governance', 'connect', 'ontology', 'files', 'siloes'] as const;

/** What a question from this page is scoped to: what the page said, else the page's area. */
export function useAskScope(): { scope: AskScope | undefined; label: string } {
  const workspace = useWorkspace();
  const pathname = usePathname();
  if (workspace.page.scope !== undefined) return { scope: workspace.page.scope, label: workspace.page.scopeLabel ?? 'this page' };
  const area = areaOf(pathname);
  const page = (RAIL_PAGES as readonly string[]).includes(area?.id ?? '') ? area!.id as (typeof RAIL_PAGES)[number] : undefined;
  return { scope: page === undefined ? undefined : { kind: 'page', page }, label: area?.label ?? 'this page' };
}

export function AskPanel() {
  const workspace = useWorkspace();
  const open = workspace.preferences.askPanelOpen;
  const { scope, label } = useAskScope();
  const [threadId, setThreadId] = useState<string | undefined>(undefined);
  const [first, setFirst] = useState<string | undefined>(undefined);
  const create = useMutation('createAskThread');
  const ask = useMutation('askQuestion', { invalidates: ['listAskThreads'] });

  // A question sent from search's last entry.
  useEffect(() => {
    if (!open || workspace.pendingQuestion === undefined) return;
    const pending = workspace.takePendingQuestion();
    if (pending !== undefined) {
      setThreadId(undefined);
      setFirst(pending);
    }
  }, [open, workspace]);

  /** The first question starts a thread scoped to this page; later ones go to that thread, in the panel. */
  const start = async (body: Input<'askQuestion'>['body']) => {
    const thread = await create.run({ body: { ...(scope === undefined ? {} : { scope }) } });
    if (!thread.ok) return false;
    setThreadId(thread.data.id);
    setFirst(undefined);
    return (await ask.run({ params: { threadId: thread.data.id }, body })).ok;
  };

  if (!open) {
    return (
      <aside className={styles.strip} aria-label="Ask">
        <IconButton label="Open the Ask panel" icon="ask" shortcut="Ctrl J" onClick={() => workspace.setPreferences({ askPanelOpen: true })} />
      </aside>
    );
  }
  return (
    <aside className={styles.panel} aria-label="Ask">
      <div className={styles.head}>
        <h2 className={styles.title}>Ask</h2>
        <div className={styles.headActions}>
          {threadId !== undefined ? <IconButton label="A new question" icon="plus" onClick={() => setThreadId(undefined)} /> : null}
          <IconButton label="Close the Ask panel" icon="panelRight" shortcut="Ctrl J" onClick={() => workspace.setPreferences({ askPanelOpen: false })} />
        </div>
      </div>
      {threadId === undefined ? (
        <>
          <p className={styles.scope}>Scoped to: <strong>{label}</strong></p>
          <Composer key={first ?? 'blank'} onAsk={start} pending={create.pending || ask.pending} blocked={create.blocked} error={create.error ?? ask.error}
            initial={first} placeholder={`Ask about ${label}`} />
          <p className={styles.note}>Answers say where every figure came from. Only references to this page cross into the question, never the values shown on it.</p>
        </>
      ) : (
        <>
          <p className={styles.scope}><Link href={threadHref(threadId) as never}>Open this thread in Ask</Link></p>
          <ThreadView threadId={threadId} compact />
        </>
      )}
    </aside>
  );
}
