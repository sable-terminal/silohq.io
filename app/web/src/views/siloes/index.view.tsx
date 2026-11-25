'use client';

// The Object Index (spec 69): a searchable copy of the properties chosen for each type, and
// nothing else of it, refreshed on a schedule (and from the change stream where a type's
// connection offers one), each refresh saying what it wrote and removed. Types are added, their
// properties changed, dropped, and rebuilt from their systems.

import { useState } from 'react';
import type { Output } from '../../api/client.api.ts';
import { Badge } from '../../components/badge.component.tsx';
import { Button, IconButton, LinkButton } from '../../components/button.component.tsx';
import { ConfirmDialog, Dialog } from '../../components/dialog.component.tsx';
import { Checkbox, FormActions, SelectField, TextField } from '../../components/field.component.tsx';
import { Menu } from '../../components/menu.component.tsx';
import { Page, Section } from '../../components/page.component.tsx';
import { QueryView } from '../../components/query.component.tsx';
import { EmptyState, ErrorMessage } from '../../components/states.component.tsx';
import { DataTable } from '../../components/table.component.tsx';
import { Time } from '../../components/time.component.tsx';
import { useToast } from '../../components/toast.component.tsx';
import { useMutation, useQuery } from '../../data/query.data.ts';
import { useVocabulary } from '../../hooks/vocabulary.hook.ts';
import { usePageContext } from '../../shell/context.shell.tsx';
import { formatNumber, humanise } from '../../utils/format.util.ts';
import { useSiloChoice } from './overview.view.tsx';
import type { Silo } from './words.view.ts';
import styles from './siloes.view.module.css';

type Definition = Output<'getObjectIndex'>['definitions'][number];
const SCHEDULES = [
  { value: '0 * * * *', label: 'Every hour' }, { value: '0 */6 * * *', label: 'Every six hours' }, { value: '0 2 * * *', label: 'Every night at 02:00' }, { value: '0 2 * * 0', label: 'Sundays at 02:00' },
];

export function ObjectIndex() {
  const { silo, picker, none } = useSiloChoice('object_index');
  usePageContext({ scope: { kind: 'page', page: 'siloes' }, scopeLabel: 'Object Index' });
  return (
    <Page title="Object Index" description="A searchable copy of the properties you choose, and nothing else, refreshed on a schedule." crumbs={[{ label: 'Siloes', href: '/siloes/overview/' }]}>
      <div className={styles.stack}>
        {picker}
        {none ? <EmptyState icon="search" title="No Object Index" action={<LinkButton href="/siloes/overview/?new=1" variant="primary">New Silo</LinkButton>}>Make an Object Index Silo to search chosen properties.</EmptyState> : null}
        {silo !== undefined ? <IndexSilo key={silo.id} silo={silo} /> : null}
      </div>
    </Page>
  );
}

function IndexSilo({ silo }: { silo: Silo }) {
  const say = useToast();
  const { lookup } = useVocabulary();
  const index = useQuery('getObjectIndex', { params: { siloId: silo.id } }, { refreshMs: 30_000 });
  const remove = useMutation('removeIndexType', { invalidates: ['getObjectIndex', 'listSiloes'] });
  const rebuild = useMutation('rebuildIndexType', { invalidates: ['getObjectIndex'] });
  const [dialog, setDialog] = useState<{ kind: 'add' } | { kind: 'change' | 'remove'; definition: Definition } | undefined>();
  return (
    <QueryView query={index} what="The index">
      {(ix) => (
        <div className={styles.stack}>
          <p className={styles.muted}>{ix.purpose} Kept in {ix.location}, dataset <span className={styles.mono}>{ix.dataset}</span>.</p>
          <Section title="Types it holds" actions={<Button size="sm" icon="plus" onClick={() => setDialog({ kind: 'add' })}>Add a type</Button>}>
            {ix.definitions.filter((d) => d.removedAt === null).length === 0 ? <p className={styles.muted}>Nothing yet: add a type and the properties to search by.</p> : (
              <DataTable label="Types indexed" rows={ix.definitions.filter((d) => d.removedAt === null)} rowKey={(d) => d.id} columns={[
                { id: 'type', header: 'Type', primary: true, cell: (d) => lookup?.typeName(d.objectTypeId, true) ?? '…' },
                { id: 'properties', header: 'Properties', cell: (d) => d.properties.join(', ') },
                { id: 'schedule', header: 'Refreshed', cell: (d) => `${SCHEDULES.find((x) => x.value === d.refreshSchedule)?.label ?? d.refreshSchedule}${d.usesChangeStream ? ', and as changes arrive' : ''}` },
                { id: 'last', header: 'Last refresh', cell: (d) => (d.lastRefresh === null ? 'Not yet' : (
                  <span className={styles.row}>
                    <Badge tone={d.lastRefresh.status === 'completed' ? 'ok' : d.lastRefresh.status === 'running' ? 'info' : 'danger'}>{humanise(d.lastRefresh.status)}</Badge>
                    <span className={styles.muted}>{formatNumber(d.lastRefresh.objectsWritten)} written, {formatNumber(d.lastRefresh.objectsRemoved)} removed{d.lastRefresh.errorStage !== null ? `; stopped at ${humanise(d.lastRefresh.errorStage).toLowerCase()}` : ''}</span>
                  </span>
                )) },
                { id: 'next', header: 'Next', width: 'sm', cell: (d) => (d.nextRefreshAt === null ? '—' : <Time value={d.nextRefreshAt} />) },
                { id: 'act', header: <span className="visually-hidden">Act</span>, align: 'end', cell: (d) => (
                  <Menu label="Type actions" items={[
                    { label: 'Rebuild it now', icon: 'refresh', blocked: rebuild.blocked, onSelect: () => void rebuild.run({ params: { siloId: silo.id, definitionId: d.id } }).then((r) => r.ok && say('Rebuilding from its systems')) },
                    { label: 'Change its properties', icon: 'edit', onSelect: () => setDialog({ kind: 'change', definition: d }) },
                    { label: 'Stop indexing it', icon: 'trash', tone: 'danger', blocked: remove.blocked, onSelect: () => setDialog({ kind: 'remove', definition: d }) },
                  ]} renderTrigger={(p) => <IconButton {...p} size="sm" label="Type actions" icon="more" />} />
                ) },
              ]} />
            )}
            {rebuild.error !== undefined ? <ErrorMessage error={rebuild.error} /> : null}
          </Section>
          {dialog?.kind === 'add' ? <IndexTypeDialog siloId={silo.id} held={ix.definitions.filter((d) => d.removedAt === null).map((d) => d.objectTypeId)} onClose={() => setDialog(undefined)} /> : null}
          {dialog?.kind === 'change' ? <IndexTypeDialog siloId={silo.id} definition={dialog.definition} held={[]} onClose={() => setDialog(undefined)} /> : null}
          <ConfirmDialog open={dialog?.kind === 'remove'} onClose={() => setDialog(undefined)} title="Stop indexing it?" confirmLabel="Stop" tone="danger"
            onConfirm={() => (dialog?.kind === 'remove' ? remove.run({ params: { siloId: silo.id, definitionId: dialog.definition.id } }).then((r) => {
              if (r.ok) say('Its entries are removed from the index');
              return r;
            }) : Promise.resolve({ ok: true }))}>
            <p>Its entries are removed from the index, and search stops finding them there.</p>
          </ConfirmDialog>
        </div>
      )}
    </QueryView>
  );
}

function IndexTypeDialog({ siloId, definition, held, onClose }: { siloId: string; definition?: Definition; held: string[]; onClose: () => void }) {
  const say = useToast();
  const { data: vocabulary } = useVocabulary();
  const add = useMutation('addIndexType', { invalidates: ['getObjectIndex', 'listSiloes'] });
  const change = useMutation('changeIndexProperties', { invalidates: ['getObjectIndex'] });
  const [typeId, setTypeId] = useState(definition?.objectTypeId ?? '');
  const [chosen, setChosen] = useState<string[]>(definition?.properties ?? []);
  const [schedule, setSchedule] = useState('0 2 * * *');
  const [stream, setStream] = useState(false);
  const type = vocabulary?.objectTypes.find((t) => t.id === typeId);
  const pending = add.pending || change.pending;
  return (
    <Dialog open onClose={onClose} title={definition === undefined ? 'Index a type' : `What to index of ${type?.pluralName ?? 'the type'}`} size="md" busy={pending}>
      <form className={styles.form} onSubmit={async (e) => {
        e.preventDefault();
        const r = definition === undefined
          ? await add.run({ params: { siloId }, body: { objectTypeId: typeId, properties: chosen, refreshSchedule: schedule, usesChangeStream: stream } })
          : await change.run({ params: { siloId, definitionId: definition.id }, body: { properties: chosen } });
        if (r.ok) {
          say(definition === undefined ? 'Added: it is built now' : 'Changed: it is rebuilt');
          onClose();
        }
      }}>
        {definition === undefined ? (
          <SelectField label="Type" required value={typeId} placeholder="Choose a type" onChange={(e) => {
            setTypeId(e.target.value);
            setChosen([]);
          }} options={(vocabulary?.objectTypes ?? []).filter((t) => !held.includes(t.id)).map((t) => ({ value: t.id, label: t.pluralName }))} />
        ) : null}
        {type !== undefined ? (
          <fieldset className={styles.fieldset}>
            <legend>Properties it holds</legend>
            <div className={styles.checks}>{type.properties.map((p) => (
              <Checkbox key={p.identityId} label={p.displayName} checked={chosen.includes(p.apiName)} onChange={(e) => setChosen(e.target.checked ? [...chosen, p.apiName] : chosen.filter((x) => x !== p.apiName))} />
            ))}</div>
          </fieldset>
        ) : null}
        {definition === undefined ? (
          <div className={styles.fields}>
            <SelectField label="Refresh" value={SCHEDULES.some((x) => x.value === schedule) ? schedule : ''} placeholder="Custom" onChange={(e) => {
              if (e.target.value !== '') setSchedule(e.target.value);
            }} options={SCHEDULES} />
            <TextField label="Schedule" className={styles.mono} value={schedule} onChange={(e) => setSchedule(e.target.value)} hint="Five fields, in your organisation's time zone." />
            <Checkbox label="Also as changes arrive, where its system streams them" checked={stream} onChange={(e) => setStream(e.target.checked)} />
          </div>
        ) : null}
        {add.error !== undefined ? <ErrorMessage error={add.error} /> : null}
        {change.error !== undefined ? <ErrorMessage error={change.error} /> : null}
        <FormActions>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" pending={pending} disabled={typeId === '' || chosen.length === 0}>{definition === undefined ? 'Index it' : 'Save'}</Button>
        </FormActions>
      </form>
    </Dialog>
  );
}
