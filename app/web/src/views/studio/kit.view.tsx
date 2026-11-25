'use client';

// What every kind of thing in Studio shares (spec 35; D232–D240): a directory of a person's own,
// those shared with them and those archived; naming, copying and archiving; and shares, where one
// a later, stricter sharing policy forbids, or one suspended when its owner left, is listed with
// why rather than hidden, so its owner sees what it grants now.

import { useEffect, useState, type ReactNode } from 'react';
import { Button, LinkButton } from '../../components/button.component.tsx';
import { Dialog } from '../../components/dialog.component.tsx';
import { FormActions, TextField } from '../../components/field.component.tsx';
import type { IconName } from '../../components/icon.component.tsx';
import { Page } from '../../components/page.component.tsx';
import { QueryView } from '../../components/query.component.tsx';
import { EmptyState, ErrorMessage } from '../../components/states.component.tsx';
import { DataTable, type Column } from '../../components/table.component.tsx';
import { type TabDef, TabPanel, Tabs } from '../../components/tabs.component.tsx';
import { Time } from '../../components/time.component.tsx';
import type { Blocked, QueryResult } from '../../data/query.data.ts';
import { useParams } from '../../hooks/params.hook.ts';
import styles from './studio.view.module.css';

export type Filter = 'mine' | 'shared' | 'archived';

export const FILTERS: readonly TabDef<Filter>[] = [
  { id: 'mine', label: 'Yours' }, { id: 'shared', label: 'Shared with you' }, { id: 'archived', label: 'Archived' },
];

/** What the person holds on a thing, in words. */
export const HELD: Record<string, string> = {
  owner: 'Yours', edit: 'Shared with you to edit', copy: 'Shared with you to copy', run: 'Shared with you to use', view: 'Shared with you to open',
  published: 'Published to your team',
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** An id from the address: a mistyped or truncated one names nothing, and is never sent. */
export const idFrom = (value: string | null): string | undefined => (value !== null && UUID.test(value) ? value : undefined);

/** A name for something new, a copy or a rename. */
export function NameDialog({ open, title, initial, action, pending, error, onClose, onSave, hint }: {
  open: boolean; title: string; initial: string; action: string; pending: boolean; error: unknown; onClose: () => void; onSave: (name: string) => void;
  hint?: string | undefined;
}) {
  const [name, setName] = useState(initial);
  return (
    <Dialog open={open} onClose={onClose} title={title} size="sm" busy={pending}>
      <form className={styles.form} onSubmit={(e) => {
        e.preventDefault();
        if (name.trim() !== '') onSave(name.trim());
      }}>
        <TextField label="Name" required maxLength={200} value={name} onChange={(e) => setName(e.target.value)} hint={hint} data-autofocus />
        {error !== undefined ? <ErrorMessage error={error} /> : null}
        <FormActions>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" pending={pending} disabled={name.trim() === ''}>{action}</Button>
        </FormActions>
      </form>
    </Dialog>
  );
}

export { sharesFor } from '../../components/share.component.tsx';

/** Share access levels of the documents (workbooks, reports, notebooks, processes, AI agents, models). */
export const DOCUMENT_ACCESS = [
  { value: 'view' as const, label: 'Open it', hint: 'Read it, with its live parts read as them' },
  { value: 'copy' as const, label: 'Copy it', hint: 'Open it and make their own copy' },
];

/**
 * A document being edited: taken from the cell while nothing is changed here. Lock versions only
 * move forward, so a read older than the last save never overwrites it; a newer save made
 * elsewhere while there are edits here is reported as stale, never merged over them.
 */
export function useDraft<D>(server: { lockVersion: number; document: D } | undefined) {
  const [doc, setDoc] = useState<D | undefined>();
  const [base, setBase] = useState<number | undefined>();
  const [edited, setEdited] = useState(false);
  useEffect(() => {
    if (server === undefined || edited) return;
    if (base !== undefined && server.lockVersion <= base) return;
    setDoc(server.document);
    setBase(server.lockVersion);
  }, [server, edited, base]);
  return {
    doc,
    edited,
    /** The lock version a save sends. */
    lockVersion: base ?? server?.lockVersion ?? 0,
    stale: edited && server !== undefined && base !== undefined && server.lockVersion > base,
    change: (next: D) => {
      setDoc(next);
      setEdited(true);
    },
    saved: (s: { lockVersion: number; document: D }) => {
      setDoc(s.document);
      setBase(s.lockVersion);
      setEdited(false);
    },
  };
}

interface Row { id: string; name: string; access: string; updatedAt: string }

/** A Studio kind's directory: Yours, Shared with you and Archived; a row opens the thing; New asks for a name. */
export function Directory<T, R extends Row>({ title, description, what, icon, filter, onFilter, query, rows, hrefOf, onCreate, createBlocked, createPending, createError, columns, emptyMine, renderNew }: {
  title: string; description: string;
  /** The thing, singular and lower case: "workbook". */
  what: string;
  icon: IconName;
  filter: Filter; onFilter: (f: Filter) => void;
  query: QueryResult<T>; rows: (data: T) => readonly R[];
  hrefOf: (id: string) => string;
  onCreate?: ((name: string) => void) | undefined;
  createBlocked: Blocked | undefined; createPending?: boolean; createError?: unknown;
  /** A kind that needs more than a name to be made shows its own dialog. */
  renderNew?: ((close: () => void) => ReactNode) | undefined;
  /** Columns between the name and who holds it. */
  columns?: readonly Column<R>[];
  emptyMine: ReactNode;
}) {
  const [params, set] = useParams();
  return (
    <Page title={title} description={description} crumbs={[{ label: 'Studio' }]}
      actions={<Button variant="primary" icon="plus" blocked={createBlocked} onClick={() => set({ new: '1' })}>New {what}</Button>}>
      <Tabs label={`Which ${title.toLowerCase()}`} tabs={FILTERS} current={filter} onChange={onFilter} />
      <TabPanel id={filter}>
        <QueryView query={query} what={title} isEmpty={(d) => rows(d).length === 0}
          empty={<EmptyState icon={icon} title={filter === 'mine' ? `No ${title.toLowerCase()} yet` : 'None here'}>
            {filter === 'mine' ? emptyMine : filter === 'shared' ? `No one has shared a ${what} with you.` : `No archived ${title.toLowerCase()}.`}
          </EmptyState>}>
          {(d) => (
            <DataTable label={title} rows={rows(d)} rowKey={(r) => r.id} rowHref={(r) => hrefOf(r.id)} columns={[
              { id: 'name', header: what.charAt(0).toUpperCase() + what.slice(1), primary: true, cell: (r) => r.name },
              ...(columns ?? []),
              { id: 'held', header: 'Yours or shared', cell: (r) => HELD[r.access] ?? r.access },
              { id: 'updated', header: 'Changed', width: 'sm', sortValue: (r) => r.updatedAt, cell: (r) => <Time value={r.updatedAt} /> },
            ]} />
          )}
        </QueryView>
      </TabPanel>
      {renderNew !== undefined ? (params.get('new') !== null ? renderNew(() => set({ new: undefined })) : null) : (
        <NameDialog open={params.get('new') !== null} title={`New ${what}`} initial="" action={`Make the ${what}`} pending={createPending ?? false} error={createError}
          onClose={() => set({ new: undefined })} onSave={(name) => onCreate?.(name)} />
      )}
    </Page>
  );
}

/** An address that names nothing of its kind. */
export function NotFound({ title, what, icon, href }: { title: string; what: string; icon: IconName; href: string }) {
  return (
    <Page title={title} crumbs={[{ label: 'Studio' }]}>
      <EmptyState icon={icon} title={`This address does not name ${what}`} action={<LinkButton href={href}>All {title.toLowerCase()}</LinkButton>}>Check the link you followed.</EmptyState>
    </Page>
  );
}
