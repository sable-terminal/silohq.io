'use client';

// An app's definition, edited (spec 35.2, 35.5): variables (object sets as a type and a CEL
// filter, selections, parameters, scenarios), pages, and each page's widgets from the closed
// catalogue with their place on the 12-column grid; and the event bindings. Nothing here checks
// the definition against the ontology: every save is validated by Studio and saved with what is
// wrong with it, shown above the editor.

import { useEffect, useMemo, useState } from 'react';
import { Button, IconButton } from '../../components/button.component.tsx';
import { Checkbox, SelectField, TextArea, TextField } from '../../components/field.component.tsx';
import { Section } from '../../components/page.component.tsx';
import { TabPanel, Tabs } from '../../components/tabs.component.tsx';
import { useQuery } from '../../data/query.data.ts';
import { useVocabulary, type ObjectType } from '../../hooks/vocabulary.hook.ts';
import type { AppDefinition, AppWidget, Variable } from './runtime.view.ts';
import styles from './studio.view.module.css';

type Kind = AppWidget['kind'];
type Page = AppDefinition['pages'][number];

export const KINDS: { kind: Kind; label: string }[] = [
  { kind: 'objectTable', label: 'Object table' }, { kind: 'objectList', label: 'Object list' }, { kind: 'propertyList', label: 'Property list' },
  { kind: 'objectViewEmbed', label: 'Object view' }, { kind: 'metric', label: 'Metric' }, { kind: 'chart', label: 'Chart' },
  { kind: 'filterControls', label: 'Filter controls' }, { kind: 'actionButton', label: 'Action button' }, { kind: 'actionForm', label: 'Action form' },
  { kind: 'approvalInbox', label: 'Approval inbox' }, { kind: 'timeline', label: 'Timeline' }, { kind: 'markdown', label: 'Text' },
  { kind: 'askPanel', label: 'Ask panel' }, { kind: 'map', label: 'Map' }, { kind: 'canvasEmbed', label: 'Clone Canvas' }, { kind: 'scenarioControl', label: 'Scenario control' },
];
const kindLabel = (kind: string) => KINDS.find((k) => k.kind === kind)?.label ?? kind;

const VARIABLE_KINDS: { value: Variable['kind']; label: string }[] = [
  { value: 'objectSet', label: 'Object set' }, { value: 'selection', label: 'Selection' }, { value: 'parameter', label: 'Parameter' }, { value: 'scenario', label: 'Scenario' },
];
const PARAMETER_TYPES = ['text', 'number', 'date', 'period', 'boolean', 'enumeration'] as const;
const AGGREGATES = [{ value: 'count', label: 'Count' }, { value: 'sum', label: 'Total' }, { value: 'avg', label: 'Average' }, { value: 'min', label: 'Lowest' }, { value: 'max', label: 'Highest' }];
/** The canvas layouts an embed may take (29.2). */
const CANVAS_LAYOUTS = [
  { value: 'graph_force', label: 'Graph' }, { value: 'graph_layered', label: 'Layered graph' }, { value: 'hierarchy', label: 'Hierarchy' },
  { value: 'schematic', label: 'Schematic' }, { value: 'timeline', label: 'Timeline' }, { value: 'spatial_map', label: 'Map' },
];
const NAME = /^[a-z][A-Za-z0-9_]{0,39}$/;

export const blankDefinition = (sequence: number): AppDefinition => ({
  schemaVersion: '1', ontologyVersion: sequence, variables: {}, pages: [{ id: 'home', title: 'Home', widgets: [] }], events: [], functions: [], actions: [],
});

/** A new widget of a kind, placed below the page's last, with the fields its kind requires. */
function newWidget(kind: Kind, id: string, row: number, def: AppDefinition): AppWidget {
  const first = (k: Variable['kind']) => Object.entries(def.variables).find(([, v]) => v.kind === k)?.[0] ?? '';
  const set = first('objectSet');
  const pick = first('selection');
  const grid: [number, number, number, number] = [1, row, 12, kind === 'metric' || kind === 'actionButton' || kind === 'markdown' ? 2 : 6];
  const widgets: Record<Kind, unknown> = {
    objectTable: { id, grid, kind, source: set, columns: [] },
    objectList: { id, grid, kind, source: set, properties: [] },
    propertyList: { id, grid, kind, source: pick, properties: [] },
    objectViewEmbed: { id, grid, kind, source: pick },
    metric: { id, grid, kind, source: set, aggregate: 'count' },
    chart: { id, grid, kind, source: set, measure: { aggregate: 'count' } },
    filterControls: { id, grid, kind, target: set, facets: [], search: true },
    actionButton: { id, grid, kind, actionTypeId: '', params: pick === '' ? {} : { target: pick }, label: 'Act' },
    actionForm: { id, grid, kind, actionTypeId: '', params: pick === '' ? {} : { target: pick } },
    approvalInbox: { id, grid, kind },
    timeline: { id, grid, kind, source: pick },
    markdown: { id, grid, kind, text: '' },
    askPanel: { id, grid, kind, scope: [] },
    map: { id, grid, kind, source: set, geoPropertyId: '' },
    canvasEmbed: { id, grid, kind, source: set, layout: 'graph_force' },
    scenarioControl: { id, grid, kind, variable: first('scenario') },
  };
  return widgets[kind] as AppWidget;
}

export function DefinitionEditor({ def, onChange, readOnly, layout }: { def: AppDefinition; onChange: (d: AppDefinition) => void; readOnly: boolean; layout: boolean }) {
  return (
    <fieldset className={styles.fieldset} disabled={readOnly} aria-label="The definition">
      <div className={styles.editor}>
        <Pages def={def} onChange={onChange} layout={layout} />
        <div className={styles.stack}>
          <Variables def={def} onChange={onChange} />
          <Events def={def} onChange={onChange} />
        </div>
      </div>
    </fieldset>
  );
}

function Variables({ def, onChange }: { def: AppDefinition; onChange: (d: AppDefinition) => void }) {
  const { data: vocabulary } = useVocabulary();
  const [name, setName] = useState('');
  const [kind, setKind] = useState<Variable['kind']>('objectSet');
  const types = vocabulary?.objectTypes ?? [];
  const set = (n: string, v: Variable | undefined) => {
    const variables = { ...def.variables };
    if (v === undefined) delete variables[n];
    else variables[n] = v;
    onChange({ ...def, variables });
  };
  const taken = def.variables[name] !== undefined;
  const add = () => {
    if (!NAME.test(name) || taken) return;
    const objectTypeId = types[0]?.id ?? '';
    set(name, kind === 'objectSet' || kind === 'selection' ? { kind, objectTypeId } : kind === 'parameter' ? { kind, type: 'text' } : { kind });
    setName('');
  };
  return (
    <Section title="Variables" description="An object set holds a definition (a type and a filter), never its members; a selection, what a widget picked; a parameter, a value the viewer sets.">
      <div className={styles.stackTight}>
        {Object.entries(def.variables).map(([n, v]) => (
          <div key={n} className={styles.card} role="group" aria-label={`Variable ${n}`}>
            <div className={styles.cardHead}>
              <span><strong className={styles.mono}>{n}</strong> <span className={styles.muted}>{VARIABLE_KINDS.find((k) => k.value === v.kind)?.label}</span></span>
              <IconButton size="sm" icon="trash" label={`Remove ${n}`} onClick={() => set(n, undefined)} />
            </div>
            {v.kind === 'objectSet' || v.kind === 'selection' ? (
              <SelectField label="Of" value={v.objectTypeId} onChange={(e) => set(n, { ...v, objectTypeId: e.target.value })}
                options={types.map((t) => ({ value: t.id, label: t.pluralName }))} />
            ) : null}
            {v.kind === 'objectSet' ? <FilterEditor variable={v} type={types.find((t) => t.id === v.objectTypeId)} onChange={(next) => set(n, next)} /> : null}
            {v.kind === 'parameter' ? (
              <div className={styles.fields}>
                <SelectField label="Type" value={v.type} onChange={(e) => set(n, { ...v, type: e.target.value as typeof PARAMETER_TYPES[number] })}
                  options={PARAMETER_TYPES.map((t) => ({ value: t, label: t }))} />
                {v.type === 'enumeration' ? (
                  <TextField label="Choices" hint="Separated by commas" value={(v.options ?? []).join(', ')}
                    onChange={(e) => set(n, { ...v, options: e.target.value.split(',').map((x) => x.trim()).filter((x) => x !== '') })} />
                ) : null}
              </div>
            ) : null}
          </div>
        ))}
        <form className={styles.rowEnd} onSubmit={(e) => {
          e.preventDefault();
          add();
        }} aria-label="Add a variable">
          <TextField label="New variable" value={name} onChange={(e) => setName(e.target.value)} placeholder="openOrders"
            error={name !== '' && !NAME.test(name) ? 'A lower-case letter, then letters, digits or underscores' : taken ? 'There is a variable by that name' : undefined} />
          <SelectField label="Kind" value={kind} onChange={(e) => setKind(e.target.value as Variable['kind'])} options={VARIABLE_KINDS} />
          <Button type="submit" icon="plus" disabled={!NAME.test(name) || taken}>Add</Button>
        </form>
      </div>
    </Section>
  );
}

function FilterEditor({ variable, type, onChange }: { variable: Extract<Variable, { kind: 'objectSet' }>; type: ObjectType | undefined; onChange: (v: Variable) => void }) {
  const cel = variable.filter?.cel ?? '';
  // The properties a filter reads are declared from the names it uses, so the dependency index and the viewer's re-check see them.
  const update = (text: string) => {
    if (text.trim() === '') {
      const { filter: _filter, ...rest } = variable;
      onChange(rest);
      return;
    }
    const properties = (type?.properties ?? []).filter((p) => new RegExp(`\\bobject\\.${p.apiName}\\b`).test(text)).map((p) => p.identityId);
    onChange({ ...variable, filter: { cel: text, properties } });
  };
  const reads = variable.filter?.properties.map((id) => type?.properties.find((p) => p.identityId === id)?.displayName ?? 'a property you cannot see').join(', ');
  return (
    <TextField label="Filter (optional)" className={styles.mono} value={cel} onChange={(e) => update(e.target.value)}
      placeholder={type === undefined ? '' : `object.${type.properties[0]?.apiName ?? 'name'} != null`}
      hint={`CEL over object; parameters by name. Reads: ${reads || 'nothing yet'}.`} />
  );
}

function Pages({ def, onChange, layout }: { def: AppDefinition; onChange: (d: AppDefinition) => void; layout: boolean }) {
  const [current, setCurrent] = useState(def.pages[0]?.id ?? 'home');
  const [kind, setKind] = useState<Kind>('objectTable');
  const p = def.pages.find((x) => x.id === current) ?? def.pages[0]!;
  const setPage = (next: Page) => onChange({ ...def, pages: def.pages.map((x) => (x.id === p.id ? next : x)) });
  const addWidget = () => {
    const ids = new Set(def.pages.flatMap((x) => x.widgets.map((w) => w.id)));
    let n = 1;
    while (ids.has(`${kind.toLowerCase()}_${n}`)) n += 1;
    const row = Math.max(1, ...p.widgets.map((w) => w.grid[1] + w.grid[3]));
    setPage({ ...p, widgets: [...p.widgets, newWidget(kind, `${kind.toLowerCase()}_${n}`, Math.min(row, 200), def)] });
  };
  const addPage = () => {
    let n = def.pages.length + 1;
    while (def.pages.some((x) => x.id === `page_${n}`)) n += 1;
    onChange({ ...def, pages: [...def.pages, { id: `page_${n}`, title: `Page ${n}`, widgets: [] }] });
    setCurrent(`page_${n}`);
  };
  const move = (i: number, by: -1 | 1) => {
    const widgets = [...p.widgets];
    const j = i + by;
    if (j < 0 || j >= widgets.length) return;
    [widgets[i], widgets[j]] = [widgets[j]!, widgets[i]!];
    setPage({ ...p, widgets });
  };
  return (
    <Section title={layout ? 'The layout' : 'Pages'} description={layout ? 'One page bound to the object it shows.' : 'Each page is a 12-column grid; a widget\'s column and row are where it starts.'}
      actions={layout ? undefined : <Button size="sm" icon="plus" onClick={addPage}>Add a page</Button>}>
      <div className={styles.stack}>
        {def.pages.length > 1 ? <Tabs label="Pages of the app" tabs={def.pages.map((x) => ({ id: x.id, label: x.title }))} current={p.id} onChange={setCurrent} /> : null}
        <TabPanel id={p.id} untabbed={def.pages.length <= 1}>
          <div className={styles.rowEnd}>
            <TextField label="Page title" value={p.title} onChange={(e) => setPage({ ...p, title: e.target.value })} maxLength={120} />
            {def.pages.length > 1 ? (
              <Button variant="ghost" icon="trash" onClick={() => {
                onChange({ ...def, pages: def.pages.filter((x) => x.id !== p.id) });
                setCurrent(def.pages.find((x) => x.id !== p.id)!.id);
              }}>Remove this page</Button>
            ) : null}
          </div>
          {p.widgets.length === 0 ? <p className={styles.muted}>No widgets on this page yet.</p> : null}
          {p.widgets.map((w, i) => (
            <WidgetEditor key={w.id} def={def} widget={w} first={i === 0} last={i === p.widgets.length - 1}
              onChange={(next) => setPage({ ...p, widgets: p.widgets.map((x, j) => (j === i ? next : x)) })}
              onMove={(by) => move(i, by)}
              onRemove={() => setPage({ ...p, widgets: p.widgets.filter((_x, j) => j !== i) })} />
          ))}
          <form className={styles.rowEnd} aria-label="Add a widget" onSubmit={(e) => {
            e.preventDefault();
            addWidget();
          }}>
            <SelectField label="Widget" value={kind} onChange={(e) => setKind(e.target.value as Kind)} options={KINDS.map((k) => ({ value: k.kind, label: k.label }))} />
            <Button type="submit" icon="plus">Add the widget</Button>
          </form>
        </TabPanel>
      </div>
    </Section>
  );
}

function PropertyChecks({ legend, properties, chosen, max, onChange }: {
  legend: string; properties: readonly { identityId: string; displayName: string }[]; chosen: readonly string[]; max: number; onChange: (ids: string[]) => void;
}) {
  return (
    <fieldset className={styles.fieldset}>
      <legend>{legend}{max < 30 ? ` (up to ${max})` : ''}</legend>
      {properties.length === 0 ? <p className={styles.muted}>Choose what it shows first.</p> : (
        <div className={styles.checks}>{properties.map((p) => (
          <Checkbox key={p.identityId} label={p.displayName} checked={chosen.includes(p.identityId)}
            disabled={!chosen.includes(p.identityId) && chosen.length >= max}
            onChange={(e) => onChange(e.target.checked ? [...chosen, p.identityId].slice(0, max) : chosen.filter((x) => x !== p.identityId))} />
        ))}</div>
      )}
    </fieldset>
  );
}

function WidgetEditor({ def, widget, first, last, onChange, onMove, onRemove }: {
  def: AppDefinition; widget: AppWidget; first: boolean; last: boolean; onChange: (w: AppWidget) => void; onMove: (by: -1 | 1) => void; onRemove: () => void;
}) {
  const { data: vocabulary } = useVocabulary();
  const acts = widget.kind === 'actionButton' || widget.kind === 'actionForm';
  const actionTypes = useQuery('listActionTypes', acts ? { query: { status: 'confirmed' } } : null);
  const w = widget as AppWidget & Record<string, unknown>;
  const patch = (fields: Record<string, unknown>) => onChange({ ...w, ...fields } as AppWidget);
  const variablesOf = (kind: Variable['kind']) => Object.entries(def.variables).filter(([, v]) => v.kind === kind).map(([n]) => n);
  const sourceName = (w['source'] ?? w['target']) as string | undefined;
  const sourceVar = sourceName === undefined ? undefined : def.variables[sourceName];
  const type = vocabulary?.objectTypes.find((t) => sourceVar !== undefined && 'objectTypeId' in sourceVar && t.id === sourceVar.objectTypeId);
  const props = type?.properties ?? [];
  const propertyOptions = props.map((p) => ({ value: p.identityId, label: p.displayName }));
  const grid = widget.grid;
  const source = (field: 'source' | 'target' | 'variable', kinds: Variable['kind'][], label: string) => (
    <SelectField label={label} value={(w[field] as string | undefined) ?? ''} placeholder="Choose a variable" onChange={(e) => patch({ [field]: e.target.value })}
      options={kinds.flatMap((k) => variablesOf(k)).map((n) => ({ value: n, label: n }))}
      hint={kinds.flatMap((k) => variablesOf(k)).length === 0 ? `Add ${kinds.includes('selection') ? 'a selection' : kinds.includes('scenario') ? 'a scenario' : 'an object set'} variable first.` : undefined} />
  );
  const emits = (label: string) => (
    <SelectField label={label} value={(w['emits'] as { selectionChanged?: string } | undefined)?.selectionChanged ?? ''} placeholder="Nothing"
      onChange={(e) => patch({ emits: e.target.value === '' ? undefined : { selectionChanged: e.target.value } })}
      options={variablesOf('selection').map((n) => ({ value: n, label: n }))} />
  );
  const measure = widget.kind === 'chart' ? widget.measure : undefined;
  return (
    <div className={styles.card} aria-label={`${kindLabel(widget.kind)} ${widget.id}`} role="group">
      <div className={styles.cardHead}>
        <span><strong>{kindLabel(widget.kind)}</strong> <span className={`${styles.muted} ${styles.mono}`}>{widget.id}</span></span>
        <IconButton size="sm" icon="chevronUp" label="Move up" disabled={first} onClick={() => onMove(-1)} />
        <IconButton size="sm" icon="chevronDown" label="Move down" disabled={last} onClick={() => onMove(1)} />
        <IconButton size="sm" icon="trash" label={`Remove ${widget.id}`} onClick={onRemove} />
      </div>
      <div className={styles.narrowFields}>
        {(['Column', 'Row', 'Width', 'Height'] as const).map((l, i) => (
          <TextField key={l} label={l} type="number" min={1} max={i === 0 || i === 2 ? 12 : i === 1 ? 200 : 50} value={grid[i]}
            onChange={(e) => patch({ grid: grid.map((x, j) => (j === i ? Math.max(1, Number(e.target.value) || 1) : x)) })} />
        ))}
      </div>
      <div className={styles.fields}>
        {['objectTable', 'objectList', 'metric', 'chart', 'map', 'canvasEmbed'].includes(widget.kind) ? source('source', ['objectSet'], 'Shows') : null}
        {['propertyList', 'objectViewEmbed', 'timeline'].includes(widget.kind) ? source('source', ['selection'], 'Shows the object picked into') : null}
        {widget.kind === 'filterControls' ? source('target', ['objectSet'], 'Narrows') : null}
        {widget.kind === 'scenarioControl' ? source('variable', ['scenario'], 'Holds the branch in') : null}
        {widget.kind === 'objectTable' || widget.kind === 'objectList' ? emits('Selecting a row picks it into') : null}
        {widget.kind === 'canvasEmbed' ? (
          <>
            <SelectField label="Layout" value={widget.layout} onChange={(e) => patch({ layout: e.target.value })} options={CANVAS_LAYOUTS} />
            {emits('Selecting a clone picks it into')}
          </>
        ) : null}
        {widget.kind === 'metric' ? (
          <>
            <SelectField label="Measure" value={widget.aggregate} onChange={(e) => patch({ aggregate: e.target.value, ...(e.target.value === 'count' ? { property: undefined } : {}) })} options={AGGREGATES} />
            {widget.aggregate !== 'count' ? <SelectField label="Of" value={widget.property ?? ''} placeholder="Choose a property" onChange={(e) => patch({ property: e.target.value || undefined })} options={propertyOptions} /> : null}
          </>
        ) : null}
        {measure !== undefined ? (
          <>
            <SelectField label="Measure" value={measure.aggregate} onChange={(e) => patch({ measure: { aggregate: e.target.value, ...(e.target.value === 'count' ? {} : { property: measure.property }) } })} options={AGGREGATES} />
            {measure.aggregate !== 'count' ? <SelectField label="Of" value={measure.property ?? ''} placeholder="Choose a property" onChange={(e) => patch({ measure: { ...measure, property: e.target.value || undefined } })} options={propertyOptions} /> : null}
            <SelectField label="By" value={(w['groupBy'] as string | undefined) ?? ''} placeholder="Nothing (one bar)" onChange={(e) => patch({ groupBy: e.target.value || undefined })} options={propertyOptions} />
          </>
        ) : null}
        {acts ? (
          <>
            <SelectField label="Action" value={widget.actionTypeId} placeholder={actionTypes.data === undefined ? 'Listing…' : 'Choose an Action'}
              onChange={(e) => patch({ actionTypeId: e.target.value })} options={(actionTypes.data?.actionTypes ?? []).map((a) => ({ value: a.id, label: a.displayName }))} />
            <SelectField label="On the object picked into" value={Object.values(widget.params)[0] ?? ''} placeholder="Nothing"
              onChange={(e) => patch({ params: e.target.value === '' ? {} : { target: e.target.value } })} options={variablesOf('selection').map((n) => ({ value: n, label: n }))} />
            {widget.kind === 'actionButton' ? <TextField label="Label" value={widget.label} onChange={(e) => patch({ label: e.target.value })} maxLength={60} /> : null}
          </>
        ) : null}
        {widget.kind === 'map' ? <SelectField label="Where" value={widget.geoPropertyId} placeholder="Choose a property" onChange={(e) => patch({ geoPropertyId: e.target.value })} options={propertyOptions} /> : null}
      </div>
      {widget.kind === 'objectTable' ? <PropertyChecks legend="Columns" properties={props} chosen={widget.columns} max={30} onChange={(columns) => patch({ columns })} /> : null}
      {widget.kind === 'objectList' ? <PropertyChecks legend="Properties" properties={props} chosen={widget.properties} max={4} onChange={(properties) => patch({ properties })} /> : null}
      {widget.kind === 'propertyList' ? <PropertyChecks legend="Properties" properties={props} chosen={widget.properties} max={50} onChange={(properties) => patch({ properties })} /> : null}
      {widget.kind === 'filterControls' ? (
        <>
          <PropertyChecks legend="Facets" properties={props} chosen={widget.facets} max={20} onChange={(facets) => patch({ facets })} />
          <Checkbox label="A search box" checked={widget.search} onChange={(e) => patch({ search: e.target.checked })} />
        </>
      ) : null}
      {widget.kind === 'markdown' ? (
        <TextArea label="Text" rows={4} value={widget.text} onChange={(e) => patch({ text: e.target.value })} maxLength={4000}
          hint="{{count:variable}} and {{label:objectTypeId}} are filled in; property values never are. # and ## make headings; lines starting - make a list." />
      ) : null}
      <TextField label="Shown when (optional)" className={styles.mono} value={widget.visibleWhen ?? ''} placeholder="size(picked) > 0"
        hint="A CEL condition over the variables; Studio evaluates it."
        onChange={(e) => patch({ visibleWhen: e.target.value.trim() === '' ? undefined : e.target.value })} />
    </div>
  );
}

/** Event bindings, as the definition holds them: source, optional condition, at most eight effects from the closed set. */
function Events({ def, onChange }: { def: AppDefinition; onChange: (d: AppDefinition) => void }) {
  const text = useMemo(() => JSON.stringify(def.events, null, 2), [def.events]);
  const [draft, setDraft] = useState(text);
  const [problem, setProblem] = useState<string | undefined>();
  useEffect(() => setDraft(text), [text]);
  return (
    <Section title="Events" description="Each binding names a widget's event, an optional condition, and up to eight effects: set or clear a variable, navigate, open an object view, open an Action form, open Ask, refresh a widget.">
      <TextArea label="Event bindings" className={styles.mono} rows={Math.min(16, Math.max(4, draft.split('\n').length))} value={draft} error={problem}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          try {
            const parsed = JSON.parse(draft) as unknown;
            if (!Array.isArray(parsed)) throw new Error('not a list');
            setProblem(undefined);
            onChange({ ...def, events: parsed as AppDefinition['events'] });
          } catch {
            setProblem('Not a list of bindings: check the brackets and quotes.');
          }
        }} />
    </Section>
  );
}
