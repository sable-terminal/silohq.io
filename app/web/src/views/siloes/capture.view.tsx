'use client';

// Capture Silos (spec 67): the history of the properties an organisation chooses, kept as each
// change is observed, so timelines, history detectors, process mining and observed lead times have
// something to read. Types and properties are added, changed and dropped; the Action ledger (every
// change made through Silo, with references or with values) is kept here on request, its
// disclosure acknowledged; and the ledger is read, values withheld from whoever may not see them.

import Link from 'next/link';
import { useState } from 'react';
import type { Output } from '../../api/client.api.ts';
import { Badge } from '../../components/badge.component.tsx';
import { Banner } from '../../components/banner.component.tsx';
import { Button, IconButton, LinkButton } from '../../components/button.component.tsx';
import { ConfirmDialog, Dialog } from '../../components/dialog.component.tsx';
import { Checkbox, FormActions, RadioGroup, SelectField } from '../../components/field.component.tsx';
import { Menu } from '../../components/menu.component.tsx';
import { Page, Section } from '../../components/page.component.tsx';
import { PagesView } from '../../components/query.component.tsx';
import { EmptyState, ErrorMessage } from '../../components/states.component.tsx';
import { DataTable } from '../../components/table.component.tsx';
import { Time } from '../../components/time.component.tsx';
import { useToast } from '../../components/toast.component.tsx';
import { useMutation, usePages } from '../../data/query.data.ts';
import { useDirectory } from '../../hooks/directory.hook.ts';
import { useVocabulary } from '../../hooks/vocabulary.hook.ts';
import { objectHref } from '../../navigation/links.navigation.ts';
import { usePageContext } from '../../shell/context.shell.tsx';
import { humanise, plural } from '../../utils/format.util.ts';
import { useSiloChoice } from './overview.view.tsx';
import type { Silo } from './words.view.ts';
import styles from './siloes.view.module.css';

type Mode = 'off' | 'references' | 'values';
const MODES = [
  { value: 'off' as const, label: 'Off', hint: 'The ledger is not kept here' },
  { value: 'references' as const, label: 'References only', hint: 'What changed, by whom and when, without the values' },
  { value: 'values' as const, label: 'With values', hint: 'Each change with the values before and after' },
];

export function Capture() {
  const { silo, picker, none } = useSiloChoice('capture');
  usePageContext({ scope: { kind: 'page', page: 'siloes' }, scopeLabel: 'Capture' });
  return (
    <Page title="Capture" description="The change history of the properties you choose: what timelines, history detectors, process mining and observed lead times read."
      crumbs={[{ label: 'Siloes', href: '/siloes/overview/' }]}>
      <div className={styles.stack}>
        {picker}
        {none ? <EmptyState icon="clock" title="No Capture Silo" action={<LinkButton href="/siloes/overview/?new=1" variant="primary">New Silo</LinkButton>}>Make a Capture Silo to keep the history of chosen properties.</EmptyState> : null}
        {silo !== undefined ? <CaptureSilo key={silo.id} silo={silo} /> : null}
      </div>
    </Page>
  );
}

function CaptureSilo({ silo }: { silo: Silo }) {
  const say = useToast();
  const { lookup } = useVocabulary();
  const remove = useMutation('removeCaptureType', { invalidates: ['listSiloes', 'getSilo'] });
  const [dialog, setDialog] = useState<{ kind: 'add' } | { kind: 'change' | 'remove'; objectTypeId: string; properties: string[] } | { kind: 'ledger' } | undefined>();
  return (
    <div className={styles.stack}>
      <p className={styles.muted}>{silo.disclosure}</p>
      <Section title="What it keeps history of" actions={<Button size="sm" icon="plus" onClick={() => setDialog({ kind: 'add' })}>Add a type</Button>}>
        {silo.objectTypes.length === 0 ? <p className={styles.muted}>Nothing yet: add a type and the properties whose changes to keep.</p> : (
          <DataTable label="Types kept" rows={silo.objectTypes} rowKey={(t) => t.objectTypeId} columns={[
            { id: 'type', header: 'Type', primary: true, cell: (t) => lookup?.typeName(t.objectTypeId, true) ?? '…' },
            { id: 'properties', header: 'Properties', cell: (t) => t.properties.map((p) => lookup?.types.get(t.objectTypeId)?.properties.find((x) => x.apiName === p)?.displayName ?? p).join(', ') },
            { id: 'since', header: 'Since', width: 'sm', cell: (t) => <Time value={t.addedAt} /> },
            { id: 'act', header: <span className="visually-hidden">Act</span>, align: 'end', cell: (t) => (
              <Menu label={lookup?.typeName(t.objectTypeId) ?? 'Type'} items={[
                { label: 'Change its properties', icon: 'edit', onSelect: () => setDialog({ kind: 'change', objectTypeId: t.objectTypeId, properties: t.properties }) },
                { label: 'Stop keeping its history', icon: 'trash', tone: 'danger', blocked: remove.blocked, onSelect: () => setDialog({ kind: 'remove', objectTypeId: t.objectTypeId, properties: t.properties }) },
              ]} renderTrigger={(p) => <IconButton {...p} size="sm" label="Type actions" icon="more" />} />
            ) },
          ]} />
        )}
      </Section>
      <Section title="Action ledger" description="Every change made through Silo, kept in this Silo as it is executed."
        actions={<Button size="sm" onClick={() => setDialog({ kind: 'ledger' })}>Change</Button>}>
        <p className={styles.row}><Badge tone={silo.actionLedger === 'off' ? 'neutral' : 'info'}>{MODES.find((m) => m.value === silo.actionLedger)?.label}</Badge><span className={styles.muted}>{MODES.find((m) => m.value === silo.actionLedger)?.hint}</span></p>
        {silo.actionLedger !== 'off' ? <Ledger siloId={silo.id} /> : null}
      </Section>
      {dialog?.kind === 'add' ? <TypeDialog silo={silo} onClose={() => setDialog(undefined)} /> : null}
      {dialog?.kind === 'change' ? <TypeDialog silo={silo} objectTypeId={dialog.objectTypeId} properties={dialog.properties} onClose={() => setDialog(undefined)} /> : null}
      {dialog?.kind === 'ledger' ? <LedgerDialog silo={silo} onClose={() => setDialog(undefined)} /> : null}
      <ConfirmDialog open={dialog?.kind === 'remove'} onClose={() => setDialog(undefined)} title="Stop keeping its history?" confirmLabel="Stop" tone="danger"
        onConfirm={() => (dialog?.kind === 'remove' ? remove.run({ params: { siloId: silo.id, objectTypeId: dialog.objectTypeId } }).then((r) => {
          if (r.ok) say('No more of its history is kept');
          return r;
        }) : Promise.resolve({ ok: true }))}>
        <p>No new change is kept. What is kept already stays until its retention ends or it is purged.</p>
      </ConfirmDialog>
    </div>
  );
}

function TypeDialog({ silo, objectTypeId, properties, onClose }: { silo: Silo; objectTypeId?: string; properties?: string[]; onClose: () => void }) {
  const say = useToast();
  const { data: vocabulary } = useVocabulary();
  const add = useMutation('addCaptureType', { invalidates: ['listSiloes', 'getSilo'] });
  const change = useMutation('changeCaptureProperties', { invalidates: ['listSiloes', 'getSilo'] });
  const [typeId, setTypeId] = useState(objectTypeId ?? '');
  const [chosen, setChosen] = useState<string[]>(properties ?? []);
  const type = vocabulary?.objectTypes.find((t) => t.id === typeId);
  const editing = objectTypeId !== undefined;
  const pending = add.pending || change.pending;
  return (
    <Dialog open onClose={onClose} title={editing ? `What to keep of ${type?.pluralName ?? 'the type'}` : 'Add a type'} size="md" busy={pending}>
      <form className={styles.form} onSubmit={async (e) => {
        e.preventDefault();
        const r = editing ? await change.run({ params: { siloId: silo.id, objectTypeId: typeId }, body: { properties: chosen } })
          : await add.run({ params: { siloId: silo.id }, body: { objectTypeId: typeId, properties: chosen } });
        if (r.ok) {
          say(editing ? 'Changed: from now on these changes are kept' : 'Added: its changes are kept from now on');
          onClose();
        }
      }}>
        {!editing ? (
          <SelectField label="Type" required value={typeId} placeholder="Choose a type" onChange={(e) => {
            setTypeId(e.target.value);
            setChosen([]);
          }} options={(vocabulary?.objectTypes ?? []).filter((t) => !silo.objectTypes.some((x) => x.objectTypeId === t.id)).map((t) => ({ value: t.id, label: t.pluralName }))} />
        ) : null}
        {type !== undefined ? (
          <fieldset className={styles.fieldset}>
            <legend>Properties whose changes are kept</legend>
            <div className={styles.checks}>{type.properties.map((p) => (
              <Checkbox key={p.identityId} label={p.displayName} checked={chosen.includes(p.apiName)}
                onChange={(e) => setChosen(e.target.checked ? [...chosen, p.apiName] : chosen.filter((x) => x !== p.apiName))} />
            ))}</div>
          </fieldset>
        ) : null}
        {add.error !== undefined ? <ErrorMessage error={add.error} /> : null}
        {change.error !== undefined ? <ErrorMessage error={change.error} /> : null}
        <FormActions>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" pending={pending} disabled={typeId === '' || chosen.length === 0}>{editing ? 'Save' : 'Keep their history'}</Button>
        </FormActions>
      </form>
    </Dialog>
  );
}

function LedgerDialog({ silo, onClose }: { silo: Silo; onClose: () => void }) {
  const say = useToast();
  const set = useMutation('setCaptureActionLedger', { invalidates: ['listSiloes', 'getSilo'] });
  const [mode, setMode] = useState<Mode>(silo.actionLedger);
  const [disclosure, setDisclosure] = useState<string | undefined>();
  const [acknowledged, setAcknowledged] = useState(false);
  return (
    <Dialog open onClose={onClose} title="The Action ledger" size="md" busy={set.pending}>
      <form className={styles.form} onSubmit={async (e) => {
        e.preventDefault();
        const r = await set.run({ params: { siloId: silo.id }, body: { mode, ...(mode === 'values' ? { disclosureAcknowledged: acknowledged } : {}) } });
        if (r.ok) {
          setDisclosure(r.data.disclosure);
          say(mode === 'off' ? 'The ledger is not kept here now' : 'The ledger is kept here from now on');
          onClose();
        }
      }}>
        <RadioGroup label="Keep it" name="ledger" value={mode} onChange={(v) => setMode(v as Mode)} options={MODES} />
        {mode === 'values' ? (
          <Banner tone="warn" title="Values are kept">
            <div className={styles.stackTight}>
              <span>The values before and after each change are copied into this Silo, with its retention and markings; people who may not see a value are not shown it.</span>
              <Checkbox label="I understand values are kept here" checked={acknowledged} onChange={(e) => setAcknowledged(e.target.checked)} />
            </div>
          </Banner>
        ) : null}
        {disclosure !== undefined ? <p className={styles.muted}>{disclosure}</p> : null}
        {set.error !== undefined ? <ErrorMessage error={set.error} /> : null}
        <FormActions>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" pending={set.pending} blocked={set.blocked} disabled={mode === 'values' && !acknowledged}>Save</Button>
        </FormActions>
      </form>
    </Dialog>
  );
}

type Row = Output<'listCaptureLedger'>['rows'][number];

function Ledger({ siloId }: { siloId: string }) {
  const people = useDirectory();
  const { lookup } = useVocabulary();
  const [open, setOpen] = useState<Row | undefined>();
  const pages = usePages('listCaptureLedger', (cursor) => ({ params: { siloId }, query: { ...(cursor === undefined ? {} : { cursor }) } }), (p) => p.next, [siloId]);
  const withheld = pages.pages.reduce((n, p) => n + p.withheld, 0);
  return (
    <div className={styles.stackTight}>
      <PagesView pages={pages} what="The ledger" isEmpty={(all) => all.flatMap((p) => p.rows).length === 0} empty={<p className={styles.muted}>No change recorded yet.</p>}>
        {(all) => (
          <DataTable label="Action ledger" rows={all.flatMap((p) => p.rows)} rowKey={(r) => r.ledgerId} columns={[
            { id: 'when', header: 'Executed', primary: true, cell: (r) => <Time value={r.executedAt} exact /> },
            { id: 'action', header: 'Action', cell: (r) => (r.genericEdit ? 'An edit' : r.actionType) },
            { id: 'object', header: 'Object', cell: (r) => {
              // The ledger names a type by its API name.
              const type = [...(lookup?.types.values() ?? [])].find((t) => t.apiName === r.objectType);
              return type === undefined ? `${r.objectType} ${r.objectId.slice(0, 8)}` : <Link href={objectHref({ objectTypeId: type.id, objectId: r.objectId }) as never}>{type.displayName} {r.objectId.slice(0, 8)}</Link>;
            } },
            { id: 'what', header: 'Changed', cell: (r) => `${humanise(r.operation)}${r.fields.length > 0 ? `: ${r.fields.join(', ')}` : ''}` },
            { id: 'by', header: 'By', cell: (r) => (r.proposer === null ? 'A service' : people.nameOf(r.proposer)) },
            { id: 'outcome', header: 'Outcome', width: 'sm', cell: (r) => <Badge tone={r.outcome === 'verified' ? 'ok' : r.outcome === 'diverged' ? 'warn' : 'danger'}>{humanise(r.outcome)}</Badge> },
            { id: 'open', header: <span className="visually-hidden">Open</span>, align: 'end', cell: (r) => <Button size="sm" variant="ghost" onClick={() => setOpen(r)}>Details</Button> },
          ]} />
        )}
      </PagesView>
      {withheld > 0 ? <p className={styles.muted}>{plural(withheld, 'row')} withheld: you may not see their objects.</p> : null}
      <Dialog open={open !== undefined} onClose={() => setOpen(undefined)} drawer title="Ledger entry">
        {open !== undefined ? (
          <div className={styles.stackTight}>
            <span>{open.origin === 'revert' ? 'A revert' : 'An Action'}, {open.riskClass} risk{open.selfApproved ? ', approved by its proposer' : ''}; approved by {open.approvers.map((a) => people.nameOf(a)).join(', ') || 'no one else'}.</span>
            {open.valuesClearedAt !== null ? <p className={styles.muted}>Its values were cleared <Time value={open.valuesClearedAt} />.</p> : null}
            {open.priorValues !== null ? <><strong>Before</strong><pre className={styles.code}>{JSON.stringify(open.priorValues, null, 2)}</pre></> : null}
            {open.newValues !== null ? <><strong>After</strong><pre className={styles.code}>{JSON.stringify(open.newValues, null, 2)}</pre></> : null}
          </div>
        ) : null}
      </Dialog>
    </div>
  );
}
