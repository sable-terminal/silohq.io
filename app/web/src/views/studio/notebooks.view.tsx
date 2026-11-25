'use client';

// Notebooks (D239, D242): cells over your data, in order. Text; a saved object set's objects; a
// question compiled once into a plan; steps over an earlier table; statistics; a chart; and a
// published model's predictions, joinable to objects by their ids. The owner edits the cells and
// runs them as a draft; whoever opens a notebook runs what was saved, as them, and nothing they
// read is kept. A question's own words are never kept: the cell keeps the owner's label and the
// plan. Exported into Files as a spreadsheet of its tables.

import { useRouter } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';
import type { Output } from '../../api/client.api.ts';
import { Badge } from '../../components/badge.component.tsx';
import { Banner } from '../../components/banner.component.tsx';
import { Button, IconButton } from '../../components/button.component.tsx';
import { ConfirmDialog } from '../../components/dialog.component.tsx';
import { Checkbox, SelectField, TextArea, TextField } from '../../components/field.component.tsx';
import { Menu } from '../../components/menu.component.tsx';
import { Page } from '../../components/page.component.tsx';
import { QueryView } from '../../components/query.component.tsx';
import { ShareDialog } from '../../components/share.component.tsx';
import { ErrorMessage } from '../../components/states.component.tsx';
import { useTab } from '../../components/tabs.component.tsx';
import { Time } from '../../components/time.component.tsx';
import { useToast } from '../../components/toast.component.tsx';
import { useMutation, useQuery } from '../../data/query.data.ts';
import { useParams } from '../../hooks/params.hook.ts';
import { useVocabulary } from '../../hooks/vocabulary.hook.ts';
import { usePageContext } from '../../shell/context.shell.tsx';
import { formatNumber, plural } from '../../utils/format.util.ts';
import { hrefWith } from '../../utils/href.util.ts';
import { Directory, DOCUMENT_ACCESS, FILTERS, HELD, idFrom, NameDialog, NotFound, sharesFor, useDraft } from './kit.view.tsx';
import { blankStep, Steps } from './steps.view.tsx';
import nb from './notebook.view.module.css';
import styles from './studio.view.module.css';

type Notebook = Output<'getNotebook'>;
type Doc = Notebook['document'];
type Cell = Doc['cells'][number];
type CellOut = Output<'runNotebook'>['outputs'][number];
type Option = Extract<Output<'askNotebookQuestion'>, { outcome: 'clarification' }>['options'][number];
type Chart = Extract<NonNullable<CellOut['output']>, { kind: 'chart' }>;
const notebookHref = (id: string) => hrefWith('/studio/notebooks/', { notebook: id });
const newId = () => `cell-${Date.now().toString(36)}${Math.floor(Math.random() * 1000).toString(36)}`;
const KIND_LABEL: Record<Cell['kind'], string> = { text: 'Text', objects: 'Objects', question: 'Question', transform: 'Transform', stats: 'Statistics', chart: 'Chart', predict: 'Predictions' };
const TABLE_NAME = /^[a-z][a-z0-9_]{0,30}$/;

/** Table names made by cells before this one. */
const tablesBefore = (doc: Doc, index: number) => doc.cells.slice(0, index).flatMap((c) => ('name' in c ? [c.name] : []));
function freshName(doc: Doc, stem: string): string {
  let i = 1;
  while (doc.cells.some((c) => 'name' in c && c.name === `${stem}_${i}`)) i++;
  return `${stem}_${i}`;
}

function blankCell(kind: Cell['kind'], doc: Doc, index: number): Cell {
  const last = tablesBefore(doc, index).at(-1) ?? '';
  switch (kind) {
    case 'text': return { id: newId(), kind, text: '' };
    case 'objects': return { id: newId(), kind, name: freshName(doc, 'objects'), objectSetId: '', propertyIds: [], limit: 1000, withIds: false };
    case 'predict': return { id: newId(), kind, name: freshName(doc, 'predicted'), mlModelId: '', objectSetId: null, limit: 500 };
    case 'question': return { id: newId(), kind, name: freshName(doc, 'answer'), label: 'A question', planId: null, bindingId: crypto.randomUUID() };
    case 'transform': return { id: newId(), kind, name: freshName(doc, 'table'), input: last, steps: [blankStep('filter')] };
    case 'stats': return { id: newId(), kind, source: last, columns: [] };
    case 'chart': return { id: newId(), kind, source: last, chart: 'bar', x: '', y: null, bins: 20 };
  }
}

/** /studio/notebooks/: the directory, or a notebook open. */
export function Notebooks() {
  const [params] = useParams();
  const open = params.get('notebook');
  if (open === null) return <NotebookDirectory />;
  const id = idFrom(open);
  return id === undefined ? <NotFound title="Notebooks" what="a notebook" icon="document" href="/studio/notebooks/" /> : <NotebookEditor key={id} notebookId={id} />;
}

function NotebookDirectory() {
  const router = useRouter();
  const [filter, setFilter] = useTab(FILTERS, 'filter');
  const list = useQuery('listNotebooks', { query: { filter } }, { keepPrevious: true });
  const create = useMutation('createNotebook', { invalidates: ['listNotebooks'] });
  usePageContext({ scope: { kind: 'page', page: 'studio' }, scopeLabel: 'Notebooks' });
  return (
    <Directory title="Notebooks" what="notebook" icon="document" description="Analyses written as cells: objects, questions, steps, statistics, charts and predictions, run for whoever opens them."
      filter={filter} onFilter={setFilter} query={list} rows={(d) => d.notebooks} hrefOf={notebookHref}
      createBlocked={create.blocked} createPending={create.pending} createError={create.error}
      onCreate={(name) => void create.run({ body: { name } }).then((r) => r.ok && router.push(notebookHref(r.data.id) as never))}
      emptyMine="A notebook works through your data a cell at a time, and runs for whoever opens it under their own access." />
  );
}

function NotebookEditor({ notebookId }: { notebookId: string }) {
  const router = useRouter();
  const say = useToast();
  const read = useQuery('getNotebook', { params: { notebookId } });
  const save = useMutation('saveNotebook', { invalidates: ['getNotebook', 'listNotebooks'] });
  const run = useMutation('runNotebook', { refresh: false });
  const exportIt = useMutation('exportNotebook');
  const copy = useMutation('copyNotebook', { invalidates: ['listNotebooks'] });
  const archive = useMutation('archiveNotebook', { invalidates: ['listNotebooks', 'getNotebook'] });
  const shares = useQuery('listNotebookShares', read.data?.access === 'owner' ? { params: { notebookId } } : null);
  const share = useMutation('shareNotebook', { invalidates: ['listNotebookShares', 'getNotebook'] });
  const revoke = useMutation('revokeNotebookShare', { invalidates: ['listNotebookShares', 'getNotebook'] });
  const [dialog, setDialog] = useState<'share' | 'copy' | 'archive' | 'rename' | undefined>();
  const [adding, setAdding] = useState<Cell['kind']>('objects');
  const n = read.data;
  const draft = useDraft<Doc>(n);
  usePageContext({ scope: { kind: 'page', page: 'studio' }, scopeLabel: n?.name ?? 'a notebook' });
  // What was saved runs as soon as it is open.
  const loaded = n !== undefined;
  useEffect(() => {
    if (loaded) void run.run({ params: { notebookId }, body: {} });
    // Once, when it is first read.
  }, [loaded, notebookId]);

  if (n === undefined || draft.doc === undefined) {
    return <Page title="Notebook" crumbs={[{ label: 'Studio' }, { label: 'Notebooks', href: '/studio/notebooks/' }]}><QueryView query={read} what="The notebook">{() => null}</QueryView></Page>;
  }
  const doc = draft.doc;
  const owner = n.access === 'owner';
  const archived = n.archivedAt !== null;
  const editable = owner && !archived;
  const setCell = (i: number, c: Cell) => draft.change({ ...doc, cells: doc.cells.map((x, j) => (j === i ? c : x)) });
  const move = (i: number, by: -1 | 1) => {
    const cells = [...doc.cells];
    const [c] = cells.splice(i, 1);
    cells.splice(i + by, 0, c!);
    draft.change({ ...doc, cells });
  };
  const doSave = async (name?: string) => {
    const r = await save.run({ params: { notebookId }, body: { ...(name === undefined ? {} : { name }), document: doc, lockVersion: draft.lockVersion } });
    if (!r.ok) return false;
    draft.saved(r.data);
    say('Saved');
    return true;
  };
  const outputs = run.data?.outputs;
  return (
    <Page title={n.name} documentTitle={n.name} crumbs={[{ label: 'Studio' }, { label: 'Notebooks', href: '/studio/notebooks/' }]}
      description="Run for whoever opens it, under their own access: nothing it reads is kept."
      meta={<span className={styles.row}>
        {archived ? <Badge>Archived</Badge> : null}{!owner ? <Badge tone="info">{HELD[n.access]}</Badge> : null}{draft.edited ? <Badge tone="warn">Unsaved changes</Badge> : null}
        {run.data !== undefined ? <span className={styles.muted}>Computed <Time value={run.data.computedAt} />{draft.edited ? ', perhaps from unsaved cells' : ''}</span> : null}
      </span>}
      actions={
        <div className={styles.row}>
          {editable ? <Button variant="primary" icon="check" pending={save.pending} disabled={!draft.edited} blocked={save.blocked} onClick={() => void doSave()}>Save</Button> : null}
          <Button icon="play" pending={run.pending} blocked={run.blocked} onClick={() => void run.run({ params: { notebookId }, body: draft.edited ? { document: doc } : {} })}>Run</Button>
          {owner ? <Button icon="share" blocked={share.blocked} onClick={() => setDialog('share')}>Share</Button> : null}
          <Menu label="More" items={[
            { label: 'Rename', icon: 'edit', disabled: !editable, onSelect: () => setDialog('rename') },
            { label: 'Make a copy', icon: 'copy', disabled: !(owner || n.access === 'copy'), blocked: copy.blocked, onSelect: () => setDialog('copy') },
            { label: 'Export to Files', icon: 'download', blocked: draft.edited ? 'Save it first' : exportIt.blocked,
              onSelect: () => void exportIt.run({ params: { notebookId }, body: {} }).then((r) => r.ok && say(`Exported into Files as ${r.data.file.name}`)) },
            { separator: true },
            { label: 'Archive', icon: 'trash', tone: 'danger', disabled: !owner || archived, blocked: archive.blocked, onSelect: () => setDialog('archive') },
          ]} renderTrigger={(p) => <IconButton {...p} label="More" icon="more" />} />
        </div>
      }>
      <div className={styles.stack}>
        {archived ? <Banner tone="info" title="Archived">It can be run and exported, not changed.</Banner> : null}
        {draft.stale ? <Banner tone="warn" title="Saved elsewhere since you opened it">Saving now would be refused. Copy what you changed, then open it again.</Banner> : null}
        {save.error !== undefined ? <ErrorMessage error={save.error} /> : null}
        {run.error !== undefined ? <ErrorMessage error={run.error} /> : null}
        {exportIt.error !== undefined ? <ErrorMessage error={exportIt.error} /> : null}
        <ol className={nb.cells}>
          {doc.cells.map((cell, i) => (
            <li key={cell.id} className={nb.cell} aria-label={`Cell ${i + 1}: ${KIND_LABEL[cell.kind]}`}>
              {editable ? (
                <div className={nb.cellBar}>
                  <span className={nb.kind}>{KIND_LABEL[cell.kind]}</span>
                  <IconButton size="sm" icon="chevronUp" label="Move up" disabled={i === 0} onClick={() => move(i, -1)} />
                  <IconButton size="sm" icon="chevronDown" label="Move down" disabled={i === doc.cells.length - 1} onClick={() => move(i, 1)} />
                  <IconButton size="sm" icon="trash" label={`Remove cell ${i + 1}`} onClick={() => draft.change({ ...doc, cells: doc.cells.filter((_, j) => j !== i) })} />
                </div>
              ) : null}
              {editable ? (
                <CellEditor cell={cell} tables={tablesBefore(doc, i)} onChange={(c) => setCell(i, c)}
                  ask={cell.kind === 'question' ? { notebook: n, edited: draft.edited, onAsked: draft.saved } : undefined} />
              ) : <CellReader cell={cell} />}
              <CellResult output={outputs?.find((o) => o.cellId === cell.id)} />
            </li>
          ))}
        </ol>
        {doc.cells.length === 0 ? <p className={styles.muted}>{editable ? 'No cells yet: add one below.' : 'This notebook is empty.'}</p> : null}
        {editable ? (
          <form className={styles.rowEnd} aria-label="Add a cell" onSubmit={(e) => {
            e.preventDefault();
            draft.change({ ...doc, cells: [...doc.cells, blankCell(adding, doc, doc.cells.length)] });
          }}>
            <SelectField label="Cell" value={adding} onChange={(e) => setAdding(e.target.value as Cell['kind'])}
              options={(Object.keys(KIND_LABEL) as Cell['kind'][]).map((k) => ({ value: k, label: KIND_LABEL[k] }))} />
            <Button type="submit" icon="plus">Add the cell</Button>
          </form>
        ) : null}
      </div>
      <ShareDialog open={dialog === 'share'} onClose={() => setDialog(undefined)} title={`Share ${n.name}`} what="this notebook" access={DOCUMENT_ACCESS}
        shares={sharesFor(shares.data?.shares)} shareBlocked={share.blocked} revokeBlocked={revoke.blocked}
        onShare={(grantee, access) => share.run({ params: { notebookId }, body: { grantee, access } })}
        onRevoke={(shareId) => revoke.run({ params: { notebookId, shareId } })} />
      <NameDialog key={`rename:${n.lockVersion}`} open={dialog === 'rename'} title="Rename the notebook" initial={n.name} action="Rename" pending={save.pending} error={save.error}
        hint={draft.edited ? 'Renaming saves your other changes too.' : undefined}
        onClose={() => setDialog(undefined)} onSave={(name) => void doSave(name).then((ok) => ok && setDialog(undefined))} />
      <NameDialog open={dialog === 'copy'} title="Copy the notebook" initial={`${n.name} (copy)`.slice(0, 200)} action="Make the copy" pending={copy.pending} error={copy.error}
        onClose={() => setDialog(undefined)}
        onSave={(name) => void copy.run({ params: { notebookId }, body: { name } }).then((r) => {
          if (!r.ok) return;
          setDialog(undefined);
          router.push(notebookHref(r.data.id) as never);
        })} />
      <ConfirmDialog open={dialog === 'archive'} onClose={() => setDialog(undefined)} title={`Archive ${n.name}?`} confirmLabel="Archive" tone="danger"
        onConfirm={async () => {
          const r = await archive.run({ params: { notebookId } });
          if (r.ok) say('Archived');
          return r;
        }}><p>It stays under Archived; its shares stop granting access.</p></ConfirmDialog>
    </Page>
  );
}

function CellReader({ cell }: { cell: Cell }) {
  if (cell.kind === 'text') return cell.text === '' ? null : <p className={nb.text}>{cell.text}</p>;
  const what = cell.kind === 'question' ? cell.label : cell.kind === 'objects' ? `Objects as ${cell.name}` : cell.kind === 'transform' ? `${cell.name}, from ${cell.input}`
    : cell.kind === 'predict' ? `Predictions as ${cell.name}` : cell.kind === 'stats' ? `Statistics of ${cell.source}` : `A ${cell.chart} chart of ${cell.source}`;
  return <h2 className={styles.subheading}>{what}</h2>;
}

function CellEditor({ cell, tables, onChange, ask }: {
  cell: Cell; tables: string[]; onChange: (c: Cell) => void;
  ask?: { notebook: Notebook; edited: boolean; onAsked: (n: Notebook) => void } | undefined;
}) {
  const nameField = 'name' in cell ? (
    <TextField label="Table name" className={styles.mono} value={cell.name} maxLength={31} onChange={(e) => onChange({ ...cell, name: e.target.value } as Cell)}
      error={TABLE_NAME.test(cell.name) ? undefined : 'Lower-case letters, digits and underscores, starting with a letter'} />
  ) : null;
  const source = (value: string, set: (v: string) => void, label = 'Of') => (
    <SelectField label={label} value={value} placeholder="Choose a table" onChange={(e) => set(e.target.value)} options={tables.map((t) => ({ value: t, label: t }))}
      hint={tables.length === 0 ? 'A cell above must make a table first.' : undefined} />
  );
  switch (cell.kind) {
    case 'text': return <TextArea label="Text" rows={3} value={cell.text} maxLength={20_000} onChange={(e) => onChange({ ...cell, text: e.target.value })} />;
    case 'objects': return <ObjectsCell cell={cell} nameField={nameField} onChange={onChange} />;
    case 'question': return <QuestionEditor cell={cell} nameField={nameField} onChange={onChange} ask={ask!} />;
    case 'predict': return <PredictEditor cell={cell} nameField={nameField} onChange={onChange} />;
    case 'transform':
      return (
        <div className={styles.stackTight}>
          <div className={styles.fields}>{nameField}{source(cell.input, (v) => onChange({ ...cell, input: v }), 'From')}</div>
          <Steps steps={cell.steps} inputs={tables} onChange={(steps) => onChange({ ...cell, steps })} />
        </div>
      );
    case 'stats':
      return (
        <div className={styles.fields}>
          {source(cell.source, (v) => onChange({ ...cell, source: v }))}
          <TextField label="Columns" className={styles.mono} hint="Separated by commas; blank for all." value={cell.columns.join(', ')}
            onChange={(e) => onChange({ ...cell, columns: e.target.value.split(',').map((x) => x.trim()).filter((x) => x !== '') })} />
        </div>
      );
    case 'chart':
      return (
        <div className={styles.fields}>
          {source(cell.source, (v) => onChange({ ...cell, source: v }))}
          <SelectField label="Chart" value={cell.chart} onChange={(e) => onChange({ ...cell, chart: e.target.value as typeof cell.chart })}
            options={[{ value: 'bar', label: 'Bars' }, { value: 'line', label: 'Line' }, { value: 'scatter', label: 'Scatter' }, { value: 'histogram', label: 'Histogram' }]} />
          <TextField label={cell.chart === 'bar' ? 'Category column' : 'X column'} className={styles.mono} value={cell.x} onChange={(e) => onChange({ ...cell, x: e.target.value })} />
          {cell.chart !== 'histogram' ? (
            <TextField label={cell.chart === 'bar' ? 'Summed column (blank: count)' : 'Y column'} className={styles.mono} value={cell.y ?? ''} onChange={(e) => onChange({ ...cell, y: e.target.value === '' ? null : e.target.value })} />
          ) : <TextField label="Bins" type="number" min={2} max={100} value={cell.bins} onChange={(e) => onChange({ ...cell, bins: Math.max(2, Math.min(100, Number(e.target.value) || 20)) })} />}
        </div>
      );
  }
}

function ObjectsCell({ cell, nameField, onChange }: { cell: Extract<Cell, { kind: 'objects' }>; nameField: ReactNode; onChange: (c: Cell) => void }) {
  const { data: vocabulary } = useVocabulary();
  const sets = useQuery('listOntologyObjectSets', { query: {} });
  const type = vocabulary?.objectTypes.find((t) => t.id === sets.data?.objectSets.find((s) => s.id === cell.objectSetId)?.baseTypeId);
  return (
    <div className={styles.stackTight}>
      <div className={styles.fields}>
        {nameField}
        <SelectField label="Object set" value={cell.objectSetId} placeholder={sets.data === undefined ? 'Listing…' : 'Choose a saved set'}
          onChange={(e) => onChange({ ...cell, objectSetId: e.target.value, propertyIds: [] })} options={(sets.data?.objectSets ?? []).map((s) => ({ value: s.id, label: s.name }))} />
        <TextField label="At most" type="number" min={1} max={50_000} value={cell.limit} onChange={(e) => onChange({ ...cell, limit: Math.max(1, Math.min(50_000, Number(e.target.value) || 1)) })} />
      </div>
      <Checkbox label="With each object's id (to join predictions)" checked={cell.withIds} onChange={(e) => onChange({ ...cell, withIds: e.target.checked })} />
      {type !== undefined ? (
        <fieldset className={styles.fieldset}>
          <legend>Columns</legend>
          <div className={styles.checks}>{type.properties.map((p) => (
            <Checkbox key={p.identityId} label={p.displayName} checked={cell.propertyIds.includes(p.identityId)}
              onChange={(e) => onChange({ ...cell, propertyIds: e.target.checked ? [...cell.propertyIds, p.identityId] : cell.propertyIds.filter((x) => x !== p.identityId) })} />
          ))}</div>
        </fieldset>
      ) : null}
    </div>
  );
}

/** A published model's predictions over its own objects or another set of its type. */
function PredictEditor({ cell, nameField, onChange }: { cell: Extract<Cell, { kind: 'predict' }>; nameField: ReactNode; onChange: (c: Cell) => void }) {
  const { data: vocabulary } = useVocabulary();
  const mine = useQuery('listMlModels', { query: { filter: 'mine' } });
  const shared = useQuery('listMlModels', { query: { filter: 'shared' } });
  const sets = useQuery('listOntologyObjectSets', { query: {} });
  const models = [...(mine.data?.mlModels ?? []), ...(shared.data?.mlModels ?? [])].filter((m) => m.publishedVersionId !== null);
  const model = models.find((m) => m.id === cell.mlModelId);
  const type = vocabulary?.objectTypes.find((t) => t.properties.some((p) => p.identityId === model?.labelPropertyId));
  return (
    <div className={styles.fields}>
      {nameField}
      <SelectField label="Model" value={cell.mlModelId} placeholder={mine.data === undefined ? 'Listing…' : 'Choose a published model'}
        onChange={(e) => onChange({ ...cell, mlModelId: e.target.value, objectSetId: null })} options={models.map((m) => ({ value: m.id, label: m.name }))}
        hint={mine.data !== undefined && models.length === 0 ? 'Publish a model version in ML models first.' : undefined} />
      <SelectField label="For" value={cell.objectSetId ?? ''} onChange={(e) => onChange({ ...cell, objectSetId: e.target.value === '' ? null : e.target.value })}
        options={[{ value: '', label: 'The objects it learnt from' }, ...(sets.data?.objectSets ?? []).filter((x) => x.baseTypeId === type?.id && x.id !== model?.objectSetId).map((x) => ({ value: x.id, label: x.name }))]} />
      <TextField label="At most" type="number" min={1} max={5_000} value={cell.limit} onChange={(e) => onChange({ ...cell, limit: Math.max(1, Math.min(5_000, Number(e.target.value) || 1)) })} />
    </div>
  );
}

function QuestionEditor({ cell, nameField, onChange, ask }: {
  cell: Extract<Cell, { kind: 'question' }>; nameField: ReactNode; onChange: (c: Cell) => void;
  ask: { notebook: Notebook; edited: boolean; onAsked: (n: Notebook) => void };
}) {
  const asking = useMutation('askNotebookQuestion', { invalidates: ['getNotebook'] });
  const [question, setQuestion] = useState('');
  const [options, setOptions] = useState<Option[]>([]);
  const [said, setSaid] = useState<string | undefined>();
  const savedCell = ask.notebook.document.cells.some((c) => c.id === cell.id);
  const send = async (chosen?: Option) => {
    setSaid(undefined);
    const r = await asking.run({
      params: { notebookId: ask.notebook.id },
      body: { cellId: cell.id, question, lockVersion: ask.notebook.lockVersion, ...(chosen === undefined ? {} : { chosen: { option: chosen, rejected: options.filter((o) => o.id !== chosen.id) } }) },
    });
    if (!r.ok) return;
    if (r.data.outcome === 'plan') {
      setOptions([]);
      setQuestion('');
      setSaid(`Compiled${r.data.tokensCharged > 0 ? ` (${plural(r.data.tokensCharged, 'token')})` : ''}. Run to see its answer.`);
      ask.onAsked(r.data.notebook);
    } else if (r.data.outcome === 'clarification') setOptions(r.data.options);
    else setSaid(`Not compiled: ${r.data.narrowing ?? r.data.reason.replaceAll('_', ' ')}.`);
  };
  return (
    <div className={styles.stackTight}>
      <div className={styles.fields}>
        {nameField}
        <TextField label="Label" value={cell.label} maxLength={200} onChange={(e) => onChange({ ...cell, label: e.target.value })} hint="What readers see in place of the question." />
      </div>
      <p className={styles.muted}>{cell.planId === null ? 'Not asked yet.' : 'Compiled: it runs the plan for whoever runs the notebook.'} The question&apos;s own words are not kept.</p>
      {!savedCell || ask.edited ? <p className={styles.muted}>Save the notebook to ask this cell&apos;s question.</p> : (
        <form className={styles.rowEnd} aria-label="Ask" onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}>
          <TextArea label="Question" rows={2} maxLength={2000} value={question} onChange={(e) => setQuestion(e.target.value)} />
          <Button type="submit" pending={asking.pending} blocked={asking.blocked} disabled={question.trim() === ''}>Ask</Button>
        </form>
      )}
      {options.length > 0 ? (
        <div className={styles.stackTight}>
          <p>Which did you mean?</p>
          <div className={styles.row}>{options.map((o) => <Button key={o.id} size="sm" onClick={() => void send(o)}>{o.label}</Button>)}</div>
        </div>
      ) : null}
      {said !== undefined ? <p role="status" className={styles.muted}>{said}</p> : null}
      {asking.error !== undefined ? <ErrorMessage error={asking.error} /> : null}
    </div>
  );
}

/** A value as a cell shows it: a number to at most six decimals (the export keeps every digit). */
const cellText = (v: string | number | boolean | null) => (v === null ? '' : typeof v === 'number' ? v.toLocaleString('en-GB', { maximumFractionDigits: 6, useGrouping: false }) : String(v));

function CellResult({ output }: { output: CellOut | undefined }) {
  if (output === undefined) return null;
  if (output.refused !== null) return <Banner tone="info" title="Not computed for you">{output.refused}</Banner>;
  const o = output.output;
  if (o === null) return null;
  if (o.kind === 'table') {
    return (
      <div className={nb.scroll}>
        {o.note !== null ? <p className={styles.muted} role="note">Note: {o.note}.</p> : null}
        <table className={styles.dataTable}>
          <caption className={styles.muted}>{plural(o.total, 'row')}{o.truncated ? `; the first ${formatNumber(o.rows.length)} shown` : ''}{o.withheld > 0 ? `; ${plural(o.withheld, 'column')} withheld from you` : ''}</caption>
          <thead><tr>{o.columns.map((c) => <th key={c} scope="col" className={styles.mono}>{c}</th>)}</tr></thead>
          <tbody>{o.rows.map((r, i) => <tr key={i}>{r.map((v, j) => <td key={j}>{cellText(v)}</td>)}</tr>)}</tbody>
        </table>
      </div>
    );
  }
  if (o.kind === 'stats') {
    const num = (v: number | undefined) => (v === undefined ? '' : Number.isInteger(v) ? formatNumber(v) : formatNumber(v, 3));
    return (
      <div className={nb.scroll}>
        <table className={styles.dataTable} aria-label="Statistics">
          <thead><tr>{['Column', 'Rows', 'Empty', 'Distinct', 'Min', 'Median', 'Mean', '90th', 'Max', 'Std dev', 'Most often'].map((h) => <th key={h} scope="col">{h}</th>)}</tr></thead>
          <tbody>{o.columns.map((c) => (
            <tr key={c.name}>
              <th scope="row" className={styles.mono}>{c.name}</th><td>{num(c.count)}</td><td>{num(c.empty)}</td><td>{num(c.distinct)}</td>
              <td>{num(c.numeric?.min)}</td><td>{num(c.numeric?.median)}</td><td>{num(c.numeric?.mean)}</td><td>{num(c.numeric?.p90)}</td><td>{num(c.numeric?.max)}</td><td>{num(c.numeric?.stddev)}</td>
              <td>{c.top.slice(0, 3).map((t) => `${String(t.value)} (${t.count})`).join(', ')}</td>
            </tr>
          ))}</tbody>
        </table>
      </div>
    );
  }
  return <ChartView chart={o} />;
}

const W = 640;
const H = 260;
const PAD = { l: 48, r: 12, t: 12, b: 28 };
const fmt = (v: number) => (Math.abs(v) >= 1000 ? formatNumber(v, 0) : formatNumber(v, 2));

/** A chart drawn as SVG: bars across, a histogram's bins up, points and a line in their extent. */
export function ChartView({ chart }: { chart: Chart }) {
  const omitted = chart.omitted > 0 ? <p className={styles.muted}>{plural(chart.omitted, 'row')} not drawn.</p> : null;
  if (chart.bars !== undefined) {
    const max = Math.max(1, ...chart.bars.map((b) => b.value));
    const rowH = 22;
    const height = chart.bars.length * rowH + 8;
    return (
      <figure className={nb.chart}>
        <svg viewBox={`0 0 ${W} ${height}`} className={nb.svg} role="img" aria-label={`Bars: ${plural(chart.bars.length, 'category', 'categories')}`}>
          {chart.bars.map((b, i) => (
            <g key={b.label} transform={`translate(0 ${i * rowH + 4})`}>
              <text x={150} y={14} textAnchor="end" className={nb.axisLabel}>{b.label.length > 24 ? `${b.label.slice(0, 23)}…` : b.label}</text>
              <rect x={158} y={2} height={16} width={Math.max(1, ((W - 230) * b.value) / max)} className={nb.bar} />
              <text x={162 + ((W - 230) * b.value) / max} y={14} className={nb.value}>{fmt(b.value)}</text>
            </g>
          ))}
        </svg>
        {omitted}
      </figure>
    );
  }
  if (chart.bins !== undefined) {
    const max = Math.max(1, ...chart.bins.map((b) => b.count));
    const width = (W - PAD.l - PAD.r) / Math.max(1, chart.bins.length);
    return (
      <figure className={nb.chart}>
        <svg viewBox={`0 0 ${W} ${H}`} className={nb.svg} role="img" aria-label={`Histogram: ${plural(chart.bins.length, 'bin')}`}>
          {chart.bins.map((b, i) => {
            const h = ((H - PAD.t - PAD.b) * b.count) / max;
            return <rect key={i} x={PAD.l + i * width + 1} y={H - PAD.b - h} width={Math.max(1, width - 2)} height={h} className={nb.bar}><title>{`${fmt(b.from)} to ${fmt(b.to)}: ${b.count}`}</title></rect>;
          })}
          <line x1={PAD.l} y1={H - PAD.b} x2={W - PAD.r} y2={H - PAD.b} className={nb.axis} />
          {chart.bins.length > 0 ? <text x={PAD.l} y={H - 8} className={nb.axisLabel}>{fmt(chart.bins[0]!.from)}</text> : null}
          {chart.bins.length > 0 ? <text x={W - PAD.r} y={H - 8} textAnchor="end" className={nb.axisLabel}>{fmt(chart.bins.at(-1)!.to)}</text> : null}
          <text x={PAD.l - 6} y={PAD.t + 10} textAnchor="end" className={nb.axisLabel}>{max}</text>
        </svg>
        {omitted}
      </figure>
    );
  }
  const points = chart.points ?? [];
  if (points.length === 0) return <>{<p className={styles.muted}>Nothing to draw.</p>}{omitted}</>;
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const sx = (v: number) => PAD.l + ((W - PAD.l - PAD.r) * (v - x0)) / (x1 - x0 || 1);
  const sy = (v: number) => H - PAD.b - ((H - PAD.t - PAD.b) * (v - y0)) / (y1 - y0 || 1);
  const line = points.length > 1 && points.every((p, i) => i === 0 || p[0] >= points[i - 1]![0]);
  return (
    <figure className={nb.chart}>
      <svg viewBox={`0 0 ${W} ${H}`} className={nb.svg} role="img" aria-label={`${line ? 'Line' : 'Scatter'}: ${plural(points.length, 'point')}`}>
        <line x1={PAD.l} y1={H - PAD.b} x2={W - PAD.r} y2={H - PAD.b} className={nb.axis} />
        <line x1={PAD.l} y1={PAD.t} x2={PAD.l} y2={H - PAD.b} className={nb.axis} />
        {line ? <polyline points={points.map((p) => `${sx(p[0])},${sy(p[1])}`).join(' ')} className={nb.line} />
          : points.map((p, i) => <circle key={i} cx={sx(p[0])} cy={sy(p[1])} r={3} className={nb.point} />)}
        <text x={PAD.l} y={H - 8} className={nb.axisLabel}>{fmt(x0)}</text>
        <text x={W - PAD.r} y={H - 8} textAnchor="end" className={nb.axisLabel}>{fmt(x1)}</text>
        <text x={PAD.l - 6} y={H - PAD.b} textAnchor="end" className={nb.axisLabel}>{fmt(y0)}</text>
        <text x={PAD.l - 6} y={PAD.t + 10} textAnchor="end" className={nb.axisLabel}>{fmt(y1)}</text>
      </svg>
      {omitted}
    </figure>
  );
}
