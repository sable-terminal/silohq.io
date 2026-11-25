'use client';

// Workbooks (D232): spreadsheets over live object sets. The directory lists a person's own, those
// shared with them and those archived; a workbook opens as a grid. Cells hold what was typed
// (values, or formulas beginning with "="), recalculated here as they change by the same module
// the cell exports with; a live range places an object set's rows at a cell, read for whoever
// opens it as them, never stored, and formulas read its cells like typed ones. The owner edits,
// saves, shares, inserts live ranges and archives; a copy share copies; anyone it reaches exports
// it into Files. The grid is a window moved by the keyboard, the wheel and Go to.

import { useRouter } from 'next/navigation';
import { useMemo, useRef, useState, type KeyboardEvent } from 'react';
import type { Output } from '../../api/client.api.ts';
import { Badge } from '../../components/badge.component.tsx';
import { Banner } from '../../components/banner.component.tsx';
import { Button, IconButton } from '../../components/button.component.tsx';
import { ConfirmDialog, Dialog } from '../../components/dialog.component.tsx';
import { Checkbox, FormActions, SelectField, TextField } from '../../components/field.component.tsx';
import { Menu } from '../../components/menu.component.tsx';
import { Page } from '../../components/page.component.tsx';
import { QueryView } from '../../components/query.component.tsx';
import { ShareDialog } from '../../components/share.component.tsx';
import { ErrorMessage } from '../../components/states.component.tsx';
import { useTab } from '../../components/tabs.component.tsx';
import { useToast } from '../../components/toast.component.tsx';
import { useMutation, useQuery } from '../../data/query.data.ts';
import { useParams } from '../../hooks/params.hook.ts';
import { useVocabulary } from '../../hooks/vocabulary.hook.ts';
import { usePageContext } from '../../shell/context.shell.tsx';
import { formatNumber } from '../../utils/format.util.ts';
import { cellName, columnName, display, isError, key, parseCell, recalculate, type Value } from '../../utils/formula.util.ts';
import { hrefWith } from '../../utils/href.util.ts';
import { Directory, DOCUMENT_ACCESS, FILTERS, HELD, idFrom, NameDialog, NotFound, sharesFor, useDraft } from './kit.view.tsx';
import styles from './studio.view.module.css';
import css from './workbook.view.module.css';

type Workbook = Output<'getWorkbook'>;
type Doc = Workbook['document'];
type Ranges = Output<'readWorkbookRanges'>['ranges'];
type LiveRange = Doc['liveRanges'][number];
const ROWS = 30;
const COLS = 10;
const workbookHref = (id: string) => hrefWith('/studio/workbooks/', { workbook: id });

/** /studio/workbooks/: the directory, or a workbook open. */
export function Workbooks() {
  const [params] = useParams();
  const open = params.get('workbook');
  if (open === null) return <WorkbookDirectory />;
  const id = idFrom(open);
  return id === undefined ? <NotFound title="Workbooks" what="a workbook" icon="table" href="/studio/workbooks/" /> : <WorkbookEditor key={id} workbookId={id} />;
}

function WorkbookDirectory() {
  const router = useRouter();
  const [filter, setFilter] = useTab(FILTERS, 'filter');
  const list = useQuery('listWorkbooks', { query: { filter } }, { keepPrevious: true });
  const create = useMutation('createWorkbook', { invalidates: ['listWorkbooks'] });
  usePageContext({ scope: { kind: 'page', page: 'studio' }, scopeLabel: 'Workbooks' });
  return (
    <Directory title="Workbooks" what="workbook" icon="table" description="Spreadsheets over your objects: what you type, and live ranges read for whoever opens them."
      filter={filter} onFilter={setFilter} query={list} rows={(d) => d.workbooks} hrefOf={workbookHref}
      createBlocked={create.blocked} createPending={create.pending} createError={create.error}
      onCreate={(name) => void create.run({ body: { name } }).then((r) => r.ok && router.push(workbookHref(r.data.id) as never))}
      emptyMine="A workbook mixes what you type with live ranges of your objects." />
  );
}

/** Live ranges' cells, keyed as the formula module keys them: values, which are a range's header, and which belong to a range. */
function overlayOf(doc: Doc, ranges: Ranges | undefined): { values: Map<string, Value>; headers: Set<string>; live: Set<string> } {
  const values = new Map<string, Value>();
  const headers = new Set<string>();
  const live = new Set<string>();
  for (const r of doc.liveRanges) {
    const read = ranges?.find((x) => x.id === r.id);
    const sheet = doc.sheets.find((s) => s.id === r.sheetId);
    const at = parseCell(r.anchor);
    if (sheet === undefined || at === undefined) continue;
    for (let c = 0; c < r.propertyIds.length; c++) {
      const k = key(sheet.name, at.col + c, at.row);
      headers.add(k);
      live.add(k);
      values.set(k, read?.header[c] ?? '…');
    }
    for (let i = 0; i < r.limit; i++) {
      for (let c = 0; c < r.propertyIds.length; c++) live.add(key(sheet.name, at.col + c, at.row + 1 + i));
    }
    read?.rows.forEach((row, i) => row.forEach((v, c) => values.set(key(sheet.name, at.col + c, at.row + 1 + i),
      v === null || typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean' ? v : JSON.stringify(v))));
  }
  return { values, headers, live };
}

function WorkbookEditor({ workbookId }: { workbookId: string }) {
  const router = useRouter();
  const say = useToast();
  const read = useQuery('getWorkbook', { params: { workbookId } });
  const ranges = useQuery('readWorkbookRanges', { params: { workbookId } });
  const save = useMutation('saveWorkbook', { invalidates: ['getWorkbook', 'listWorkbooks', 'readWorkbookRanges'] });
  const exportIt = useMutation('exportWorkbook');
  const copy = useMutation('copyWorkbook', { invalidates: ['listWorkbooks'] });
  const archive = useMutation('archiveWorkbook', { invalidates: ['listWorkbooks', 'getWorkbook'] });
  const shares = useQuery('listWorkbookShares', read.data?.access === 'owner' ? { params: { workbookId } } : null);
  const share = useMutation('shareWorkbook', { invalidates: ['listWorkbookShares', 'getWorkbook'] });
  const revoke = useMutation('revokeWorkbookShare', { invalidates: ['listWorkbookShares', 'getWorkbook'] });
  const [dialog, setDialog] = useState<'share' | 'copy' | 'archive' | 'rename' | 'range' | undefined>();
  const [sheetId, setSheetId] = useState<string | undefined>();
  const [sel, setSel] = useState({ col: 0, row: 0 });
  const [top, setTop] = useState(0);
  const [left, setLeft] = useState(0);
  const [editing, setEditing] = useState<string | undefined>();
  const grid = useRef<HTMLTableElement>(null);
  const today = useMemo(() => new Date().toISOString().slice(0, 10), []);
  usePageContext({ scope: { kind: 'page', page: 'studio' }, scopeLabel: read.data?.name ?? 'a workbook' });

  const w = read.data;
  const draft = useDraft<Doc>(w);
  const { doc, change, edited } = draft;

  const overlay = useMemo(() => (doc === undefined ? undefined : overlayOf(doc, ranges.data?.ranges)), [doc, ranges.data]);
  const values = useMemo(() => (doc === undefined || overlay === undefined ? new Map<string, Value>()
    : recalculate(doc.sheets.map((s) => ({ name: s.name, cells: s.cells })), today, overlay.values)), [doc, overlay, today]);

  if (w === undefined || doc === undefined || overlay === undefined) {
    return <Page title="Workbook" crumbs={[{ label: 'Studio' }, { label: 'Workbooks', href: '/studio/workbooks/' }]}><QueryView query={read} what="The workbook">{() => null}</QueryView></Page>;
  }
  const owner = w.access === 'owner';
  const archived = w.archivedAt !== null;
  const editable = owner && !archived;
  const dirty = edited;
  const stale = draft.stale;
  const sheet = doc.sheets.find((s) => s.id === sheetId) ?? doc.sheets[0]!;
  const at = (col: number, row: number) => key(sheet.name, col, row);
  const input = (col: number, row: number) => sheet.cells[cellName(col, row)];
  const valueAt = (col: number, row: number): Value => overlay.values.get(at(col, row)) ?? values.get(at(col, row)) ?? null;
  const isLive = (col: number, row: number) => overlay.live.has(at(col, row));

  const setCell = (col: number, row: number, text: string) => {
    if (!editable || isLive(col, row)) return;
    const n = cellName(col, row);
    const cells = { ...sheet.cells };
    if (text === '') delete cells[n];
    else cells[n] = text;
    change({ ...doc, sheets: doc.sheets.map((s) => (s.id === sheet.id ? { ...s, cells } : s)) });
  };
  const move = (col: number, row: number) => {
    const c = Math.max(0, Math.min(199, col));
    const r = Math.max(0, Math.min(19_999, row));
    setSel({ col: c, row: r });
    if (r < top) setTop(r);
    else if (r >= top + ROWS) setTop(r - ROWS + 1);
    if (c < left) setLeft(c);
    else if (c >= left + COLS) setLeft(c - COLS + 1);
  };
  const onKey = (e: KeyboardEvent) => {
    if (editing !== undefined) return;
    const d: Record<string, [number, number]> = { ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0], Tab: [e.shiftKey ? -1 : 1, 0], Enter: [0, 1] };
    if (e.key in d && !(e.key === 'Enter' && editable)) {
      e.preventDefault();
      const [dc, dr] = d[e.key]!;
      move(sel.col + dc, sel.row + dr);
      return;
    }
    if (!editable || isLive(sel.col, sel.row)) return;
    if (e.key === 'Enter' || e.key === 'F2') {
      e.preventDefault();
      setEditing(String(input(sel.col, sel.row) ?? ''));
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      setCell(sel.col, sel.row, '');
    } else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey) {
      e.preventDefault();
      setEditing(e.key);
    }
  };
  const commit = (next: 'down' | 'right' | 'stay') => {
    if (editing === undefined) return;
    setCell(sel.col, sel.row, editing);
    setEditing(undefined);
    if (next === 'down') move(sel.col, sel.row + 1);
    else if (next === 'right') move(sel.col + 1, sel.row);
    grid.current?.focus();
  };
  const doSave = async (rename?: string) => {
    const r = await save.run({ params: { workbookId }, body: { name: rename ?? w.name, document: doc, lockVersion: draft.lockVersion } });
    if (!r.ok) return false;
    draft.saved(r.data);
    say('Saved');
    return true;
  };
  const selected = input(sel.col, sel.row);
  const refused = (ranges.data?.ranges ?? []).filter((r) => r.refused !== null);
  const truncated = (ranges.data?.ranges ?? []).filter((r) => r.truncated);
  return (
    <Page title={w.name} documentTitle={w.name} width="full" crumbs={[{ label: 'Studio' }, { label: 'Workbooks', href: '/studio/workbooks/' }]}
      meta={<span className={styles.row}>{archived ? <Badge>Archived</Badge> : null}{!owner ? <Badge tone="info">{HELD[w.access]}</Badge> : null}{dirty ? <Badge tone="warn">Unsaved changes</Badge> : null}</span>}
      actions={
        <div className={styles.row}>
          {editable ? <Button variant="primary" icon="check" pending={save.pending} disabled={!dirty} blocked={save.blocked} onClick={() => void doSave()}>Save</Button> : null}
          {editable ? <Button icon="plus" onClick={() => setDialog('range')}>Live range at {cellName(sel.col, sel.row)}</Button> : null}
          {owner ? <Button icon="share" blocked={share.blocked} onClick={() => setDialog('share')}>Share</Button> : null}
          <Menu label="More" items={[
            { label: 'Rename', icon: 'edit', disabled: !editable, onSelect: () => setDialog('rename') },
            { label: 'Make a copy', icon: 'copy', disabled: !(owner || w.access === 'copy'), blocked: copy.blocked, onSelect: () => setDialog('copy') },
            { label: 'Export to Files', icon: 'download', blocked: dirty ? 'Save it first' : exportIt.blocked,
              onSelect: () => void exportIt.run({ params: { workbookId }, body: {} }).then((r) => r.ok && say(`Saved to Files as ${r.data.file.name}`)) },
            { label: 'Read the live ranges again', icon: 'refresh', onSelect: ranges.refetch },
            { separator: true },
            { label: 'Archive', icon: 'trash', tone: 'danger', disabled: !owner || archived, blocked: archive.blocked, onSelect: () => setDialog('archive') },
          ]} renderTrigger={(p) => <IconButton {...p} label="More" icon="more" />} />
        </div>
      }>
      <div className={styles.stack}>
        {archived ? <Banner tone="info" title="Archived">It can be read and exported, not changed.</Banner> : null}
        {stale && dirty ? <Banner tone="warn" title="Saved elsewhere since you opened it">Saving now would be refused. Copy what you changed, then open it again.</Banner> : null}
        {save.error !== undefined ? <ErrorMessage error={save.error} /> : null}
        {exportIt.error !== undefined ? <ErrorMessage error={exportIt.error} /> : null}
        {ranges.error !== undefined ? <ErrorMessage error={ranges.error} onRetry={ranges.refetch} /> : null}
        {refused.map((r) => <Banner key={r.id} tone="info" title="A live range was not read for you">{r.refused}</Banner>)}
        {truncated.map((r) => <p key={r.id} className={styles.muted} role="note">A live range shows the first {formatNumber(r.rows.length)} of {formatNumber(r.total)} objects.</p>)}
        <div className={css.sheets} role="tablist" aria-label="Sheets">
          {doc.sheets.map((s) => (
            <button key={s.id} type="button" role="tab" aria-selected={s.id === sheet.id} className={css.sheetTab} onClick={() => {
              setSheetId(s.id);
              move(0, 0);
            }}>{s.name}</button>
          ))}
          {editable && doc.sheets.length < 20 ? (
            <Button size="sm" variant="ghost" icon="plus" onClick={() => {
              const id = `sheet-${Date.now().toString(36)}`;
              change({ ...doc, sheets: [...doc.sheets, { id, name: `Sheet${doc.sheets.length + 1}`, cells: {} }] });
              setSheetId(id);
            }}>Add a sheet</Button>
          ) : null}
        </div>
        <div className={css.formulaBar}>
          <span className={css.address} aria-live="polite">{cellName(sel.col, sel.row)}</span>
          <input className={css.formulaInput} aria-label="Cell contents" readOnly={!editable || isLive(sel.col, sel.row)}
            value={editing ?? String(selected ?? (isLive(sel.col, sel.row) ? display(valueAt(sel.col, sel.row)) : ''))}
            onFocus={() => {
              if (editable && !isLive(sel.col, sel.row) && editing === undefined) setEditing(String(selected ?? ''));
            }}
            onChange={(e) => setEditing(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                commit('down');
              } else if (e.key === 'Escape') {
                setEditing(undefined);
                grid.current?.focus();
              }
            }} />
        </div>
        <div className={css.window}>
          <span>Rows {top + 1}–{top + ROWS}, columns {columnName(left)}–{columnName(left + COLS - 1)}</span>
          <form className={styles.row} onSubmit={(e) => {
            e.preventDefault();
            const c = parseCell(String(new FormData(e.currentTarget).get('goto') ?? '').toUpperCase());
            if (c !== undefined) move(c.col, c.row);
          }}>
            <label className={styles.row}>Go to <input name="goto" className={css.goto} size={6} aria-label="Go to cell" /></label>
          </form>
        </div>
        <div className={css.gridWrap} onWheel={(e) => {
          if (e.deltaY !== 0) setTop((t) => Math.max(0, Math.min(19_999 - ROWS, t + Math.sign(e.deltaY) * 3)));
        }}>
          <table ref={grid} className={css.grid} role="grid" aria-label={`Sheet ${sheet.name}`} aria-rowcount={20_000} aria-colcount={200} tabIndex={0} onKeyDown={onKey}>
            <thead><tr><th className={css.rowHead} scope="col"><span className="visually-hidden">Row</span></th>
              {Array.from({ length: COLS }, (_, i) => <th key={i} scope="col" className={css.colHead}>{columnName(left + i)}</th>)}</tr></thead>
            <tbody>{Array.from({ length: ROWS }, (_, i) => top + i).map((row) => (
              <tr key={row} aria-rowindex={row + 1}>
                <th scope="row" className={css.rowHead}>{row + 1}</th>
                {Array.from({ length: COLS }, (_, i) => left + i).map((col) => {
                  const v = valueAt(col, row);
                  const chosen = sel.col === col && sel.row === row;
                  const k = at(col, row);
                  const cls = [css.cell, typeof v === 'number' ? css.number : '', isError(v) ? css.error : '', overlay.headers.has(k) ? css.liveHeader : overlay.live.has(k) ? css.live : '', chosen ? css.selected : ''].filter(Boolean).join(' ');
                  return (
                    <td key={col} role="gridcell" aria-colindex={col + 1} aria-selected={chosen} className={cls} onClick={() => {
                      setSel({ col, row });
                      grid.current?.focus();
                    }} onDoubleClick={() => {
                      if (editable && !isLive(col, row)) {
                        setSel({ col, row });
                        setEditing(String(input(col, row) ?? ''));
                      }
                    }}>
                      {chosen && editing !== undefined ? (
                        <input autoFocus className={css.editor} aria-label={`Edit ${cellName(col, row)}`} value={editing} onChange={(e) => setEditing(e.target.value)}
                          onKeyDown={(e) => {
                            e.stopPropagation();
                            if (e.key === 'Enter') {
                              e.preventDefault();
                              commit('down');
                            } else if (e.key === 'Tab') {
                              e.preventDefault();
                              commit('right');
                            } else if (e.key === 'Escape') {
                              setEditing(undefined);
                              grid.current?.focus();
                            }
                          }}
                          onBlur={() => commit('stay')} />
                      ) : display(v)}
                    </td>
                  );
                })}
              </tr>
            ))}</tbody>
          </table>
        </div>
      </div>
      {dialog === 'range' ? (
        <InsertRange sheetId={sheet.id} anchor={cellName(sel.col, sel.row)} existing={doc.liveRanges.length} onClose={() => setDialog(undefined)}
          onInsert={(r) => {
            change({ ...doc, liveRanges: [...doc.liveRanges, r] });
            setDialog(undefined);
            say('Live range placed: save to read it');
          }} />
      ) : null}
      <ShareDialog open={dialog === 'share'} onClose={() => setDialog(undefined)} title={`Share ${w.name}`} what="this workbook" access={DOCUMENT_ACCESS}
        shares={sharesFor(shares.data?.shares)} shareBlocked={share.blocked} revokeBlocked={revoke.blocked}
        onShare={(grantee, access) => share.run({ params: { workbookId }, body: { grantee, access } })}
        onRevoke={(shareId) => revoke.run({ params: { workbookId, shareId } })} />
      <NameDialog key={`rename:${w.lockVersion}`} open={dialog === 'rename'} title="Rename the workbook" hint={edited ? 'Renaming saves your other changes too.' : undefined} initial={w.name} action="Rename" pending={save.pending} error={save.error}
        onClose={() => setDialog(undefined)} onSave={(next) => void doSave(next).then((ok) => ok && setDialog(undefined))} />
      <NameDialog open={dialog === 'copy'} title="Copy the workbook" initial={`${w.name} (copy)`.slice(0, 200)} action="Make the copy" pending={copy.pending} error={copy.error}
        onClose={() => setDialog(undefined)}
        onSave={(n) => void copy.run({ params: { workbookId }, body: { name: n } }).then((r) => {
          if (!r.ok) return;
          setDialog(undefined);
          router.push(workbookHref(r.data.id) as never);
        })} />
      <ConfirmDialog open={dialog === 'archive'} onClose={() => setDialog(undefined)} title={`Archive ${w.name}?`} confirmLabel="Archive" tone="danger"
        onConfirm={async () => {
          const r = await archive.run({ params: { workbookId } });
          if (r.ok) say('Archived');
          return r;
        }}><p>It stays readable under Archived; its shares stop granting access.</p></ConfirmDialog>
    </Page>
  );
}

function InsertRange({ sheetId, anchor, existing, onInsert, onClose }: {
  sheetId: string; anchor: string; existing: number; onInsert: (r: LiveRange) => void; onClose: () => void;
}) {
  const { data: vocabulary } = useVocabulary();
  const sets = useQuery('listOntologyObjectSets', { query: {} });
  const [setId, setSetId] = useState('');
  const [chosen, setChosen] = useState<string[]>([]);
  const [limit, setLimit] = useState('200');
  const set = sets.data?.objectSets.find((s) => s.id === setId);
  const type = vocabulary?.objectTypes.find((t) => t.id === set?.baseTypeId);
  const n = Math.max(1, Math.min(1000, Number(limit) || 1));
  return (
    <Dialog open onClose={onClose} title={`A live range at ${anchor}`} size="md"
      description="The set's objects, read for whoever opens the workbook, from this cell down: a header of property names, then a row each.">
      <form className={styles.form} onSubmit={(e) => {
        e.preventDefault();
        if (setId === '' || chosen.length === 0) return;
        onInsert({ id: `range-${existing + 1}-${Date.now().toString(36)}`, sheetId, anchor, objectSetId: setId, propertyIds: chosen, limit: n });
      }}>
        {sets.error !== undefined ? <ErrorMessage error={sets.error} onRetry={sets.refetch} /> : null}
        <SelectField label="Object set" required value={setId} placeholder={sets.data === undefined ? 'Listing…' : 'Choose a saved set'}
          onChange={(e) => {
            setSetId(e.target.value);
            setChosen([]);
          }} options={(sets.data?.objectSets ?? []).map((s) => ({ value: s.id, label: s.name }))}
          hint={sets.data !== undefined && sets.data.objectSets.length === 0 ? 'Save an object set in Explorer first.' : undefined} />
        {type !== undefined ? (
          <fieldset className={styles.fieldset}>
            <legend>Columns</legend>
            <div className={styles.checks}>{type.properties.map((p) => (
              <Checkbox key={p.identityId} label={p.displayName} checked={chosen.includes(p.identityId)}
                onChange={(e) => setChosen(e.target.checked ? [...chosen, p.identityId] : chosen.filter((x) => x !== p.identityId))} />
            ))}</div>
          </fieldset>
        ) : null}
        <TextField label="At most" type="number" min={1} max={1000} value={limit} onChange={(e) => setLimit(e.target.value)} hint="Up to 1,000 rows." />
        <FormActions>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={setId === '' || chosen.length === 0}>Place it</Button>
        </FormActions>
      </form>
    </Dialog>
  );
}
