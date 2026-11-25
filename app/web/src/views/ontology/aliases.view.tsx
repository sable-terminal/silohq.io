'use client';

// Field aliases (spec 22.3): a person's name for a connection's field, which derivation and the
// model use in place of a cryptic one (KUNNR as "Customer number"). Each field with its profile,
// counts only; an alias is set or removed per field.

import { useMemo, useState } from 'react';
import { Button } from '../../components/button.component.tsx';
import { Dialog } from '../../components/dialog.component.tsx';
import { FormActions, SelectField, TextField } from '../../components/field.component.tsx';
import { Page, Toolbar } from '../../components/page.component.tsx';
import { QueryView } from '../../components/query.component.tsx';
import { SearchInput } from '../../components/search.component.tsx';
import { EmptyState, ErrorMessage } from '../../components/states.component.tsx';
import { DataTable } from '../../components/table.component.tsx';
import { useToast } from '../../components/toast.component.tsx';
import { useMutation, useQuery } from '../../data/query.data.ts';
import { useDirectory } from '../../hooks/directory.hook.ts';
import { useParams } from '../../hooks/params.hook.ts';
import { usePageContext } from '../../shell/context.shell.tsx';
import { formatNumber } from '../../utils/format.util.ts';
import styles from './ontology.view.module.css';

type Row = { sourceObject: string; fieldPath: string; rows: number | null; distinct: number | null; alias: { id: string; alias: string; declaredBy: string } | undefined };

export function Aliases() {
  const say = useToast();
  const people = useDirectory();
  const [params, set] = useParams();
  const connections = useQuery('listConnections', { query: { limit: 500 } });
  const live = (connections.data?.connections ?? []).filter((c) => c.status !== 'revoked');
  const connectionId = params.get('connection') ?? live[0]?.id;
  const profiles = useQuery('listOntologyFieldProfiles', connectionId === undefined ? null : { params: { connectionId }, query: {} });
  const aliases = useQuery('listOntologyFieldAliases', connectionId === undefined ? null : { query: { connectionId } });
  const setAlias = useMutation('setOntologyFieldAlias', { invalidates: ['listOntologyFieldAliases'] });
  const remove = useMutation('removeOntologyFieldAlias', { invalidates: ['listOntologyFieldAliases'] });
  const [editing, setEditing] = useState<Row | undefined>(undefined);
  const [text, setText] = useState('');
  const q = (params.get('q') ?? '').toLowerCase();
  usePageContext({ scope: { kind: 'page', page: 'ontology' }, scopeLabel: 'Field aliases' });
  const rows = useMemo<Row[]>(() => {
    // An alias names a column of the connection (the field as its manifest names it), wherever it appears.
    const named = new Map((aliases.data?.aliases ?? []).filter((a) => a.connectionId === connectionId).map((a) => [a.fieldPath, { id: a.id, alias: a.alias, declaredBy: a.declaredBy }]));
    const out: Row[] = (profiles.data?.profiles ?? []).map((p) => ({ sourceObject: p.sourceObject, fieldPath: p.fieldPath, rows: p.rowCount, distinct: p.distinctCount, alias: named.get(p.fieldPath) }));
    const seen = new Set(out.map((r) => r.fieldPath));
    for (const [fieldPath, alias] of named) if (!seen.has(fieldPath)) out.push({ sourceObject: '', fieldPath, rows: null, distinct: null, alias });
    return out.filter((r) => q === '' || r.fieldPath.toLowerCase().includes(q) || r.sourceObject.toLowerCase().includes(q) || (r.alias?.alias.toLowerCase().includes(q) ?? false));
  }, [profiles.data, aliases.data, q]);
  return (
    <Page title="Field aliases" description="Plain names for a system's cryptic fields, used when types are derived and wherever the field is named." crumbs={[{ label: 'Ontology' }]}>
      <Toolbar>
        <SelectField label="Connection" hideLabel value={connectionId ?? ''} onChange={(e) => set({ connection: e.target.value })} options={live.map((c) => ({ value: c.id, label: c.name }))}
          placeholder={live.length === 0 ? 'No connection yet' : undefined} />
        <SearchInput label="Find a field" value={params.get('q') ?? ''} onChange={(v) => set({ q: v })} />
      </Toolbar>
      <QueryView query={profiles} what="Fields" isEmpty={() => rows.length === 0}
        empty={<EmptyState icon="edit" title="No fields known yet">Profile the connection in Derive to list its fields.</EmptyState>}>
        {() => (
          <DataTable label="Fields" rows={rows} rowKey={(r) => `${r.sourceObject}.${r.fieldPath}`} columns={[
            { id: 'field', header: 'Field', primary: true, sortValue: (r) => `${r.sourceObject}.${r.fieldPath}`, cell: (r) => <span className={styles.mono}>{r.sourceObject !== '' ? `${r.sourceObject}.` : ''}{r.fieldPath}</span> },
            { id: 'alias', header: 'Alias', sortValue: (r) => r.alias?.alias ?? '', cell: (r) => (r.alias === undefined ? <span className={styles.muted}>—</span>
              : <span className={styles.stackTight}><strong>{r.alias.alias}</strong><span className={styles.muted}>{people.nameOf(r.alias.declaredBy)}</span></span>) },
            { id: 'rows', header: 'Values', width: 'sm', align: 'end', cell: (r) => (r.rows === null ? '—' : formatNumber(r.rows)) },
            { id: 'distinct', header: 'Distinct', width: 'sm', align: 'end', cell: (r) => (r.distinct === null ? '—' : formatNumber(r.distinct)) },
            { id: 'act', header: <span className="visually-hidden">Change</span>, width: 'md', align: 'end', cell: (r) => (
              <span className={styles.row}>
                <Button size="sm" variant="ghost" blocked={setAlias.blocked} onClick={() => {
                  setEditing(r);
                  setText(r.alias?.alias ?? '');
                }}>{r.alias === undefined ? 'Name it' : 'Rename'}</Button>
                {r.alias !== undefined ? <Button size="sm" variant="ghost" blocked={remove.blocked} onClick={async () => {
                  const done = await remove.run({ params: { aliasId: r.alias!.id } });
                  if (done.ok) say('Alias removed');
                }}>Remove</Button> : null}
              </span>
            ) },
          ]} />
        )}
      </QueryView>
      {remove.error !== undefined ? <ErrorMessage error={remove.error} /> : null}
      <Dialog open={editing !== undefined} onClose={() => setEditing(undefined)} title={`Name ${editing?.fieldPath ?? 'the field'}`} size="sm" busy={setAlias.pending}>
        <form className={styles.form} onSubmit={async (event) => {
          event.preventDefault();
          const r = await setAlias.run({ body: { connectionId: connectionId!, fieldPath: editing!.fieldPath, alias: text.trim() } });
          if (r.ok) {
            say('Alias saved');
            setEditing(undefined);
          }
        }}>
          <TextField label="Alias" required value={text} onChange={(e) => setText(e.target.value)} data-autofocus placeholder="Customer number" />
          {setAlias.error !== undefined ? <ErrorMessage error={setAlias.error} /> : null}
          <FormActions><Button onClick={() => setEditing(undefined)}>Cancel</Button><Button type="submit" variant="primary" pending={setAlias.pending} disabled={text.trim() === ''}>Save</Button></FormActions>
        </form>
      </Dialog>
    </Page>
  );
}
