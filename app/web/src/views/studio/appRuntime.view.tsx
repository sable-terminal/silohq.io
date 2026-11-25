'use client';

// An app, opened (spec 35.2, 35.5, 35.6). Studio re-resolves it for the viewer: what they may not
// see is dropped and counted, a widget whose binding is unavailable is an empty frame saying why,
// an Action they may not submit is disabled with the reason. The page holds the variables' values;
// an event's effects come from the closed set (set or clear a variable, navigate, open an object
// view, open an Action form, open Ask, refresh a widget), at most eight, after its condition, which
// Studio evaluates. A draft opens here as its author's preview.

import { useRouter } from 'next/navigation';
import { useCallback, useMemo, useState } from 'react';
import type { Output } from '../../api/client.api.ts';
import { Badge } from '../../components/badge.component.tsx';
import { Banner } from '../../components/banner.component.tsx';
import { IconButton, LinkButton } from '../../components/button.component.tsx';
import { Dialog } from '../../components/dialog.component.tsx';
import { Menu } from '../../components/menu.component.tsx';
import { Page } from '../../components/page.component.tsx';
import { QueryView } from '../../components/query.component.tsx';
import { TabPanel, Tabs, type TabDef } from '../../components/tabs.component.tsx';
import { useToast } from '../../components/toast.component.tsx';
import { useData, useMutation, useQuery } from '../../data/query.data.ts';
import { useParam } from '../../hooks/params.hook.ts';
import { appEditorHref, appHref, objectHref } from '../../navigation/links.navigation.ts';
import { usePageContext } from '../../shell/context.shell.tsx';
import { plural } from '../../utils/format.util.ts';
import { AskPanel, CanvasEmbed, MapWidget, ScenarioControl } from './embeds.view.tsx';
import grid from './grid.view.module.css';
import { NameDialog } from './kit.view.tsx';
import { RuntimeContext, useExpressions, valuesOf, type AppDefinition, type AppWidget, type Narrowing, type Runtime, type Scalar } from './runtime.view.ts';
import styles from './studio.view.module.css';
import {
  ActionWidget, AppActionForm, ApprovalInbox, Chart, FilterControls, Markdown, Metric, ObjectList, ObjectTable, ObjectViewEmbed, ParameterControl, PropertyList, Timeline, UnknownWidget,
} from './widgets.view.tsx';

type Opened = Output<'openApp'>;

export function AppRuntime({ appId, version }: { appId: string; version: number | undefined }) {
  const opened = useQuery('openApp', { params: { appId }, query: version === undefined ? {} : { version } });
  usePageContext({ scope: { kind: 'app', appId }, scopeLabel: opened.data?.app.name ?? 'this app' });
  if (opened.data === undefined) {
    return (
      <Page title="App" crumbs={[{ label: 'Studio' }, { label: 'Apps', href: '/studio/apps/' }]}>
        <QueryView query={opened} what="The app">{() => null}</QueryView>
      </Page>
    );
  }
  return <OpenApp key={`${appId}:${version ?? ''}`} opened={opened.data} version={version} />;
}

function OpenApp({ opened, version }: { opened: Opened; version: number | undefined }) {
  const router = useRouter();
  const say = useToast();
  const { api } = useData();
  const definition = opened.definition as unknown as AppDefinition;
  const appId = opened.app.id;
  const [pageParam, setPageParam] = useParam('page');
  const [parameters, setParameters] = useState<Record<string, Scalar>>({});
  const [selections, setSelections] = useState<Record<string, readonly string[]>>({});
  const [narrowing, setNarrowingState] = useState<Record<string, Narrowing>>({});
  const [refresh, setRefresh] = useState<Record<string, number>>({});
  const [form, setForm] = useState<{ actionTypeId: string; objectTypeId: string | undefined; objectId: string | undefined } | undefined>();
  const [copying, setCopying] = useState(false);
  const copy = useMutation('copyApp', { invalidates: ['listApps'] });
  const expressions = useExpressions(appId, version, definition, parameters, selections);
  const status = useMemo(() => new Map(opened.widgets.map((w) => [w.id, w])), [opened.widgets]);

  const emit = useCallback((widget: AppWidget, event: string, selection?: readonly string[]) => {
    // The widget's own emit first: a selection lands in the variable it names.
    let next = selections;
    if (selection !== undefined && 'emits' in widget && widget.emits?.selectionChanged !== undefined) {
      next = { ...selections, [widget.emits.selectionChanged]: selection };
      setSelections(next);
    }
    const bindings = definition.events.map((e, i) => ({ e, i })).filter(({ e }) => e.source.widget === widget.id && e.source.event === event);
    if (bindings.length === 0) return;
    void (async () => {
      // Conditions are read against the values as the event left them.
      let holds: Record<string, boolean> = {};
      if (bindings.some(({ e }) => e.condition !== undefined)) {
        holds = (await api.call('evaluateAppExpressions', { params: { appId }, body: { ...(version === undefined ? {} : { version }), values: valuesOf(parameters, next) as never } })
          .catch(() => ({ events: {} as Record<string, boolean> }))).events;
      }
      for (const { e, i } of bindings) {
        if (e.condition !== undefined && holds[String(i)] !== true) continue;
        for (const effect of e.effects.slice(0, 8)) {
          switch (effect.kind) {
            case 'setVariable':
              if (definition.variables[effect.from]?.kind === 'selection') setSelections((s) => ({ ...s, [effect.variable]: next[effect.from] ?? [] }));
              else setParameters((p) => ({ ...p, [effect.variable]: parameters[effect.from] ?? null }));
              break;
            case 'clearVariable':
              if (definition.variables[effect.variable]?.kind === 'selection') setSelections((s) => ({ ...s, [effect.variable]: [] }));
              else setParameters((p) => ({ ...p, [effect.variable]: null }));
              break;
            case 'navigate': setPageParam(effect.pageId === definition.pages[0]?.id ? undefined : effect.pageId); break;
            case 'openObjectView': {
              const variable = definition.variables[effect.variable];
              const id = next[effect.variable]?.[0];
              if (variable?.kind === 'selection' && id !== undefined) router.push(objectHref({ objectTypeId: variable.objectTypeId, objectId: id }) as never);
              break;
            }
            case 'openActionForm': {
              const from = Object.values(effect.params)[0] ?? '';
              const variable = definition.variables[from];
              setForm({ actionTypeId: effect.actionTypeId, objectTypeId: variable?.kind === 'selection' ? variable.objectTypeId : undefined, objectId: next[from]?.[0] });
              break;
            }
            case 'openAsk': router.push('/ask/threads/' as never); break;
            case 'refreshWidget': setRefresh((r) => ({ ...r, [effect.widget]: (r[effect.widget] ?? 0) + 1 })); break;
          }
        }
      }
    })();
  }, [api, appId, version, definition, parameters, selections, router, setPageParam]);

  const runtime: Runtime = {
    appId, version, definition, parameters, selections, narrowing,
    visible: (id) => {
      const w = definition.pages.flatMap((p) => p.widgets).find((x) => x.id === id);
      return w?.visibleWhen === undefined || expressions.result?.widgets[id] === true;
    },
    refreshOf: (id) => refresh[id] ?? 0,
    setParameter: (name, value) => setParameters((p) => ({ ...p, [name]: value })),
    setNarrowing: (target, n) => setNarrowingState((s) => ({ ...s, [target]: n })),
    emit,
  };

  const current = definition.pages.find((p) => p.id === pageParam) ?? definition.pages[0];
  const tabs: TabDef[] = definition.pages.map((p) => ({ id: p.id, label: p.title }));
  const parameterNames = Object.entries(definition.variables).filter(([, v]) => v.kind === 'parameter').map(([n]) => n);
  const canEdit = opened.app.access === 'owner' || opened.app.access === 'edit';
  const canCopy = opened.app.access === 'owner' || opened.app.access === 'copy' || opened.app.access === 'edit';
  return (
    <RuntimeContext.Provider value={runtime}>
      <Page title={opened.app.name} documentTitle={opened.app.name} width="full"
        description={opened.app.description ?? undefined}
        crumbs={[{ label: 'Studio' }, { label: 'Apps', href: '/studio/apps/' }]}
        meta={version !== undefined ? <Badge tone="warn">Preview of draft {version}</Badge> : opened.app.generatedBy === 'ai_fde' ? <Badge tone="info">Proposed by the AI FDE</Badge> : undefined}
        actions={
          <div className={styles.row}>
            {version !== undefined ? <LinkButton href={appHref(appId)}>Open the published version</LinkButton> : null}
            {canEdit ? <LinkButton href={appEditorHref(appId)} icon="edit">Edit</LinkButton> : null}
            <Menu label="More" items={[
              { label: 'Make a copy', icon: 'copy', disabled: !canCopy, blocked: canCopy ? copy.blocked : 'Shared with you without copying', onSelect: () => setCopying(true) },
              { label: 'Read it again', icon: 'refresh', onSelect: () => setRefresh((r) => Object.fromEntries(definition.pages.flatMap((p) => p.widgets).map((w) => [w.id, (r[w.id] ?? 0) + 1]))) },
            ]} renderTrigger={(p) => <IconButton {...p} label="More" icon="more" />} />
          </div>
        }>
        <div className={styles.stack}>
          {opened.statement !== null ? <Banner tone="info" title="Part of this app is not shown to you">{opened.statement}{opened.withheld > 0 ? ` (${plural(opened.withheld, 'element')})` : ''}</Banner> : null}
          {definition.pages.length > 1 && current !== undefined ? (
            <Tabs label="Pages" tabs={tabs} current={current.id} onChange={(id) => setPageParam(id === definition.pages[0]?.id ? undefined : id)} />
          ) : null}
          {parameterNames.length > 0 ? <div className={styles.fields}>{parameterNames.map((n) => <ParameterControl key={n} name={n} />)}</div> : null}
          {current !== undefined ? (
            <TabPanel id={current.id} untabbed={definition.pages.length <= 1}>
              <div className={grid.grid}>
                {current.widgets.filter((w) => runtime.visible(w.id)).map((w) => {
                  const s = status.get(w.id);
                  const [col, row, colSpan, rowSpan] = w.grid;
                  return (
                    <section key={w.id} aria-label={w.kind === 'markdown' ? 'Text' : w.id.replaceAll('_', ' ')}
                      className={[grid.cell, grid[`c${col}`], grid[`w${colSpan}`], grid[`r${Math.min(row, 200)}`], grid[`h${Math.min(rowSpan, 50)}`]].join(' ')}>
                      {s?.status === 'unavailable' ? <p className={styles.muted}>Not available: {s.reason ?? 'its data is not visible to you'}</p> : (
                        <>
                          {s?.status === 'reduced' ? <p className={styles.muted}>{s.reason ?? 'Part of this is not visible to you.'}</p> : null}
                          <Widget w={w} disabled={s?.status === 'disabled' ? s.reason ?? 'You may not submit this Action.' : undefined} />
                        </>
                      )}
                    </section>
                  );
                })}
              </div>
            </TabPanel>
          ) : null}
        </div>
        <Dialog open={form !== undefined} onClose={() => setForm(undefined)} title="Action" drawer>
          {form !== undefined ? <AppActionForm actionTypeId={form.actionTypeId} objectTypeId={form.objectTypeId} objectId={form.objectId} /> : null}
        </Dialog>
        <NameDialog open={copying} title="Copy the app" initial={`${opened.app.name} (copy)`.slice(0, 200)} action="Make the copy" pending={copy.pending} error={copy.error}
          hint="The copy is a draft of your own, from the version you have open."
          onClose={() => setCopying(false)}
          onSave={(name) => void copy.run({ params: { appId }, body: { name } }).then((r) => {
            if (!r.ok) return;
            setCopying(false);
            say('Copied: it is a draft of your own');
            router.push(appEditorHref(r.data.app.id) as never);
          })} />
      </Page>
    </RuntimeContext.Provider>
  );
}

function Widget({ w, disabled }: { w: AppWidget; disabled: string | undefined }) {
  switch (w.kind) {
    case 'objectTable': return <ObjectTable w={w} />;
    case 'objectList': return <ObjectList w={w} />;
    case 'propertyList': return <PropertyList w={w} />;
    case 'objectViewEmbed': return <ObjectViewEmbed w={w} />;
    case 'metric': return <Metric w={w} />;
    case 'chart': return <Chart w={w} />;
    case 'filterControls': return <FilterControls w={w} />;
    case 'actionForm':
    case 'actionButton': return <ActionWidget w={w} disabled={disabled} />;
    case 'approvalInbox': return <ApprovalInbox />;
    case 'timeline': return <Timeline w={w} />;
    case 'markdown': return <Markdown w={w} />;
    case 'canvasEmbed': return <CanvasEmbed w={w} />;
    case 'scenarioControl': return <ScenarioControl w={w} />;
    case 'map': return <MapWidget w={w} />;
    case 'askPanel': return <AskPanel w={w} />;
    default: return <UnknownWidget kind={(w as { kind: string }).kind} />;
  }
}
