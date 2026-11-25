'use client';

// The Studio runtime's state (spec 35.2, 35.6): variable values held by the page, never members
// of a set (an object set variable is a definition, run for the viewer whenever a widget needs
// it); answers read whole, since the engine refuses rather than truncates, so a metric, chart or
// filter over one is over the whole set; and the app's expressions evaluated by Studio, never in
// the browser.

import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import type { AppDefinition, AppWidget } from '../../../../server/src/contracts/studio/definition.contract.ts';
import type { Output } from '../../api/client.api.ts';
import { useData } from '../../data/query.data.ts';

export type { AppDefinition, AppWidget };
export type Variable = AppDefinition['variables'][string];
export type RunOutcome = Output<'runAppVariable'>;
export type Answer = Extract<RunOutcome, { outcome: 'answer' }>['result'];
export type ResultObject = Answer['page']['objects'][number];
export type Scalar = string | number | boolean | null;
export type Of<K extends AppWidget['kind']> = Extract<AppWidget, { kind: K }>;
export interface Narrowing { facets: Record<string, string | null>; search: string }

/** A whole answer, every page read; or why there is none. */
export type Rows =
  | { state: 'loading' }
  | { state: 'answer'; objects: ResultObject[]; total: number; reduced: boolean; columns: Answer['columns'] }
  | { state: 'refusal'; reason: string }
  | { state: 'failed'; error: unknown };

export interface Runtime {
  appId: string;
  /** A draft's number when its author previews it. */
  version: number | undefined;
  definition: AppDefinition;
  parameters: Readonly<Record<string, Scalar>>;
  selections: Readonly<Record<string, readonly string[]>>;
  /** Narrowing a filter control applies to its target set: facet values and search, over the whole answer. */
  narrowing: Readonly<Record<string, Narrowing>>;
  visible: (widgetId: string) => boolean;
  refreshOf: (widgetId: string) => number;
  setParameter: (name: string, value: Scalar) => void;
  setNarrowing: (target: string, n: Narrowing) => void;
  emit: (widget: AppWidget, event: string, selection?: readonly string[]) => void;
}

export const RuntimeContext = createContext<Runtime | undefined>(undefined);
export function useRuntime(): Runtime {
  const r = useContext(RuntimeContext);
  if (r === undefined) throw new Error('a widget renders inside an app');
  return r;
}

/** The most pages of one answer read for a widget; the engine refuses a set larger than its bound before this. */
const PAGE_LIMIT = 200;

/** One object set variable's whole answer for the viewer, read again when the parameters change or the widget is refreshed. */
export function useRows(source: string, select: readonly string[], refresh = 0): Rows {
  const { api } = useData();
  const r = useRuntime();
  const [rows, setRows] = useState<Rows>({ state: 'loading' });
  const key = JSON.stringify([r.appId, source, [...select].sort(), r.parameters, r.version, refresh]);
  useEffect(() => {
    let live = true;
    setRows({ state: 'loading' });
    void (async () => {
      try {
        const out = await api.call('runAppVariable', {
          params: { appId: r.appId, variable: source },
          body: { ...(r.version === undefined ? {} : { version: r.version }), select: [...select], parameters: { ...r.parameters } },
        });
        if (!live) return;
        if (out.outcome === 'refusal') {
          setRows({ state: 'refusal', reason: out.refusal.reason });
          return;
        }
        const objects = [...out.result.page.objects];
        for (let i = 1; i < Math.min(out.result.page.count, PAGE_LIMIT); i += 1) {
          const next = await api.call('readResultPage', { params: { queryId: out.result.queryId, page: i } });
          if (!live) return;
          objects.push(...next.objects);
        }
        if (live) setRows({ state: 'answer', objects, total: out.result.total, reduced: out.result.reduced, columns: out.result.columns });
      } catch (error) {
        if (live) setRows({ state: 'failed', error });
      }
    })();
    return () => {
      live = false;
    };
    // The key carries every input.
  }, [key, api]);
  return useMemo(() => narrow(rows, r.narrowing[source]), [rows, r.narrowing, source]);
}

/** A filter control's narrowing over a whole answer: exact facet values and a search over the values shown. */
function narrow(rows: Rows, n: Narrowing | undefined): Rows {
  if (rows.state !== 'answer' || n === undefined) return rows;
  const byIdentity = new Map(rows.columns.map((c) => [c.property, c.apiName]));
  const search = n.search.trim().toLowerCase();
  const objects = rows.objects.filter((o) => Object.entries(n.facets).every(([identity, value]) => value === null || String(o.values[byIdentity.get(identity) ?? ''] ?? '') === value)
    && (search === '' || Object.values(o.values).some((v) => String(v ?? '').toLowerCase().includes(search))));
  return { ...rows, objects, total: objects.length };
}

/** The values expressions read: parameters as they are, selections as lists. */
export function valuesOf(parameters: Readonly<Record<string, Scalar>>, selections: Readonly<Record<string, readonly string[]>>): Record<string, Scalar | string[]> {
  return { ...parameters, ...Object.fromEntries(Object.entries(selections).map(([k, v]) => [k, [...v]])) };
}

/** The app's expressions for the current values: undefined until Studio answers (nothing conditional shows before). */
export function useExpressions(appId: string, version: number | undefined, definition: AppDefinition,
  parameters: Readonly<Record<string, Scalar>>, selections: Readonly<Record<string, readonly string[]>>) {
  const { api } = useData();
  const [result, setResult] = useState<Output<'evaluateAppExpressions'> | undefined>();
  const needed = definition.pages.some((p) => p.widgets.some((w) => w.visibleWhen !== undefined)) || definition.events.some((e) => e.condition !== undefined);
  const values = useMemo(() => valuesOf(parameters, selections), [parameters, selections]);
  const key = JSON.stringify(values);
  useEffect(() => {
    if (!needed) return;
    let live = true;
    api.call('evaluateAppExpressions', { params: { appId }, body: { ...(version === undefined ? {} : { version }), values: values as never } })
      .then((r) => live && setResult(r), () => live && setResult({ widgets: {}, events: {} }));
    return () => {
      live = false;
    };
    // The key carries the values.
  }, [key, appId, version, needed, api]);
  return { needed, result };
}

/** The first selected object of a selection variable, with its type. */
export function useSelected(source: string): { objectTypeId: string; objectId: string } | undefined {
  const r = useRuntime();
  const variable = r.definition.variables[source];
  const id = r.selections[source]?.[0];
  if (variable === undefined || variable.kind !== 'selection' || id === undefined) return undefined;
  return { objectTypeId: variable.objectTypeId, objectId: id };
}

/** An app variable's name as a person reads it: "openOrders" is "Open orders". */
export function labelOf(name: string): string {
  const spaced = name.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replaceAll('_', ' ').toLowerCase();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}
