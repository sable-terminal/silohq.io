'use client';

// Reports (D233): documents whose figures stay live. Headings and text a person writes, and live
// blocks read for whoever opens the report, as them: an object set's objects, or a workbook's
// computed figures. The owner edits the blocks in order (add, move, remove), renames, saves,
// shares and archives; anyone it reaches reads it and exports it into Files as a PDF of what they
// see; a copy share copies.

import { useRouter } from 'next/navigation';
import { useState } from 'react';
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
import { ErrorMessage, Loading } from '../../components/states.component.tsx';
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
import styles from './studio.view.module.css';

type Report = Output<'getReport'>;
type Doc = Report['document'];
type Block = Doc['blocks'][number];
type Read = Output<'readReportBlocks'>['blocks'][number];
const reportHref = (id: string) => hrefWith('/studio/reports/', { report: id });
const newId = (kind: string) => `${kind}-${Date.now().toString(36)}${Math.floor(Math.random() * 1000).toString(36)}`;
const RANGE = /^[A-Z]{1,3}[1-9][0-9]{0,4}:[A-Z]{1,3}[1-9][0-9]{0,4}$/;

/** /studio/reports/: the directory, or a report open. */
export function Reports() {
  const [params] = useParams();
  const open = params.get('report');
  if (open === null) return <ReportDirectory />;
  const id = idFrom(open);
  return id === undefined ? <NotFound title="Reports" what="a report" icon="document" href="/studio/reports/" /> : <ReportEditor key={id} reportId={id} />;
}

function ReportDirectory() {
  const router = useRouter();
  const [filter, setFilter] = useTab(FILTERS, 'filter');
  const list = useQuery('listReports', { query: { filter } }, { keepPrevious: true });
  const create = useMutation('createReport', { invalidates: ['listReports'] });
  usePageContext({ scope: { kind: 'page', page: 'studio' }, scopeLabel: 'Reports' });
  return (
    <Directory title="Reports" what="report" icon="document" description="Documents with live tables and workbook figures, read for whoever opens them."
      filter={filter} onFilter={setFilter} query={list} rows={(d) => d.reports} hrefOf={reportHref}
      createBlocked={create.blocked} createPending={create.pending} createError={create.error}
      onCreate={(name) => void create.run({ body: { name } }).then((r) => r.ok && router.push(reportHref(r.data.id) as never))}
      emptyMine="A report puts what you write beside live tables of your objects and figures from your workbooks." />
  );
}

/** A live block as read for this person: its table, or why it is not shown. */
function LiveTable({ read, caption }: { read: Read | undefined; caption: string | undefined }) {
  if (read === undefined) return <Loading label="Reading it" block={false} />;
  if (read.refused !== null) return <Banner tone="info" title={caption ?? 'Not shown to you'}>{read.refused}</Banner>;
  return (
    <div className={styles.stackTight}>
      <div className={styles.tableWrap}>
        <table className={styles.dataTable}>
          {caption !== undefined ? <caption className={styles.muted}>{caption}</caption> : null}
          <thead><tr>{read.header.map((h, i) => <th key={i} scope="col">{h}</th>)}</tr></thead>
          <tbody>{read.rows.map((row, i) => <tr key={i}>{row.map((v, c) => <td key={c}>{v === null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v)}</td>)}</tr>)}</tbody>
        </table>
      </div>
      {read.truncated || read.withheld > 0 ? (
        <p className={styles.muted}>
          {read.truncated && read.total !== null ? `The first ${formatNumber(read.rows.length)} of ${formatNumber(read.total)} objects. ` : ''}
          {read.withheld > 0 ? `${plural(read.withheld, 'column')} withheld from you.` : ''}
        </p>
      ) : null}
    </div>
  );
}

function ReportEditor({ reportId }: { reportId: string }) {
  const router = useRouter();
  const say = useToast();
  const read = useQuery('getReport', { params: { reportId } });
  const blocksRead = useQuery('readReportBlocks', { params: { reportId } });
  const save = useMutation('saveReport', { invalidates: ['getReport', 'listReports', 'readReportBlocks'] });
  const exportIt = useMutation('exportReport');
  const copy = useMutation('copyReport', { invalidates: ['listReports'] });
  const archive = useMutation('archiveReport', { invalidates: ['listReports', 'getReport'] });
  const shares = useQuery('listReportShares', read.data?.access === 'owner' ? { params: { reportId } } : null);
  const share = useMutation('shareReport', { invalidates: ['listReportShares', 'getReport'] });
  const revoke = useMutation('revokeReportShare', { invalidates: ['listReportShares', 'getReport'] });
  const [dialog, setDialog] = useState<'share' | 'copy' | 'archive' | 'rename' | undefined>();
  const r = read.data;
  const draft = useDraft<Doc>(r);
  usePageContext({ scope: { kind: 'page', page: 'studio' }, scopeLabel: r?.name ?? 'a report' });

  if (r === undefined || draft.doc === undefined) {
    return <Page title="Report" crumbs={[{ label: 'Studio' }, { label: 'Reports', href: '/studio/reports/' }]}><QueryView query={read} what="The report">{() => null}</QueryView></Page>;
  }
  const blocks = draft.doc.blocks;
  const owner = r.access === 'owner';
  const archived = r.archivedAt !== null;
  const editable = owner && !archived;
  const change = (next: Block[]) => draft.change({ schemaVersion: '1', blocks: next });
  const update = (i: number, b: Block) => change(blocks.map((x, j) => (j === i ? b : x)));
  const moveBlock = (i: number, d: -1 | 1) => {
    const next = [...blocks];
    const [b] = next.splice(i, 1);
    next.splice(i + d, 0, b!);
    change(next);
  };
  const doSave = async (name?: string) => {
    const out = await save.run({ params: { reportId }, body: { ...(name === undefined ? {} : { name }), document: draft.doc!, lockVersion: draft.lockVersion } });
    if (!out.ok) return false;
    draft.saved(out.data);
    say('Saved');
    return true;
  };
  return (
    <Page title={r.name} documentTitle={r.name} crumbs={[{ label: 'Studio' }, { label: 'Reports', href: '/studio/reports/' }]}
      meta={<span className={styles.row}>
        {archived ? <Badge>Archived</Badge> : null}{!owner ? <Badge tone="info">{HELD[r.access]}</Badge> : null}{draft.edited ? <Badge tone="warn">Unsaved changes</Badge> : null}
        {blocksRead.data !== undefined ? <span className={styles.muted}>Figures read <Time value={blocksRead.data.computedAt} /></span> : null}
      </span>}
      actions={
        <div className={styles.row}>
          {editable ? <Button variant="primary" icon="check" pending={save.pending} disabled={!draft.edited} blocked={save.blocked} onClick={() => void doSave()}>Save</Button> : null}
          {owner ? <Button icon="share" blocked={share.blocked} onClick={() => setDialog('share')}>Share</Button> : null}
          <Menu label="More" items={[
            { label: 'Rename', icon: 'edit', disabled: !editable, onSelect: () => setDialog('rename') },
            { label: 'Make a copy', icon: 'copy', disabled: !(owner || r.access === 'copy'), blocked: copy.blocked, onSelect: () => setDialog('copy') },
            { label: 'Export as PDF to Files', icon: 'download', blocked: draft.edited ? 'Save it first' : exportIt.blocked,
              onSelect: () => void exportIt.run({ params: { reportId }, body: {} }).then((x) => x.ok && say(`Saved to Files as ${x.data.file.name}`)) },
            { label: 'Read the figures again', icon: 'refresh', onSelect: blocksRead.refetch },
            { separator: true },
            { label: 'Archive', icon: 'trash', tone: 'danger', disabled: !owner || archived, blocked: archive.blocked, onSelect: () => setDialog('archive') },
          ]} renderTrigger={(p) => <IconButton {...p} label="More" icon="more" />} />
        </div>
      }>
      <div className={styles.stack}>
        {archived ? <Banner tone="info" title="Archived">It can be read and exported, not changed.</Banner> : null}
        {draft.stale ? <Banner tone="warn" title="Saved elsewhere since you opened it">Saving now would be refused. Copy what you changed, then open it again.</Banner> : null}
        {save.error !== undefined ? <ErrorMessage error={save.error} /> : null}
        {exportIt.error !== undefined ? <ErrorMessage error={exportIt.error} /> : null}
        {blocksRead.error !== undefined ? <ErrorMessage error={blocksRead.error} onRetry={blocksRead.refetch} /> : null}
        {blocks.length === 0 ? <p className={styles.muted}>{editable ? 'Empty: add a heading, text, objects or workbook figures below.' : 'This report is empty.'}</p> : null}
        {blocks.map((b, i) => (
          <section key={b.id} aria-label={`Block ${i + 1}`} className={editable ? styles.card : styles.stackTight}>
            {editable ? (
              <div className={styles.cardHead}>
                <span className={styles.muted}>{b.kind === 'heading' ? 'Heading' : b.kind === 'text' ? 'Text' : b.kind === 'objects' ? 'Objects' : 'Workbook figures'}</span>
                <IconButton size="sm" icon="chevronUp" label="Move up" disabled={i === 0} onClick={() => moveBlock(i, -1)} />
                <IconButton size="sm" icon="chevronDown" label="Move down" disabled={i === blocks.length - 1} onClick={() => moveBlock(i, 1)} />
                <IconButton size="sm" icon="trash" label={`Remove block ${i + 1}`} onClick={() => change(blocks.filter((_, j) => j !== i))} />
              </div>
            ) : null}
            {editable ? <BlockEditor block={b} onChange={(x) => update(i, x)} />
              : b.kind === 'heading' ? (b.level === 1 ? <h2 className={styles.subheading}>{b.text}</h2> : <h3 className={styles.subheading}>{b.text}</h3>)
                : b.kind === 'text' ? <p className={styles.prose}>{b.text}</p> : null}
            {b.kind === 'objects' || b.kind === 'workbook' ? <LiveTable read={blocksRead.data?.blocks.find((x) => x.id === b.id)} caption={b.caption} /> : null}
          </section>
        ))}
        {editable && blocks.length < 100 ? <AddBlock onAdd={(b) => change([...blocks, b])} /> : null}
      </div>
      <ShareDialog open={dialog === 'share'} onClose={() => setDialog(undefined)} title={`Share ${r.name}`} what="this report" access={DOCUMENT_ACCESS}
        shares={sharesFor(shares.data?.shares)} shareBlocked={share.blocked} revokeBlocked={revoke.blocked}
        onShare={(grantee, access) => share.run({ params: { reportId }, body: { grantee, access } })}
        onRevoke={(shareId) => revoke.run({ params: { reportId, shareId } })} />
      <NameDialog key={`rename:${r.lockVersion}`} open={dialog === 'rename'} title="Rename the report" initial={r.name} action="Rename" pending={save.pending} error={save.error}
        hint={draft.edited ? 'Renaming saves your other changes too.' : undefined}
        onClose={() => setDialog(undefined)} onSave={(n) => void doSave(n).then((ok) => ok && setDialog(undefined))} />
      <NameDialog open={dialog === 'copy'} title="Copy the report" initial={`${r.name} (copy)`.slice(0, 200)} action="Make the copy" pending={copy.pending} error={copy.error}
        onClose={() => setDialog(undefined)}
        onSave={(n) => void copy.run({ params: { reportId }, body: { name: n } }).then((x) => {
          if (!x.ok) return;
          setDialog(undefined);
          router.push(reportHref(x.data.id) as never);
        })} />
      <ConfirmDialog open={dialog === 'archive'} onClose={() => setDialog(undefined)} title={`Archive ${r.name}?`} confirmLabel="Archive" tone="danger"
        onConfirm={async () => {
          const x = await archive.run({ params: { reportId } });
          if (x.ok) say('Archived');
          return x;
        }}><p>It stays readable under Archived; its shares stop granting access.</p></ConfirmDialog>
    </Page>
  );
}

function AddBlock({ onAdd }: { onAdd: (b: Block) => void }) {
  const sets = useQuery('listOntologyObjectSets', { query: {} });
  const workbooks = useQuery('listWorkbooks', { query: { filter: 'mine' } });
  const firstSet = sets.data?.objectSets[0];
  const firstWorkbook = workbooks.data?.workbooks[0];
  return (
    <div className={styles.row} role="group" aria-label="Add a block">
      <Button icon="plus" onClick={() => onAdd({ id: newId('heading'), kind: 'heading', text: 'Heading', level: 2 })}>Heading</Button>
      <Button icon="plus" onClick={() => onAdd({ id: newId('text'), kind: 'text', text: '' })}>Text</Button>
      <Button icon="plus" blocked={firstSet === undefined ? 'Save an object set in Explorer first' : undefined}
        onClick={() => firstSet !== undefined && onAdd({ id: newId('objects'), kind: 'objects', objectSetId: firstSet.id, propertyIds: [], limit: 50 })}>Objects</Button>
      <Button icon="plus" blocked={firstWorkbook === undefined ? 'Make a workbook first' : undefined}
        onClick={() => firstWorkbook !== undefined && onAdd({ id: newId('workbook'), kind: 'workbook', workbookId: firstWorkbook.id, sheetId: 'sheet-1', range: 'A1:B5', header: true })}>Workbook figures</Button>
    </div>
  );
}

function BlockEditor({ block, onChange }: { block: Block; onChange: (b: Block) => void }) {
  switch (block.kind) {
    case 'heading':
      return (
        <div className={styles.fields}>
          <TextField label="Heading" value={block.text} maxLength={200} onChange={(e) => onChange({ ...block, text: e.target.value })} />
          <SelectField label="Level" value={String(block.level)} onChange={(e) => onChange({ ...block, level: Number(e.target.value) as 1 | 2 })}
            options={[{ value: '1', label: 'Title' }, { value: '2', label: 'Section' }]} />
        </div>
      );
    case 'text':
      return <TextArea label="Text" rows={4} value={block.text} maxLength={10_000} onChange={(e) => onChange({ ...block, text: e.target.value })} />;
    case 'objects':
      return <ObjectsBlock block={block} onChange={onChange} />;
    case 'workbook':
      return <WorkbookBlock block={block} onChange={onChange} />;
  }
}

function ObjectsBlock({ block, onChange }: { block: Extract<Block, { kind: 'objects' }>; onChange: (b: Block) => void }) {
  const { data: vocabulary } = useVocabulary();
  const sets = useQuery('listOntologyObjectSets', { query: {} });
  const set = sets.data?.objectSets.find((s) => s.id === block.objectSetId);
  const type = vocabulary?.objectTypes.find((t) => t.id === set?.baseTypeId);
  return (
    <div className={styles.stackTight}>
      <div className={styles.fields}>
        <TextField label="Caption (optional)" value={block.caption ?? ''} maxLength={200} onChange={(e) => onChange({ ...block, caption: e.target.value === '' ? undefined : e.target.value })} />
        <SelectField label="Objects of" value={block.objectSetId} onChange={(e) => onChange({ ...block, objectSetId: e.target.value, propertyIds: [] })}
          options={(sets.data?.objectSets ?? []).map((s) => ({ value: s.id, label: s.name }))} />
        <TextField label="At most" type="number" min={1} max={500} value={block.limit} onChange={(e) => onChange({ ...block, limit: Math.max(1, Math.min(500, Number(e.target.value) || 1)) })} />
      </div>
      {type !== undefined ? (
        <fieldset className={styles.fieldset}>
          <legend>Columns (up to 12)</legend>
          <div className={styles.checks}>{type.properties.map((p) => (
            <Checkbox key={p.identityId} label={p.displayName} checked={block.propertyIds.includes(p.identityId)}
              disabled={!block.propertyIds.includes(p.identityId) && block.propertyIds.length >= 12}
              onChange={(e) => onChange({ ...block, propertyIds: e.target.checked ? [...block.propertyIds, p.identityId].slice(0, 12) : block.propertyIds.filter((x) => x !== p.identityId) })} />
          ))}</div>
        </fieldset>
      ) : null}
    </div>
  );
}

function WorkbookBlock({ block, onChange }: { block: Extract<Block, { kind: 'workbook' }>; onChange: (b: Block) => void }) {
  const workbooks = useQuery('listWorkbooks', { query: { filter: 'mine' } });
  const chosen = useQuery('getWorkbook', { params: { workbookId: block.workbookId } });
  return (
    <div className={styles.fields}>
      <TextField label="Caption (optional)" value={block.caption ?? ''} maxLength={200} onChange={(e) => onChange({ ...block, caption: e.target.value === '' ? undefined : e.target.value })} />
      <SelectField label="Figures from" value={block.workbookId} onChange={(e) => onChange({ ...block, workbookId: e.target.value, sheetId: 'sheet-1' })}
        options={(workbooks.data?.workbooks ?? []).map((w) => ({ value: w.id, label: w.name }))} />
      <SelectField label="Sheet" value={block.sheetId} onChange={(e) => onChange({ ...block, sheetId: e.target.value })}
        options={(chosen.data?.document.sheets ?? [{ id: block.sheetId, name: block.sheetId }]).map((s) => ({ value: s.id, label: s.name }))} />
      <TextField label="Cells" value={block.range} onChange={(e) => onChange({ ...block, range: e.target.value.toUpperCase() })}
        error={RANGE.test(block.range) ? undefined : 'A range such as A1:C10'} />
      <Checkbox label="First row is the header" checked={block.header} onChange={(e) => onChange({ ...block, header: e.target.checked })} />
    </div>
  );
}
