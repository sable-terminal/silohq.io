'use client';

// Object sets (spec 24.4): the sets of objects saved in the ontology, by a definition (a filter
// over a type or interface, a walk along links, chosen objects, or a combination of other sets),
// ready to reuse in apps, Crons and views. Each opens to what it holds now, read as the person
// (D258), and its definition in words. The owner archives a set; nothing that uses it breaks
// silently: its users are told.

import Link from 'next/link';
import type { Output } from '../../api/client.api.ts';
import { Badge } from '../../components/badge.component.tsx';
import { Button } from '../../components/button.component.tsx';
import { ConfirmDialog, Dialog } from '../../components/dialog.component.tsx';
import { Page, Panel, Properties, Section } from '../../components/page.component.tsx';
import { QueryView } from '../../components/query.component.tsx';
import { RefusalNotice } from '../../components/refusal.component.tsx';
import { EmptyState, ErrorMessage, Loading } from '../../components/states.component.tsx';
import { DataTable } from '../../components/table.component.tsx';
import { Time } from '../../components/time.component.tsx';
import { useToast } from '../../components/toast.component.tsx';
import { useMutation, useQuery } from '../../data/query.data.ts';
import { useDirectory } from '../../hooks/directory.hook.ts';
import { useParams } from '../../hooks/params.hook.ts';
import { useVocabulary, type Lookup } from '../../hooks/vocabulary.hook.ts';
import { usePageContext, useWorkspace } from '../../shell/context.shell.tsx';
import { formatNumber, plural } from '../../utils/format.util.ts';
import { hrefWith } from '../../utils/href.util.ts';
import { useState } from 'react';
import { ResultView } from '../../results/result.result.tsx';
import styles from './explorer.view.module.css';

type ObjectSet = Output<'listOntologyObjectSets'>['objectSets'][number];

const KIND: Record<ObjectSet['kind'], string> = { filter: 'Filter', traversal: 'Walk along links', explicit: 'Chosen objects', composite: 'Combination' };

/** A set's definition in words. */
export function definitionText(set: ObjectSet, lookup: Lookup | undefined, names: (id: string) => string): string {
  const d = set.definition;
  switch (d.kind) {
    case 'filter': {
      const base = 'objectTypeId' in d.base ? lookup?.typeName(d.base.objectTypeId, true) ?? 'objects' : `everything that is ${lookup?.interfaces.get(d.base.interfaceId)?.displayName ?? 'an interface'}`;
      return d.predicate.cel.trim() === 'true' ? `Every one of ${base}` : `${base} where ${d.predicate.cel}`;
    }
    case 'traversal': {
      const start = 'objectSetId' in d.start ? `the set ${names(d.start.objectSetId)}` : lookup?.typeName(d.start.objectTypeId, true) ?? 'objects';
      const path = d.path.map((hop) => {
        const link = lookup?.links.get(hop.linkTypeId);
        return link === undefined ? 'a link you cannot see' : hop.direction === 'forward' ? link.forwardName : link.reverseName;
      }).join(', then ');
      return `From ${start}, along ${path}`;
    }
    case 'explicit': return `${plural(d.ids.length, lookup?.typeName(d.objectTypeId) ?? 'object')}, chosen by hand`;
    case 'composite': return `The ${d.operation} of ${d.operands.map(names).join(', ')}`;
  }
}

function SetDetail({ set, onClose, names }: { set: ObjectSet; onClose: () => void; names: (id: string) => string }) {
  const workspace = useWorkspace();
  const say = useToast();
  const people = useDirectory();
  const { lookup } = useVocabulary();
  const run = useQuery('runOntologyObjectSet', { params: { objectSetId: set.id }, body: {} }, { staleMs: 60_000 });
  const archive = useMutation('archiveOntologyObjectSet', { invalidates: ['listOntologyObjectSets'] });
  const [archiving, setArchiving] = useState(false);
  const mine = set.ownerMembershipId === workspace.session.membershipId;
  const outcome = run.data;
  return (
    <Dialog open onClose={onClose} drawer title={set.name} description={set.description ?? undefined}>
      <div className={styles.stack}>
        <Panel>
          <Properties items={[
            ['Kind', KIND[set.kind]],
            ['Definition', <span key="d" className={styles.code}>{definitionText(set, lookup, names)}</span>],
            ['Owner', mine ? 'You' : people.nameOf(set.ownerMembershipId)],
            ['Shared', set.visibility === 'shared' ? 'With the organisation' : 'Private'],
            ['Updated', <Time key="u" value={set.updatedAt} />],
          ]} columns={1} />
        </Panel>
        <Section title="What it holds now" description="Read now, as you: objects you may not see are not counted.">
          {run.status === 'error' ? <ErrorMessage error={run.error} onRetry={run.refetch} /> : outcome === undefined ? <Loading label="Reading the set" block={false} />
            : outcome.outcome === 'refusal' ? <RefusalNotice refusal={outcome.refusal} />
            : (
              <>
                <p className={styles.muted}>{plural(outcome.result.total, 'object')}{outcome.result.reduced ? '; some values are not visible to you' : ''}.</p>
                <ResultView result={outcome.result} label={`${set.name} now`} />
              </>
            )}
        </Section>
        {mine ? (
          <Button variant="ghost" icon="trash" blocked={archive.blocked} onClick={() => setArchiving(true)}>Archive this set</Button>
        ) : null}
        <ConfirmDialog open={archiving} onClose={() => setArchiving(false)} title={`Archive ${set.name}?`} confirmLabel="Archive" tone="danger"
          onConfirm={async () => {
            const r = await archive.run({ params: { objectSetId: set.id } });
            if (r.ok) {
              say('Object set archived');
              onClose();
            }
            return r;
          }}>
          <p>Apps, Crons and views that use it are told it is archived. It can no longer be chosen.</p>
        </ConfirmDialog>
      </div>
    </Dialog>
  );
}

export function ObjectSets() {
  const { lookup } = useVocabulary();
  const people = useDirectory();
  const workspace = useWorkspace();
  const [params, set] = useParams();
  const sets = useQuery('listOntologyObjectSets', { query: { limit: 200 } });
  const openId = params.get('set') ?? undefined;
  const all = sets.data?.objectSets ?? [];
  const names = (id: string) => all.find((s) => s.id === id)?.name ?? 'another set';
  // A set not in the list (shared with you, or past the first page) is read on its own.
  const one = useQuery('readOntologyObjectSet', openId !== undefined && sets.data !== undefined && !all.some((s) => s.id === openId) ? { params: { objectSetId: openId } } : null);
  const open = all.find((s) => s.id === openId) ?? one.data;
  usePageContext({ scope: open === undefined ? { kind: 'page', page: 'explorer' } : { kind: 'object_set', objectSetId: open.id }, scopeLabel: open?.name ?? 'Object sets' });
  return (
    <Page title="Object sets" description="Sets of objects saved by their definition, ready to reuse in apps, Crons and views. Each is read again, as the reader, whenever it is used."
      crumbs={[{ label: 'Explorer', href: '/explorer/types/' }]}
      actions={<Link href="/explorer/types/">Make one in Object types</Link>}>
      <QueryView query={sets} what="Object sets" isEmpty={(d) => d.objectSets.length === 0}
        empty={<EmptyState icon="table" title="No object sets yet" action={<Link href="/explorer/types/">Open Object types</Link>}>
          Narrow a type in Object types, then save it as a set.
        </EmptyState>}>
        {(d) => (
          <DataTable label="Object sets" rows={d.objectSets} rowKey={(s) => s.id} rowHref={(s) => hrefWith('/explorer/sets/', { set: s.id })} columns={[
            { id: 'name', header: 'Set', primary: true, sortValue: (s) => s.name, cell: (s) => s.name },
            { id: 'over', header: 'Over', cell: (s) => (s.baseTypeId !== null ? lookup?.typeName(s.baseTypeId, true) ?? '' : s.baseInterfaceId !== null ? lookup?.interfaces.get(s.baseInterfaceId)?.displayName ?? 'an interface' : '—') },
            { id: 'kind', header: 'Kind', width: 'md', cell: (s) => KIND[s.kind] },
            { id: 'owner', header: 'Owner', width: 'md', cell: (s) => (s.ownerMembershipId === workspace.session.membershipId ? 'You' : people.nameOf(s.ownerMembershipId)) },
            { id: 'shared', header: 'Shared', width: 'sm', cell: (s) => (s.visibility === 'shared' ? <Badge tone="info">Shared</Badge> : <Badge>Private</Badge>) },
            { id: 'updated', header: 'Updated', width: 'sm', sortValue: (s) => s.updatedAt, cell: (s) => <Time value={s.updatedAt} /> },
          ]} />
        )}
      </QueryView>
      {open !== undefined ? <SetDetail key={open.id} set={open} names={names} onClose={() => set({ set: undefined })} /> : null}
      {openId !== undefined && open === undefined && one.status === 'error' ? <p className={styles.muted}>That set is archived, or you may not see it.</p> : null}
      <span className="visually-hidden">{formatNumber(all.length)} sets</span>
    </Page>
  );
}
