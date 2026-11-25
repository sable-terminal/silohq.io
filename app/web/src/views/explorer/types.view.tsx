'use client';

// Object types (spec 34.1): the types the person may see, grouped by interface; one type's
// objects under the person's filters, as a set the federated engine resolves within bounds; and
// a saved object set, run again as the person who opens it. A result over the bounds is refused
// with the bound and the count stated, and the facets are there to narrow it: Explorer never
// shows the first members of an unbounded set as if they were the set. What is shown lives in
// the address (?type=, ?f= filters, ?s= order, ?view=), so any result can be linked to.

import Link from 'next/link';
import { useEffect, useState, type FormEvent } from 'react';
import type { Output } from '../../api/client.api.ts';
import { Badge } from '../../components/badge.component.tsx';
import { Button, LinkButton } from '../../components/button.component.tsx';
import { Dialog } from '../../components/dialog.component.tsx';
import { FormActions, TextField } from '../../components/field.component.tsx';
import { Icon } from '../../components/icon.component.tsx';
import { Page } from '../../components/page.component.tsx';
import { QueryView } from '../../components/query.component.tsx';
import { RefusalNotice } from '../../components/refusal.component.tsx';
import { SearchInput } from '../../components/search.component.tsx';
import { EmptyState, ErrorMessage, Loading } from '../../components/states.component.tsx';
import { useToast } from '../../components/toast.component.tsx';
import { useMutation, useQuery } from '../../data/query.data.ts';
import { useParams } from '../../hooks/params.hook.ts';
import { titleOf, useVocabulary, type ObjectType, type Property, type Vocabulary } from '../../hooks/vocabulary.hook.ts';
import { objectHref, typeHref } from '../../navigation/links.navigation.ts';
import { usePageContext, useWorkspace } from '../../shell/context.shell.tsx';
import { formatNumber, plural } from '../../utils/format.util.ts';
import { hrefWith } from '../../utils/href.util.ts';
import {
  facetable, filtersFromParam, filtersToParam, LISTED, NUMERIC, objectsPlan, predicateOf, rangePlan, TEMPORAL, valuesPlan, type Filter, type Sort,
} from '../../utils/plan.util.ts';
import { formatValue, stateText, type ValueState } from '../../utils/value.util.ts';
import styles from './types.view.module.css';

type Result = Extract<Output<'runStructuredPlan'>, { outcome: 'answer' }>['result'];
type ResultObject = Result['page']['objects'][number];

// ----------------------------------------------------------------------------- the types

function TypeList({ vocabulary, current }: { vocabulary: Vocabulary; current: string | undefined }) {
  const [filter, setFilter] = useState('');
  const words = filter.toLowerCase();
  const matches = (t: ObjectType) => words === '' || `${t.displayName} ${t.pluralName} ${t.apiName}`.toLowerCase().includes(words);
  const grouped = vocabulary.interfaces.map((i) => ({ title: i.displayName, types: vocabulary.objectTypes.filter((t) => t.interfaces.includes(i.id) && matches(t)) }))
    .filter((g) => g.types.length > 0);
  const others = vocabulary.objectTypes.filter((t) => t.interfaces.length === 0 && matches(t));
  const groups = [...grouped, ...(others.length > 0 ? [{ title: grouped.length > 0 ? 'Other types' : 'Object types', types: others }] : [])];
  return (
    <nav className={styles.types} aria-label="Object types">
      <SearchInput label="Find a type" value={filter} onChange={setFilter} delayMs={0} />
      {groups.map((g) => (
        <div key={g.title} className={styles.typeGroup}>
          <h2 className={styles.typeGroupTitle}>{g.title}</h2>
          <ul>
            {[...g.types].sort((a, b) => a.pluralName.localeCompare(b.pluralName)).map((t) => (
              <li key={t.id}>
                <Link href={typeHref(t.id) as never} aria-current={current === t.id ? 'page' : undefined} className={styles.typeLink} title={t.description ?? undefined}>
                  <Icon name="object" size={14} />{t.pluralName}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      ))}
      {groups.length === 0 ? <p className={styles.muted}>{filter === '' ? 'No object type is available to you yet.' : 'No type matches.'}</p> : null}
    </nav>
  );
}

// ----------------------------------------------------------------------------- facets

function Facet({ type, property, filters, ontologyVersionId, onChange }: {
  type: ObjectType; property: Property; filters: Filter[]; ontologyVersionId: string; onChange: (filters: Filter[]) => void;
}) {
  const own = filters.filter((f) => f.property === property.identityId);
  const others = filters.filter((f) => f.property !== property.identityId);
  const [open, setOpen] = useState(own.length > 0);
  const listed = LISTED.has(property.dataType);
  const { plan, parameters } = listed ? valuesPlan(ontologyVersionId, type, property.identityId, others) : rangePlan(ontologyVersionId, type, property.identityId, others);
  // The facet's counts follow the other filters only; read when it is open.
  const counts = useQuery('runStructuredPlan', open ? { body: { plan, parameters } } : null, { staleMs: 60_000, keepPrevious: true });
  const reply = counts.data;
  const refused = reply !== undefined && reply.outcome !== 'answer' ? (reply.outcome === 'refusal' ? reply.refusal.reason : 'counts are not available') : undefined;
  const groups = reply?.outcome === 'answer' ? reply.result.page.groups : [];
  const values = listed ? groups.filter((g) => g.key[property.apiName] !== null && g.key[property.apiName] !== undefined)
    .map((g) => ({ value: g.key[property.apiName] as string | number | boolean, n: g.measures['n'] ?? 0 })) : [];
  const range = !listed && groups[0] !== undefined ? { low: groups[0].measures['low'], high: groups[0].measures['high'], n: groups[0].measures['n'] ?? 0 } : undefined;

  const chosen = new Set(own.flatMap((f) => (f.op === 'in' ? f.values : f.op === 'eq' ? [f.value] : [])).map(String));
  const toggle = (value: string | number | boolean) => {
    const next = new Set(chosen);
    if (next.has(String(value))) next.delete(String(value));
    else next.add(String(value));
    const picked = values.map((v) => v.value).filter((v) => next.has(String(v)));
    onChange([...others, ...(picked.length === 0 ? [] : [property.dataType === 'boolean' && picked.length === 1
      ? { property: property.identityId, op: 'eq' as const, value: picked[0]! }
      : { property: property.identityId, op: 'in' as const, values: picked }])]);
  };
  const bound = (op: 'gte' | 'lte', raw: string) => {
    const rest = own.filter((f) => f.op !== op);
    if (raw === '') {
      onChange([...others, ...rest]);
      return;
    }
    const value = NUMERIC.has(property.dataType) ? Number(raw) : property.dataType === 'timestamp' ? new Date(`${raw}T${op === 'gte' ? '00:00:00' : '23:59:59.999'}Z`).toISOString() : raw;
    if (typeof value === 'number' && Number.isNaN(value)) return;
    onChange([...others, ...rest, { property: property.identityId, op, value }]);
  };
  const boundOf = (op: 'gte' | 'lte') => {
    const f = own.find((x) => x.op === op);
    if (f === undefined || !('value' in f)) return '';
    return typeof f.value === 'string' && property.dataType === 'timestamp' ? f.value.slice(0, 10) : String(f.value);
  };

  return (
    <div className={styles.facet}>
      <button type="button" className={styles.facetHead} aria-expanded={open} onClick={() => setOpen(!open)}>
        <Icon name={open ? 'chevronDown' : 'chevronRight'} size={14} />
        <span className={styles.facetName}>{property.displayName}</span>
        {own.length > 0 ? <Badge tone="accent">filtered</Badge> : null}
      </button>
      {open ? (
        <div className={styles.facetBody}>
          {counts.status === 'loading' ? <Loading label="Counting" block={false} delayMs={150} /> : null}
          {counts.status === 'error' ? <ErrorMessage error={counts.error} onRetry={counts.refetch} /> : null}
          {refused !== undefined ? <p className={styles.muted}>Shown without counts: {refused}.</p> : null}
          {listed && reply?.outcome === 'answer' ? (
            <ul className={styles.values}>
              {values.map(({ value, n }) => (
                <li key={String(value)}>
                  <label className={styles.value}>
                    <input type="checkbox" checked={chosen.has(String(value))} onChange={() => toggle(value)} />
                    <span className={styles.valueText}>{formatValue(property.dataType, value)}</span>{' '}
                    <span className={styles.count}>{formatNumber(n)}</span>
                  </label>
                </li>
              ))}
              {values.length === 0 ? <li className={styles.muted}>No values.</li> : null}
            </ul>
          ) : null}
          {listed && refused !== undefined && property.dataType !== 'boolean' ? (
            <label className={styles.rangeField}>Is
              <input defaultValue={[...chosen][0] ?? ''} onBlur={(e) => onChange([...others, ...(e.target.value.trim() === '' ? []
                : [{ property: property.identityId, op: 'eq' as const, value: e.target.value.trim() }])])} />
            </label>
          ) : null}
          {NUMERIC.has(property.dataType) || TEMPORAL.has(property.dataType) ? (
            <div className={styles.range}>
              {range !== undefined && range.n > 0 ? <p className={styles.muted}>From {formatValue(property.dataType, range.low)} to {formatValue(property.dataType, range.high)}</p> : null}
              <label className={styles.rangeField}>At least
                <input type={TEMPORAL.has(property.dataType) ? 'date' : 'number'} defaultValue={boundOf('gte')} onBlur={(e) => bound('gte', e.target.value)} />
              </label>
              <label className={styles.rangeField}>At most
                <input type={TEMPORAL.has(property.dataType) ? 'date' : 'number'} defaultValue={boundOf('lte')} onBlur={(e) => bound('lte', e.target.value)} />
              </label>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function Facets({ type, filters, ontologyVersionId, onChange }: { type: ObjectType; filters: Filter[]; ontologyVersionId: string; onChange: (filters: Filter[]) => void }) {
  const properties = facetable(type);
  return (
    <aside className={styles.facets} aria-label={`Filters for ${type.pluralName}`}>
      <div className={styles.facetsHead}>
        <h2 className={styles.subTitle}>Filters</h2>
        {filters.length > 0 ? <Button size="sm" variant="link" onClick={() => onChange([])}>Clear all</Button> : null}
      </div>
      {properties.map((p) => <Facet key={p.identityId} type={type} property={p} filters={filters} ontologyVersionId={ontologyVersionId} onChange={onChange} />)}
      {properties.length === 0 ? <p className={styles.muted}>No property of this type can be filtered by you.</p> : null}
    </aside>
  );
}

// ----------------------------------------------------------------------------- results

/** A result's objects with their states (a disputed value is never resolved here), paged while the result lives, sortable by its own columns. */
function ObjectResults({ result, sort, onSort }: { result: Result; sort: Sort | undefined; onSort: (sort: Sort) => void }) {
  const [index, setIndex] = useState(0);
  useEffect(() => setIndex(0), [result.queryId]);
  const later = useQuery('readResultPage', index === 0 ? null : { params: { queryId: result.queryId, page: index } }, { keepPrevious: true, staleMs: 10 * 60_000 });
  const rows: ResultObject[] = index === 0 ? result.page.objects : later.data?.objects ?? [];
  const count = Math.max(1, result.page.count);
  return (
    <div className={styles.tableWrap}>
      <table className={styles.table} aria-label="Objects">
        <thead>
          <tr>
            {result.columns.map((column) => {
              const sortable = column.effect === 'allow' && column.node === 0;
              const current = sort?.property === column.property ? sort.direction : undefined;
              return (
                <th key={`${column.node}.${column.property}`} scope="col" aria-sort={current === 'asc' ? 'ascending' : current === 'desc' ? 'descending' : sortable ? 'none' : undefined}>
                  {sortable ? (
                    <button type="button" className={styles.sort} onClick={() => onSort({ property: column.property, direction: current === 'asc' ? 'desc' : 'asc' })}>
                      {column.displayName}<Icon name={current === 'asc' ? 'chevronUp' : current === 'desc' ? 'chevronDown' : 'arrowUpDown'} size={12} />
                    </button>
                  ) : column.displayName}
                  {column.effect !== 'allow' ? <span className={styles.effect}> ({column.effect === 'mask' ? 'masked' : 'redacted'} for you)</span> : null}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {rows.map((object) => (
            <tr key={object.id}>
              {result.columns.map((column, i) => {
                const note = stateText(object.states[column.apiName] as ValueState | undefined);
                const text = note ?? formatValue(column.dataType, object.values[column.apiName]);
                return i === 0
                  ? <th key={column.apiName} scope="row" className={note === undefined ? undefined : styles.flagged}><Link href={objectHref({ objectTypeId: object.objectTypeId, objectId: object.id }) as never}>{text}</Link></th>
                  : <td key={column.apiName} className={note === undefined ? undefined : styles.flagged}>{text}</td>;
              })}
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length === 0 && later.status !== 'loading' ? <p className={styles.empty}>No objects match.</p> : null}
      {later.status === 'error' ? <ErrorMessage error={later.error} /> : null}
      {count > 1 ? (
        <nav className={styles.pager} aria-label="Pages of this result">
          <Button size="sm" icon="chevronLeft" disabled={index === 0} onClick={() => setIndex(index - 1)}>Previous</Button>
          <span>Page {index + 1} of {count}</span>
          <Button size="sm" iconEnd="chevronRight" disabled={index + 1 >= count} pending={later.fetching && index > 0} onClick={() => setIndex(index + 1)}>Next</Button>
        </nav>
      ) : null}
    </div>
  );
}

function SaveAsSet({ type, filters, open, onClose }: { type: ObjectType; filters: Filter[]; open: boolean; onClose: () => void }) {
  const say = useToast();
  const [, set] = useParams();
  const saveSet = useMutation('saveOntologyObjectSet', { invalidates: ['listOntologyObjectSets'] });
  const saveView = useMutation('saveWorkspaceView', { invalidates: ['listWorkspaceViews'] });
  const [name, setName] = useState(`${type.pluralName}${filters.length > 0 ? ' (filtered)' : ''}`);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const made = await saveSet.run({
      body: { name: name.trim(), visibility: 'private', definition: { kind: 'filter', base: { objectTypeId: type.id }, predicate: predicateOf(type, filters) } },
    });
    if (!made.ok) return;
    const view = await saveView.run({ body: { kind: 'object_set', name: name.trim(), objectSetId: made.data.id } });
    if (!view.ok) return;
    say(`Saved as “${view.data.name}”.`);
    onClose();
    set({ view: view.data.id, type: undefined, f: undefined, s: undefined }, { push: true });
  };
  return (
    <Dialog open={open} onClose={onClose} title="Save as an object set" size="sm" busy={saveSet.pending || saveView.pending}
      description="It keeps the filters, not the objects, and is read again whenever it is opened. Private to you until you share it.">
      <form onSubmit={(e) => void submit(e)} className={styles.form}>
        <TextField label="Name" required maxLength={200} value={name} onChange={(e) => setName(e.target.value)} autoFocus />
        {saveSet.error !== undefined ? <ErrorMessage error={saveSet.error} /> : null}
        {saveView.error !== undefined ? <ErrorMessage error={saveView.error} /> : null}
        <FormActions>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" pending={saveSet.pending || saveView.pending} blocked={saveSet.blocked} disabled={name.trim() === ''}>Save</Button>
        </FormActions>
      </form>
    </Dialog>
  );
}

function TypeBrowser({ type, ontologyVersionId, filters, sort }: { type: ObjectType; ontologyVersionId: string; filters: Filter[]; sort: Sort | undefined }) {
  const [, set] = useParams();
  const [saving, setSaving] = useState(false);
  const { plan, parameters } = objectsPlan(ontologyVersionId, type, filters, sort);
  const run = useQuery('runStructuredPlan', { body: { plan, parameters } }, { keepPrevious: true, staleMs: 60_000 });
  const outcome = run.data;
  const answer = outcome?.outcome === 'answer' ? outcome.result : undefined;
  const change = (next: { filters?: Filter[]; sort?: Sort | undefined }) => set({
    f: (next.filters ?? filters).length === 0 ? undefined : filtersToParam(next.filters ?? filters),
    s: ('sort' in next ? next.sort : sort) === undefined ? undefined : `${('sort' in next ? next.sort : sort)!.direction === 'desc' ? '-' : ''}${('sort' in next ? next.sort : sort)!.property}`,
  }, { push: true });
  return (
    <div className={styles.browser}>
      <Facets type={type} filters={filters} ontologyVersionId={ontologyVersionId} onChange={(next) => change({ filters: next })} />
      <section className={styles.results} aria-labelledby="type-heading">
        <div className={styles.resultsHead}>
          <div>
            <h2 id="type-heading" className={styles.subTitle}>{type.pluralName}</h2>
            {answer !== undefined ? (
              <p className={styles.muted} role="status">
                {formatNumber(answer.population)} {answer.population === 1 ? type.displayName.toLowerCase() : type.pluralName.toLowerCase()}
                {filters.length > 0 ? ' match your filters' : ''}
                {answer.coverage.unmatched > 0 ? ` · ${plural(answer.coverage.unmatched, 'record')} stood alone for want of a match key` : ''}
                {answer.reduced ? ' · your access shaped this result' : ''}
                {run.previous ? ' · updating…' : ''}
              </p>
            ) : null}
          </div>
          {answer !== undefined ? <Button icon="star" onClick={() => setSaving(true)}>Save as object set</Button> : null}
          <LinkButton icon="chart" href={hrefWith('/explorer/analyses/', { type: type.id, f: filters.length === 0 ? undefined : filtersToParam(filters) })}>Analyse</LinkButton>
        </div>
        {run.status === 'error' && run.data === undefined ? <ErrorMessage error={run.error} onRetry={run.refetch} /> : null}
        {outcome === undefined && run.status !== 'error' ? <Loading label="Reading from the sources" /> : null}
        {outcome?.outcome === 'refusal' ? <RefusalNotice refusal={outcome.refusal} /> : null}
        {answer !== undefined ? <ObjectResults result={answer} sort={sort} onSort={(s) => change({ sort: s })} /> : null}
      </section>
      <SaveAsSet key={JSON.stringify(filters)} type={type} filters={filters} open={saving} onClose={() => setSaving(false)} />
    </div>
  );
}

// ----------------------------------------------------------------------------- a saved set, run again

const REFUSED: Record<string, string> = {
  bound_exceeded: 'it holds more objects than the bounds allow; narrow its filters', capability_missing: 'a source it reads cannot answer it',
  unsupported: 'this kind of set cannot be run yet', invalid_manifest: 'the ontology changed since it was saved, and it no longer fits', unavailable: 'a source it reads did not answer',
};

function SavedSet({ viewId, vocabulary }: { viewId: string; vocabulary: Vocabulary }) {
  const workspace = useWorkspace();
  const ran = useQuery('runWorkspaceView', { params: { viewId } }, { staleMs: 60_000 });
  const follows = useQuery('listFollows', {});
  const follow = useMutation('followResource', { invalidates: ['listFollows'] });
  const unfollow = useMutation('unfollowResource', { invalidates: ['listFollows'] });
  const [index, setIndex] = useState(0);
  const run = ran.data?.run;
  const page = useQuery('readResultPage', run?.outcome === 'result' ? { params: { queryId: run.resultRef, page: index } } : null, { keepPrevious: true, staleMs: 10 * 60_000 });
  if (ran.status === 'error') return <ErrorMessage error={ran.error} onRetry={ran.refetch} />;
  if (ran.data === undefined || run === undefined) return <Loading label="Running the view" />;
  const view = ran.data.view;
  const mine = view.ownerMembershipId === workspace.session.membershipId;
  const followId = follows.data?.follows.find((f) => f.resourceType === 'view' && f.resourceId === viewId)?.id;
  const titleText = (m: ResultObject) => {
    const type = vocabulary.objectTypes.find((t) => t.id === m.objectTypeId);
    const title = type === undefined ? undefined : titleOf(type);
    const value = title === undefined ? undefined : m.values[title.apiName];
    return value === undefined || value === null ? `${type?.displayName ?? 'Object'} (title not shown)` : String(value);
  };
  return (
    <section className={styles.results} aria-labelledby="view-heading">
      <div className={styles.resultsHead}>
        <div>
          <h2 id="view-heading" className={styles.subTitle}>{view.name}</h2>
          <p className={styles.muted}>{mine ? 'Your saved view' : 'Shared with you'} · read again now, as you{run.outcome === 'result' && run.reduced ? ' · part of it is not visible to you' : ''}</p>
        </div>
        {!mine && view.kind === 'object_set' && follows.data !== undefined ? (
          followId === undefined
            ? <Button icon="bell" pending={follow.pending} blocked={follow.blocked} onClick={() => void follow.run({ body: { resourceType: 'view', resourceId: viewId } })}>Follow</Button>
            : <Button icon="check" pending={unfollow.pending} onClick={() => void unfollow.run({ params: { followId } })}>Following</Button>
        ) : null}
      </div>
      {follow.error !== undefined ? <ErrorMessage error={follow.error} /> : null}
      {run.outcome === 'refused' ? <p className={styles.notice}><strong>Not shown:</strong> {REFUSED[run.reason] ?? run.reason}.</p> : null}
      {run.outcome === 'result' ? (
        page.data === undefined ? <Loading label="Reading" block={false} /> : (
          <>
            <ul className={styles.hits} aria-label={view.name}>
              {page.data.objects.map((m) => <li key={m.id}><Link href={objectHref({ objectTypeId: m.objectTypeId, objectId: m.id }) as never}>{titleText(m)}</Link></li>)}
            </ul>
            {page.data.objects.length === 0 ? <p className={styles.muted}>It holds no objects now.</p> : null}
            {page.data.count > 1 ? (
              <nav className={styles.pager} aria-label="Pages of this view">
                <Button size="sm" disabled={index === 0} onClick={() => setIndex(index - 1)}>Previous</Button>
                <span>Page {index + 1} of {page.data.count}</span>
                <Button size="sm" disabled={index + 1 >= page.data.count} onClick={() => setIndex(index + 1)}>Next</Button>
              </nav>
            ) : null}
          </>
        )
      ) : null}
    </section>
  );
}

// ----------------------------------------------------------------------------- the page

export function ObjectTypes() {
  const vocabulary = useVocabulary();
  const [params] = useParams();
  const typeId = params.get('type') ?? undefined;
  const viewId = params.get('view') ?? undefined;
  const filters = filtersFromParam(params.get('f'));
  const sortText = params.get('s');
  const sort: Sort | undefined = sortText === null ? undefined : { property: sortText.replace(/^-/, ''), direction: sortText.startsWith('-') ? 'desc' : 'asc' };
  const type = typeId === undefined ? undefined : vocabulary.data?.objectTypes.find((t) => t.id === typeId);
  usePageContext({ scope: { kind: 'page', page: 'explorer' }, scopeLabel: type?.pluralName ?? 'Explorer', status: filters.length > 0 ? `${plural(filters.length, 'filter')} applied` : undefined });
  return (
    <Page title="Object types" description="Every kind of object your systems hold. Choose a type to browse and narrow its objects; open any one of them."
      crumbs={[{ label: 'Explorer' }]} width="full"
      actions={<Link href={hrefWith('/explorer/search/', {}) as never}>Search across every type</Link>}>
      <QueryView query={vocabulary} what="What you may see">
        {(v) => (
          <div className={styles.layout}>
            <TypeList vocabulary={v} current={typeId} />
            <div className={styles.main}>
              {viewId !== undefined ? <SavedSet viewId={viewId} vocabulary={v} />
                : type !== undefined ? <TypeBrowser key={type.id} type={type} ontologyVersionId={v.ontologyVersionId} filters={filters} sort={sort} />
                : typeId !== undefined ? <EmptyState icon="lock" title="That type is not available to you">It may have been retired, or you may not have access to it.</EmptyState>
                : <EmptyState icon="object" title="Choose a type">Choose a type on the left to see its objects and narrow them with filters, or search across every type at once.</EmptyState>}
            </div>
          </div>
        )}
      </QueryView>
    </Page>
  );
}
