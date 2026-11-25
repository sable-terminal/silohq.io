'use client';

// A result as chapter 31 says (31.2–31.6): one result object in three representations, Prose, View
// and Data, switched at no cost because nothing is fetched again; the View an archetype chosen by
// deterministic precedence with every other that fits offered, an override recorded with the
// result's structure (31.4, 31.9) and each person's choice of representation kept per saved view;
// the three flags in every representation; and the three moves on whatever is selected: its lineage,
// the records behind it, and acting on it. At tile size (37.6) a tile draws its archetype only where
// it is legible and meaningful, and otherwise falls back to Figure or Table and says so.

import Link from 'next/link';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Badge } from '../components/badge.component.tsx';
import { Button } from '../components/button.component.tsx';
import { SelectField } from '../components/field.component.tsx';
import { ResultTable } from '../components/result.component.tsx';
import { ErrorMessage, Loading } from '../components/states.component.tsx';
import { TabPanel, Tabs } from '../components/tabs.component.tsx';
import { useBlocked, useData, useQuery } from '../data/query.data.ts';
import { useVocabulary } from '../hooks/vocabulary.hook.ts';
import { objectHref } from '../navigation/links.navigation.ts';
import { hrefWith } from '../utils/href.util.ts';
import { formatDateTime, formatNumber, plural } from '../utils/format.util.ts';
import { formatValue, type DataType } from '../utils/value.util.ts';
import {
  CompositionView, ComparisonView, DistributionView, FigureView, GraphView, keyOfGroup, RankingView, SeriesView, type ChartProps,
} from './charts.result.tsx';
import { contextOf, proseOf, type Names } from './prose.result.ts';
import {
  ARCHETYPE_LABEL, chosenOf, defaultRepresentation, shapeOf, tileArchetype, type Archetype, type Result, type Shape,
} from './structure.result.ts';
import styles from './result.result.module.css';

type Representation = 'prose' | 'view' | 'data';
const REPRESENTATIONS: { id: Representation; label: string }[] = [{ id: 'prose', label: 'Prose' }, { id: 'view', label: 'View' }, { id: 'data', label: 'Data' }];
export type TileFallback = { from: Archetype; to: 'figure' | 'table'; reason: 'below_minimum_size' | 'not_meaningful' };

/** Names from the reader's vocabulary and the connections they may see; "a connection" where they may not. */
export function useResultNames(): Names {
  const { lookup } = useVocabulary();
  const blocked = useBlocked('listConnections');
  const connections = useQuery('listConnections', blocked === undefined ? { query: {} } : null, { staleMs: 5 * 60_000 });
  return useMemo(() => ({
    property: (id: string) => lookup?.propertyName(id),
    type: (id: string, many?: boolean) => lookup?.typeName(id, many),
    connection: (id: string) => connections.data?.connections.find((c) => c.id === id)?.name,
  }), [lookup, connections.data]);
}

function Archetypal({ archetype, ...props }: ChartProps & { archetype: Archetype }) {
  switch (archetype) {
    case 'figure': return <FigureView {...props} />;
    case 'ranking': return <RankingView {...props} />;
    case 'series': return <SeriesView {...props} />;
    case 'distribution': return <DistributionView {...props} />;
    case 'composition': return <CompositionView {...props} />;
    case 'comparison': return <ComparisonView {...props} />;
    case 'chain': case 'hierarchy': case 'network': return <GraphView {...props} archetype={archetype} />;
    case 'table': return <ResultTable page={{ queryId: props.result.queryId, ...props.result.page }} selected={props.selected} label="Result" />;
  }
}

/** The three flags (31.6), each a sign and a word, in every representation. */
function Flags({ result }: { result: Result }) {
  const disputed = Object.values(result.coverage.disputed).reduce((a, b) => a + b, 0);
  const unchecked = Object.values(result.coverage.unchecked).reduce((a, b) => a + b, 0);
  const incomplete = result.coverage.unmatched + result.coverage.excludedByDispute + unchecked;
  const served = result.lineage.find((l) => l.servedBy !== undefined)?.servedBy;
  if (disputed === 0 && incomplete === 0 && served === undefined && !result.reduced && result.branch === undefined) return null;
  return (
    <div className={styles.flags} role="list" aria-label="Flags">
      {disputed > 0 ? <span role="listitem"><Badge tone="warn" icon="warning">Disagreement: {plural(disputed, 'value')}</Badge></span> : null}
      {incomplete > 0 ? <span role="listitem"><Badge tone="info" icon="info">Incomplete: {plural(incomplete, 'value')} not counted</Badge></span> : null}
      {served !== undefined ? <span role="listitem"><Badge tone="info" icon="clock">From the {served.kind === 'index' ? 'Object Index' : 'Warehouse'}, {formatDateTime(served.asOf)}</Badge></span> : null}
      {result.reduced ? <span role="listitem"><Badge icon="lock">Some values not visible to you</Badge></span> : null}
      {result.branch !== undefined ? <span role="listitem"><Badge tone="accent" icon="branch">On a {result.branch.kind} branch</Badge></span> : null}
    </div>
  );
}

/** The three moves on a selection (31.5): where it came from, the records behind it, and acting on it. */
function Selected({ result, shape, names, selection, onClear, actions }: {
  result: Result; shape: Shape; names: Names; selection: string; onClear: () => void; actions?: SelectionActions | undefined;
}) {
  const { lookup } = useVocabulary();
  const object = result.page.objects.find((o) => o.id === selection);
  const group = object === undefined ? result.page.groups.find((g) => keyOfGroup(g.key) === selection) : undefined;
  if (object === undefined && group === undefined) return null;
  const label = object !== undefined
    ? (result.columns[0] !== undefined ? formatValue(result.columns[0].dataType as DataType, object.values[result.columns[0].apiName]) : 'The object')
    : Object.entries(group!.key).map(([api, v]) => `${result.columns.find((c) => c.apiName === api)?.displayName ?? api}: ${v === null ? 'none' : formatValue(result.columns.find((c) => c.apiName === api)?.dataType as DataType | undefined, v)}`).join(', ') || 'Everything';
  // The records behind a group: its root type in Explorer, narrowed to the group's key.
  const rootType = object?.objectTypeId ?? (() => {
    const first = result.columns[0]?.property ?? result.measures.find((m) => m.property !== undefined)?.property;
    return first === undefined ? undefined : [...(lookup?.types.values() ?? [])].find((t) => t.properties.some((p) => p.identityId === first))?.id;
  })();
  const filters = group === undefined ? [] : Object.entries(group.key).flatMap(([api, v]) => {
    const column = result.columns.find((c) => c.apiName === api);
    if (column === undefined) return [];
    return [v === null || v === undefined ? { property: column.property, op: 'is_null' } : { property: column.property, op: 'eq', value: v }];
  });
  const sources = result.lineage.filter((l) => l.node === 0).flatMap((l) => l.sources.map((s) => ({ ...s, property: names.property(l.propertyIdentityId) ?? l.propertyApiName })));
  return (
    <section className={styles.selection} aria-label="Selected">
      <div className={styles.selectionHead}>
        <strong>{label}</strong>
        <Button size="sm" variant="ghost" onClick={onClear}>Clear</Button>
      </div>
      {group !== undefined ? <span className={styles.muted}>{plural(group.objects, 'object')}{result.measures.map((m) => `; ${m.as.replaceAll('_', ' ')} ${formatNumber(group.measures[m.as] ?? null, 2)}`).join('')}</span> : null}
      {sources.length > 0 ? (
        <details>
          <summary>Where it came from</summary>
          <ul className={styles.sources}>
            {sources.slice(0, 12).map((s, i) => (
              <li key={i}>{s.property}: {names.connection(s.connectionId) ?? 'a connection'}, {s.sourceObject}.{s.fieldPath} (connector {s.connectorVersion}), read {formatDateTime(s.readAt)}{s.pushdown.aggregate ? '; computed by the system' : ''}</li>
            ))}
          </ul>
        </details>
      ) : null}
      <div className={styles.moves}>
        {object !== undefined ? <Link href={objectHref({ objectTypeId: object.objectTypeId, objectId: object.id }) as never}>Open the object, its records and its Actions</Link> : null}
        {group !== undefined && rootType !== undefined && shape.whole ? <Link href={hrefWith('/explorer/types/', { type: rootType, f: filters.length > 0 ? JSON.stringify(filters) : undefined }) as never}>Open the objects behind it</Link> : null}
        {actions?.(group !== undefined ? { group: group.key } : { object: object!.id })}
      </div>
    </section>
  );
}

/** A page's own moves on a selection: a group's key, or an object's id. */
export type SelectionActions = (selection: { group?: Record<string, unknown>; object?: string }) => React.ReactNode;

export interface ResultViewProps {
  result: Result;
  label: string;
  /** A saved view's result: the person's choice of representation is kept for it. */
  savedViewId?: string | undefined;
  /** Drawn as a dashboard tile of this many grid cells: the View only, falling back where it must. */
  tile?: { w: number; h: number } | undefined;
  onTileFallback?: ((fallback: TileFallback) => void) | undefined;
  /** Where the full view opens, for a tile. */
  openHref?: string | undefined;
  selectionActions?: SelectionActions | undefined;
}

export function ResultView({ result, label, savedViewId, tile, onTileFallback, openHref, selectionActions }: ResultViewProps) {
  const { api } = useData();
  const names = useResultNames();
  const group = `r${useId().replace(/[^a-zA-Z0-9]/g, '')}-`;
  const shape = useMemo(() => shapeOf(result), [result]);
  const chosen = chosenOf(shape);
  const [override, setOverride] = useState<Archetype | undefined>();
  const shown = override !== undefined && shape.fits.includes(override) ? override : chosen;
  const [selection, setSelection] = useState<string | undefined>();
  const [index, setIndex] = useState(0);
  const preference = useQuery('readViewPreference', savedViewId !== undefined && tile === undefined ? { query: { savedViewId } } : null);
  const [representation, setRepresentation] = useState<Representation | undefined>();
  const current: Representation = representation ?? (preference.data?.preferredRepresentation as Representation | null | undefined) ?? defaultRepresentation(chosen);
  const page = useQuery('readResultPage', index > 0 ? { params: { queryId: result.queryId, page: index } } : null, { keepPrevious: true });
  const dataPage = index === 0 ? { queryId: result.queryId, ...result.page } : page.data;

  // The render record (31.4, 31.9): what was chosen and offered, once per result; an override when made.
  const recorded = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (tile !== undefined || recorded.current === result.queryId) return;
    recorded.current = result.queryId;
    void api.call('recordRenderSelection', { body: {
      surface: 'view', resultRef: result.queryId, resultStructure: shape.structure, chosen, alternativesOffered: shape.fits.filter((a) => a !== chosen),
    } }).catch(() => undefined);
  }, [api, result.queryId, shape, chosen, tile]);
  const overrideTo = (next: Archetype) => {
    setOverride(next === chosen ? undefined : next);
    if (next !== chosen) {
      void api.call('recordRenderSelection', { body: {
        surface: 'view', resultRef: result.queryId, resultStructure: shape.structure, chosen, alternativesOffered: shape.fits.filter((a) => a !== chosen), overriddenTo: next,
      } }).catch(() => undefined);
    }
  };
  const choose = (next: Representation) => {
    setRepresentation(next);
    if (savedViewId !== undefined) void api.call('setViewPreference', { body: { savedViewId, preferredRepresentation: next } }).catch(() => undefined);
  };

  // A tile: the archetype where it is legible and meaningful, otherwise Figure or Table, said once.
  const atTile = tile === undefined ? undefined : tileArchetype(shape, shown, tile);
  const reported = useRef(false);
  useEffect(() => {
    if (atTile?.fallback === undefined || reported.current) return;
    reported.current = true;
    onTileFallback?.(atTile.fallback);
  }, [atTile?.fallback, onTileFallback]);

  const props: ChartProps = { result, shape, names, selected: selection, onSelect: (k) => setSelection(k === selection ? undefined : k), compact: tile !== undefined };
  if (atTile !== undefined) {
    return (
      <div className={styles.result}>
        <Flags result={result} />
        <Archetypal archetype={atTile.archetype} {...props} />
        {atTile.fallback !== undefined ? (
          <span className={styles.muted}>Shown as {ARCHETYPE_LABEL[atTile.fallback.to].toLowerCase()}: a {ARCHETYPE_LABEL[atTile.fallback.from].toLowerCase()} {atTile.fallback.reason === 'below_minimum_size' ? 'needs a larger tile' : 'is not legible at tile size'}.</span>
        ) : null}
        {openHref !== undefined ? <Link href={openHref as never} className={styles.open}>Open the full view</Link> : null}
      </div>
    );
  }

  const sentences = proseOf(result, shape, names);
  const context = contextOf(result, names);
  return (
    <div className={styles.result}>
      <div className={styles.bar}>
        <Tabs label={`${label}: representation`} tabs={REPRESENTATIONS} current={current} onChange={choose} group={group} />
        {current === 'view' && shape.fits.length > 1 ? (
          <SelectField label="Show as" value={shown} onChange={(e) => overrideTo(e.target.value as Archetype)}
            options={shape.fits.map((a) => ({ value: a, label: a === chosen ? `${ARCHETYPE_LABEL[a]} (chosen for this shape)` : ARCHETYPE_LABEL[a] }))} />
        ) : null}
      </div>
      <Flags result={result} />
      <TabPanel id={current} group={group}>
        {current === 'prose' ? (
          <div className={styles.prose}>
            {sentences.slice(0, sentences.length - context.length).map((s, i) => <p key={i} className={i === 0 ? styles.lead : undefined}>{s}</p>)}
            {context.length > 0 ? <ul className={styles.context}>{context.map((s, i) => <li key={i}>{s}</li>)}</ul> : null}
          </div>
        ) : current === 'view' ? (
          <>
            {!shape.whole ? <p className={styles.muted}>The answer runs to {plural(result.page.count, 'page')}; it is drawn as a table, since a picture of part of it would mislead.</p> : null}
            <Archetypal archetype={shown} {...props} />
          </>
        ) : (
          <>
            {dataPage !== undefined ? <ResultTable page={dataPage} label={label} selected={selection} /> : page.status === 'error' ? <ErrorMessage error={page.error} onRetry={page.refetch} /> : <Loading label="Reading the page" block={false} />}
            {result.page.count > 1 ? (
              <div className={styles.pager}>
                <Button size="sm" disabled={index === 0} onClick={() => setIndex(index - 1)} icon="chevronLeft">Previous</Button>
                <span className={styles.muted}>Page {index + 1} of {result.page.count}</span>
                <Button size="sm" disabled={index + 1 >= result.page.count} onClick={() => setIndex(index + 1)} iconEnd="chevronRight">Next</Button>
              </div>
            ) : null}
          </>
        )}
      </TabPanel>
      {selection !== undefined ? <Selected result={result} shape={shape} names={names} selection={selection} onClear={() => setSelection(undefined)} actions={selectionActions} /> : null}
      {current !== 'prose' && context.length > 0 ? (
        <details className={styles.context}>
          <summary>What shaped this answer</summary>
          <ul>{context.map((s, i) => <li key={i}>{s}</li>)}</ul>
        </details>
      ) : null}
    </div>
  );
}

/** A result by its reference: read again from the data plane (header and first page), or said to have expired. */
export function ResultByRef({ queryId, expired, ...rest }: Omit<ResultViewProps, 'result'> & { queryId: string; expired?: (error: unknown) => React.ReactNode }) {
  const read = useQuery('readResult', { params: { queryId } }, { staleMs: 10 * 60_000 });
  if (read.data !== undefined) return <ResultView result={read.data} {...rest} />;
  if (read.status === 'error') return expired !== undefined ? <>{expired(read.error)}</> : <ErrorMessage error={read.error} onRetry={read.refetch} />;
  return <Loading label="Reading the answer" block={false} />;
}
