'use client';

// Ask (spec 36): the person's threads down the left, searchable, and the open thread beside
// them. A new thread starts here, or with one of the AI agents the person may ask (D236); a thread
// is renamed, rescoped to everything, or archived from its header. ?new=1&q= starts a thread with
// that question (search's "Ask:" entry and the + menu).

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { Badge } from '../../components/badge.component.tsx';
import { Button, IconButton } from '../../components/button.component.tsx';
import { ConfirmDialog, Dialog } from '../../components/dialog.component.tsx';
import { FormActions, SelectField, TextField } from '../../components/field.component.tsx';
import { Menu } from '../../components/menu.component.tsx';
import { QueryView } from '../../components/query.component.tsx';
import { SearchInput } from '../../components/search.component.tsx';
import { EmptyState, ErrorMessage } from '../../components/states.component.tsx';
import { Time } from '../../components/time.component.tsx';
import { useToast } from '../../components/toast.component.tsx';
import { useMutation, usePermits, useQuery } from '../../data/query.data.ts';
import { useParams } from '../../hooks/params.hook.ts';
import { threadHref } from '../../navigation/links.navigation.ts';
import { usePageContext } from '../../shell/context.shell.tsx';
import { Composer, ThreadView } from './thread.view.tsx';
import styles from './ask.view.module.css';

type Scope = { kind: string; page?: string } | null;

/** How a thread's scope reads. */
export function scopeText(scope: Scope): string {
  if (scope === null) return 'Everything you may see';
  switch (scope.kind) {
    case 'page': return `The ${scope.page ?? 'page'} pages`;
    case 'object': return 'One object';
    case 'object_set': return 'An object set';
    case 'app': return 'An app';
    case 'scenario': return 'A scenario';
    case 'saved_view': return 'A saved view';
    default: return 'A part of Silo';
  }
}

export function Threads() {
  const router = useRouter();
  const say = useToast();
  const [params, setParams] = useParams();
  const threadId = params.get('thread') ?? undefined;
  const [search, setSearch] = useState('');
  const [archived, setArchived] = useState(false);
  const threads = useQuery('listAskThreads', { query: { ...(search === '' ? {} : { search }), archived: archived ? 'true' : 'false' } }, { keepPrevious: true });
  const blockedOf = usePermits();
  const agentsMine = useQuery('listAiAgents', blockedOf('listAiAgents') === undefined ? { query: { filter: 'mine' } } : null);
  const agentsShared = useQuery('listAiAgents', blockedOf('listAiAgents') === undefined ? { query: { filter: 'shared' } } : null);
  const agents = [...(agentsMine.data?.aiAgents ?? []), ...(agentsShared.data?.aiAgents ?? [])];
  const create = useMutation('createAskThread');
  const askFirst = useMutation('askQuestion', { invalidates: ['listAskThreads'] });
  const current = threadId === undefined ? undefined : threads.data?.threads.find((t) => t.id === threadId);
  usePageContext({ scope: { kind: 'page', page: 'ask' }, scopeLabel: 'Ask' });

  const start = async (body: { aiAgentId?: string }, question?: string) => {
    const made = await create.run({ body });
    if (!made.ok) return false;
    if (question !== undefined) await askFirst.run({ params: { threadId: made.data.id }, body: { question } });
    router.push(threadHref(made.data.id) as never);
    return true;
  };

  // ?new=1&q=: start a thread with the question once.
  const started = useRef(false);
  useEffect(() => {
    if (started.current || params.get('new') === null) return;
    started.current = true;
    const q = params.get('q') ?? undefined;
    setParams({ new: undefined, q: undefined });
    if (q !== undefined && q.trim() !== '') void start({}, q.trim());
  }, []);

  return (
    <div className={styles.layout}>
      <nav className={styles.list} aria-label="Your threads">
        <div className={styles.listHead}>
          <h1 className={styles.listTitle}>Ask</h1>
          <Button variant="primary" icon="plus" pending={create.pending} blocked={create.blocked} onClick={() => void start({})}>New thread</Button>
        </div>
        {agents.length > 0 ? (
          <SelectField label="Ask an AI agent" value="" options={agents.map((a) => ({ value: a.id, label: a.name }))} placeholder="Choose an agent…"
            onChange={(e) => {
              if (e.target.value !== '') void start({ aiAgentId: e.target.value });
            }} />
        ) : null}
        <SearchInput label="Search your threads" value={search} onChange={setSearch} />
        <div className={styles.listTabs}>
          <Button size="sm" variant={archived ? 'ghost' : 'secondary'} onClick={() => setArchived(false)} aria-pressed={!archived}>Open</Button>
          <Button size="sm" variant={archived ? 'secondary' : 'ghost'} onClick={() => setArchived(true)} aria-pressed={archived}>Archived</Button>
          <Link href="/ask/views/" className={styles.listLink}>Saved views</Link>
          <Link href="/ask/dashboard/" className={styles.listLink}>Dashboard</Link>
        </div>
        {create.error !== undefined ? <ErrorMessage error={create.error} /> : null}
        <QueryView query={threads} what="Your threads" isEmpty={(d) => d.threads.length === 0}
          empty={<p className={styles.muted}>{search !== '' ? 'No thread matches.' : archived ? 'No archived threads.' : 'No threads yet.'}</p>}>
          {(d) => (
            <ul className={styles.threadList}>
              {d.threads.map((t) => (
                <li key={t.id}>
                  <Link href={threadHref(t.id) as never} className={styles.threadLink} aria-current={t.id === threadId ? 'page' : undefined}>
                    <span className={styles.threadTitle}>{t.title}</span>
                    <span className={styles.threadMeta}>
                      <Time value={t.lastActivityAt} /> · {t.turnCount === 1 ? '1 turn' : `${t.turnCount} turns`}{t.aiAgentId !== null ? ' · AI agent' : ''}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </QueryView>
      </nav>
      <section className={styles.main} aria-label="Thread">
        {threadId === undefined ? (
          <div className={styles.welcome}>
            <EmptyState icon="ask" title="Ask about your data">
              Questions in plain language, answered over the systems you are connected to, with where every figure came from. Only what you may see is ever read.
            </EmptyState>
            <Composer onAsk={async (body) => start({}, body.question)} pending={create.pending || askFirst.pending} blocked={create.blocked} error={create.error ?? askFirst.error} />
          </div>
        ) : (
          <>
            <ThreadHeader threadId={threadId} title={current?.title} scope={current?.scope ?? null} archived={current?.archivedAt != null}
              onArchived={() => {
                say('Thread archived');
                router.push('/ask/threads/' as never);
              }} />
            <ThreadView key={threadId} threadId={threadId} />
          </>
        )}
      </section>
    </div>
  );
}

function ThreadHeader({ threadId, title, scope, archived, onArchived }: { threadId: string; title: string | undefined; scope: Scope; archived: boolean; onArchived: () => void }) {
  const rename = useMutation('renameAskThread');
  const rescope = useMutation('scopeAskThread');
  const archive = useMutation('archiveAskThread');
  const [renaming, setRenaming] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const [name, setName] = useState(title ?? '');
  useEffect(() => setName(title ?? ''), [title]);
  return (
    <header className={styles.threadHead}>
      <div className={styles.threadHeadText}>
        <h2 className={styles.threadHeading}>{title ?? 'Thread'}</h2>
        <span className={styles.muted}>Scoped to: {scopeText(scope)} {archived ? <Badge>Archived</Badge> : null}</span>
      </div>
      <Menu label="Thread actions" items={[
        { label: 'Rename', icon: 'edit', onSelect: () => setRenaming(true), blocked: rename.blocked },
        { label: 'Ask about everything', icon: 'globe', description: 'Remove the scope; widening is recorded on the thread', disabled: scope === null,
          blocked: rescope.blocked, onSelect: () => void rescope.run({ params: { threadId }, body: { scope: null } }) },
        { separator: true },
        { label: 'Archive', icon: 'trash', tone: 'danger', disabled: archived, blocked: archive.blocked, onSelect: () => setArchiving(true) },
      ]} renderTrigger={(props) => <IconButton {...props} label="Thread actions" icon="more" />} />
      <Dialog open={renaming} onClose={() => setRenaming(false)} title="Rename the thread" size="sm" busy={rename.pending}>
        <form onSubmit={(e) => {
          e.preventDefault();
          void rename.run({ params: { threadId }, body: { title: name.trim() } }).then((r) => r.ok && setRenaming(false));
        }}>
          <TextField label="Name" required maxLength={200} value={name} onChange={(e) => setName(e.target.value)} autoFocus />
          {rename.error !== undefined ? <ErrorMessage error={rename.error} /> : null}
          <FormActions>
            <Button onClick={() => setRenaming(false)}>Cancel</Button>
            <Button type="submit" variant="primary" pending={rename.pending} disabled={name.trim() === ''}>Rename</Button>
          </FormActions>
        </form>
      </Dialog>
      {rescope.error !== undefined ? <ErrorMessage error={rescope.error} /> : null}
      <ConfirmDialog open={archiving} onClose={() => setArchiving(false)} title="Archive this thread?" confirmLabel="Archive"
        onConfirm={async () => {
          const outcome = await archive.run({ params: { threadId } });
          if (outcome.ok) onArchived();
          return outcome;
        }}>
        <p>It moves to your archived threads and takes no new question. Its turns are kept.</p>
      </ConfirmDialog>
    </header>
  );
}
