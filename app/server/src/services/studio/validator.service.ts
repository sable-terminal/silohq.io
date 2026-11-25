// The app definition validator (spec 35.1, 35.2, 35.3): run on every save and every
// publish. Pure over its inputs: the definition as written, the manifest of the ontology
// version it binds, and the Action types it names (looked up by the caller).
//
// It refuses, never repairs: each problem is a finding with its path. A definition that
// names an object type, property, link type, Action type or Function that does not exist
// in the bound version is invalid. Also checked: the 12-column grid, variable kinds and
// types (a table reads an object set, a property list a selection of the same type), emitted
// selections of the source's type, declared Functions and Action types only, CEL that
// compiles, markdown that interpolates labels and counts but never a value, and an event
// graph without cycles (a variable that, through events and emitted selections, ends up
// setting itself).
//
// Alongside the findings it returns every element the definition references and the
// widgets using each: app_references, which ontology proposals read to say which apps a
// change breaks, and from which the version's markings are computed.

import {
  appDefinition, WIDGET_EVENTS, type AppDefinition, type AppVariable, type AppWidget, type ValidationFinding,
} from '../../contracts/studio/definition.contract.ts';
import type { OntologyManifest } from '../../contracts/ontology/manifest.contract.ts';
import { compileCel } from '../expression-evaluator/cel.service.ts';

export interface ActionTypeFact {
  id: string;
  status: 'proposed' | 'confirmed' | 'blocked' | 'retired' | 'rejected';
  objectTypeId: string | null;
}

export type ElementKind = 'objectType' | 'property' | 'linkType' | 'actionType' | 'function';

export interface Validated {
  definition: AppDefinition | undefined;
  findings: ValidationFinding[];
  /** Element kind to element id to the widget ids that use it (none for a declared but unused element). */
  references: Record<ElementKind, Map<string, Set<string>>>;
}

const GEO = ['geopoint', 'geoshape'];
const TIME = ['date', 'timestamp'];

export function validate(raw: unknown, manifest: OntologyManifest | undefined, actionTypes: ReadonlyMap<string, ActionTypeFact>): Validated {
  const references: Validated['references'] = {
    objectType: new Map(), property: new Map(), linkType: new Map(), actionType: new Map(), function: new Map(),
  };
  const parsed = appDefinition.safeParse(raw);
  if (!parsed.success) {
    return {
      definition: undefined, references,
      findings: parsed.error.issues.slice(0, 100).map((i) => ({ path: i.path.map(String).join('.') || '(root)', code: 'schema', message: i.message })),
    };
  }
  const def = parsed.data;
  const findings: ValidationFinding[] = [];
  const find = (path: string, code: string, message: string): void => { findings.push({ path, code, message }); };
  const use = (kind: ElementKind, id: string, widget?: string): void => {
    const users = references[kind].get(id) ?? new Set<string>();
    if (widget !== undefined) users.add(widget);
    references[kind].set(id, users);
  };

  if (manifest === undefined) {
    find('ontologyVersion', 'ontology_version_unknown', `main has no version ${def.ontologyVersion}`);
    return { definition: def, findings, references };
  }
  const types = new Map(manifest.objectTypes.filter((t) => t.status === 'active').map((t) => [t.id, t]));
  const links = new Map(manifest.linkTypes.filter((l) => l.status === 'active').map((l) => [l.id, l]));
  const functions = new Map(manifest.functions.filter((f) => f.status === 'active').map((f) => [f.id, f]));
  const propertyOf = (typeId: string | undefined, propertyId: string) =>
    typeId === undefined ? undefined : types.get(typeId)?.properties.find((p) => p.identityId === propertyId && p.status === 'active');

  // ---- Variables: what each holds, and of which type.
  const variableType = new Map<string, string | undefined>();
  const kinds = new Map<string, AppVariable['kind']>();
  const variableUsers = new Map<string, Set<string>>();
  const celNames = Object.fromEntries(Object.keys(def.variables).map((name) => [name, 'dyn' as const]));
  for (const [name, v] of Object.entries(def.variables)) {
    const path = `variables.${name}`;
    kinds.set(name, v.kind);
    if (v.kind === 'objectSet' || v.kind === 'selection') {
      if (!types.has(v.objectTypeId)) {
        find(path, 'object_type_unknown', 'no such object type in the bound ontology version');
        continue;
      }
      let at: string | undefined = v.objectTypeId;
      if (v.kind === 'objectSet') {
        for (const [i, property] of (v.filter?.properties ?? []).entries()) {
          if (!propertyOf(v.objectTypeId, property)) find(`${path}.filter.properties.${i}`, 'property_unknown', 'not a property of the type');
        }
        if (v.filter !== undefined) {
          try {
            compileCel(v.filter.cel, { object: 'map', ...celNames });
          } catch {
            find(`${path}.filter.cel`, 'cel_invalid', 'the filter does not compile');
          }
        }
        for (const [i, hop] of (v.traversal ?? []).entries()) {
          const link = links.get(hop.linkTypeId);
          const from = hop.direction === 'forward' ? link?.fromTypeId : link?.toTypeId;
          if (!link || from !== at) {
            find(`${path}.traversal.${i}`, 'traversal_broken', 'the link does not continue from where the set stands');
            at = undefined;
            break;
          }
          at = hop.direction === 'forward' ? link.toTypeId : link.fromTypeId;
        }
      }
      variableType.set(name, at);
    }
  }
  const varUse = (name: string, widget: string): void => {
    const users = variableUsers.get(name) ?? new Set<string>();
    users.add(widget);
    variableUsers.set(name, users);
  };
  const needVariable = (path: string, name: string, allowed: AppVariable['kind'][], widget?: string): string | undefined => {
    const kind = kinds.get(name);
    if (kind === undefined) {
      find(path, 'variable_unknown', `no variable ${name}`);
      return undefined;
    }
    if (!allowed.includes(kind)) {
      find(path, 'variable_kind', `${name} is a ${kind}; this needs ${allowed.join(' or ')}`);
      return undefined;
    }
    if (widget !== undefined) varUse(name, widget);
    return variableType.get(name);
  };
  const needProperty = (path: string, typeId: string | undefined, propertyId: string, widget: string, dataTypes?: string[]): void => {
    const property = propertyOf(typeId, propertyId);
    if (!property) {
      if (typeId !== undefined) find(path, 'property_unknown', 'not a property of the source\'s type');
      return;
    }
    if (dataTypes !== undefined && !dataTypes.includes(property.dataType)) find(path, 'property_type', `must be a ${dataTypes.join(' or ')} property`);
    use('property', propertyId, widget);
  };

  // ---- Pages and widgets.
  const pageIds = new Set<string>();
  const widgets = new Map<string, AppWidget>();
  def.pages.forEach((page, p) => {
    if (pageIds.has(page.id)) find(`pages.${p}.id`, 'duplicate_id', `page ${page.id} is defined twice`);
    pageIds.add(page.id);
    page.widgets.forEach((w, i) => {
      const path = `pages.${p}.widgets.${i}`;
      if (widgets.has(w.id)) find(`${path}.id`, 'duplicate_id', `widget ${w.id} is defined twice`);
      widgets.set(w.id, w);
      const [column, , span] = w.grid;
      if (column + span - 1 > 12) find(`${path}.grid`, 'grid_overflow', 'the widget runs past the twelfth column');
      if (w.visibleWhen !== undefined) {
        try {
          compileCel(w.visibleWhen, celNames);
        } catch {
          find(`${path}.visibleWhen`, 'cel_invalid', 'the visibility rule does not compile');
        }
      }
      const emitsOf = (typeId: string | undefined, emits: { selectionChanged?: string | undefined } | undefined): void => {
        const target = emits?.selectionChanged;
        if (target === undefined) return;
        const emitted = needVariable(`${path}.emits.selectionChanged`, target, ['selection']);
        if (emitted !== undefined && typeId !== undefined && emitted !== typeId) {
          find(`${path}.emits.selectionChanged`, 'selection_type', 'the selection is of another type than the source');
        }
      };
      switch (w.kind) {
        case 'objectTable': {
          const t = needVariable(`${path}.source`, w.source, ['objectSet'], w.id);
          w.columns.forEach((c, k) => needProperty(`${path}.columns.${k}`, t, c, w.id));
          emitsOf(t, w.emits);
          break;
        }
        case 'objectList': {
          const t = needVariable(`${path}.source`, w.source, ['objectSet'], w.id);
          w.properties.forEach((c, k) => needProperty(`${path}.properties.${k}`, t, c, w.id));
          emitsOf(t, w.emits);
          break;
        }
        case 'propertyList': {
          const t = needVariable(`${path}.source`, w.source, ['selection'], w.id);
          w.properties.forEach((c, k) => needProperty(`${path}.properties.${k}`, t, c, w.id));
          break;
        }
        case 'objectViewEmbed':
        case 'timeline':
          needVariable(`${path}.source`, w.source, ['selection'], w.id);
          break;
        case 'canvasEmbed':
          emitsOf(needVariable(`${path}.source`, w.source, ['objectSet'], w.id), w.emits);
          break;
        case 'chart': {
          const t = needVariable(`${path}.source`, w.source, ['objectSet'], w.id);
          if (w.measure.property !== undefined) needProperty(`${path}.measure.property`, t, w.measure.property, w.id);
          else if (w.measure.aggregate !== 'count') find(`${path}.measure`, 'measure_property', `${w.measure.aggregate} needs a property`);
          if (w.groupBy !== undefined) needProperty(`${path}.groupBy`, t, w.groupBy, w.id);
          break;
        }
        case 'metric': {
          const t = needVariable(`${path}.source`, w.source, ['objectSet'], w.id);
          if (w.property !== undefined) needProperty(`${path}.property`, t, w.property, w.id);
          else if (w.aggregate !== 'count' && w.functionId === undefined) find(`${path}`, 'measure_property', `${w.aggregate} needs a property`);
          if (w.functionId !== undefined) {
            if (!def.functions.includes(w.functionId)) find(`${path}.functionId`, 'function_undeclared', 'the app does not declare this Function');
            else use('function', w.functionId, w.id);
          }
          break;
        }
        case 'filterControls': {
          const t = needVariable(`${path}.target`, w.target, ['objectSet'], w.id);
          w.facets.forEach((f, k) => needProperty(`${path}.facets.${k}`, t, f, w.id));
          if (w.period !== undefined) needProperty(`${path}.period`, t, w.period, w.id, TIME);
          break;
        }
        case 'actionForm':
        case 'actionButton': {
          if (!def.actions.includes(w.actionTypeId)) find(`${path}.actionTypeId`, 'action_undeclared', 'the app does not declare this Action type');
          else use('actionType', w.actionTypeId, w.id);
          for (const [param, name] of Object.entries(w.params)) needVariable(`${path}.params.${param}`, name, ['selection', 'parameter', 'objectSet'], w.id);
          break;
        }
        case 'askPanel':
          w.scope.forEach((name, k) => needVariable(`${path}.scope.${k}`, name, ['objectSet', 'selection', 'parameter'], w.id));
          break;
        case 'scenarioControl':
          needVariable(`${path}.variable`, w.variable, ['scenario'], w.id);
          break;
        case 'map':
          needProperty(`${path}.geoPropertyId`, needVariable(`${path}.source`, w.source, ['objectSet'], w.id), w.geoPropertyId, w.id, GEO);
          break;
        case 'markdown':
          for (const token of w.text.matchAll(/\{\{([^}]*)\}\}/g)) {
            const [kind, ref] = token[1]!.split(':', 2).map((s) => s.trim());
            if (kind === 'label' && ref !== undefined && types.has(ref)) use('objectType', ref, w.id);
            else if (kind === 'count' && ref !== undefined && kinds.get(ref) === 'objectSet') varUse(ref, w.id);
            else find(`${path}.text`, 'interpolation', 'markdown inserts {{label:<object type>}} and {{count:<object set>}} only, never a value');
          }
          break;
        case 'approvalInbox':
          break;
      }
    });
  });

  // ---- Declared Functions and Action types exist.
  def.functions.forEach((f, i) => {
    if (!functions.has(f)) find(`functions.${i}`, 'function_unknown', 'no such Function in the bound ontology version');
    else if (!references.function.has(f)) use('function', f);
  });
  def.actions.forEach((a, i) => {
    const fact = actionTypes.get(a);
    if (!fact) find(`actions.${i}`, 'action_unknown', 'no such Action type');
    else if (fact.status !== 'confirmed') find(`actions.${i}`, 'action_unconfirmed', `the Action type is ${fact.status}`);
    else if (!references.actionType.has(a)) use('actionType', a);
  });

  // ---- Events and the graph they form.
  const edges = new Map<string, Set<string>>();
  const edge = (from: string, to: string): void => {
    const out = edges.get(from) ?? new Set<string>();
    out.add(to);
    edges.set(from, out);
  };
  for (const w of widgets.values()) {
    const source = 'source' in w ? w.source : 'target' in w ? w.target : undefined;
    const emitted = 'emits' in w ? w.emits?.selectionChanged : undefined;
    if (source !== undefined && emitted !== undefined) edge(source, emitted);
  }
  def.events.forEach((e, i) => {
    const path = `events.${i}`;
    const w = widgets.get(e.source.widget);
    if (!w) {
      find(`${path}.source.widget`, 'widget_unknown', `no widget ${e.source.widget}`);
      return;
    }
    if (!WIDGET_EVENTS[w.kind].includes(e.source.event)) find(`${path}.source.event`, 'event_unknown', `a ${w.kind} has no ${e.source.event} event`);
    if (e.condition !== undefined) {
      try {
        compileCel(e.condition, celNames);
      } catch {
        find(`${path}.condition`, 'cel_invalid', 'the condition does not compile');
      }
    }
    const reads = [...new Set([...('source' in w ? [w.source] : []), ...('target' in w ? [w.target] : []),
      ...('emits' in w && w.emits?.selectionChanged !== undefined ? [w.emits.selectionChanged] : [])])];
    e.effects.forEach((effect, k) => {
      const at = `${path}.effects.${k}`;
      switch (effect.kind) {
        case 'setVariable': {
          const target = kinds.get(effect.variable);
          const from = kinds.get(effect.from);
          if (target === undefined) find(`${at}.variable`, 'variable_unknown', `no variable ${effect.variable}`);
          if (from === undefined) find(`${at}.from`, 'variable_unknown', `no variable ${effect.from}`);
          if (target !== undefined && from !== undefined && (target !== from || variableType.get(effect.variable) !== variableType.get(effect.from))) {
            find(at, 'variable_kind', 'a variable is set only from one of the same kind and type');
          }
          for (const r of reads) edge(r, effect.variable);
          edge(effect.from, effect.variable);
          break;
        }
        case 'clearVariable':
          if (!kinds.has(effect.variable)) find(`${at}.variable`, 'variable_unknown', `no variable ${effect.variable}`);
          break;
        case 'navigate':
          if (!pageIds.has(effect.pageId)) find(`${at}.pageId`, 'page_unknown', `no page ${effect.pageId}`);
          break;
        case 'openObjectView':
          if (kinds.get(effect.variable) !== 'selection') find(`${at}.variable`, 'variable_kind', 'an object view opens a selection');
          break;
        case 'openActionForm':
          if (!def.actions.includes(effect.actionTypeId)) find(`${at}.actionTypeId`, 'action_undeclared', 'the app does not declare this Action type');
          for (const [param, name] of Object.entries(effect.params)) {
            if (!kinds.has(name)) find(`${at}.params.${param}`, 'variable_unknown', `no variable ${name}`);
          }
          break;
        case 'openAsk':
          effect.scope.forEach((name, n) => { if (!kinds.has(name)) find(`${at}.scope.${n}`, 'variable_unknown', `no variable ${name}`); });
          break;
        case 'refreshWidget':
          if (!widgets.has(effect.widget)) find(`${at}.widget`, 'widget_unknown', `no widget ${effect.widget}`);
          break;
      }
    });
  });
  const cycle = findCycle(edges);
  if (cycle !== undefined) find('events', 'event_cycle', `events form a cycle through ${cycle.join(' -> ')}`);

  for (const [i, pageId] of (def.mobile?.pages ?? []).entries()) {
    if (!pageIds.has(pageId)) find(`mobile.pages.${i}`, 'page_unknown', `no page ${pageId}`);
  }

  // ---- What the app references: each variable's type and links, attributed to the widgets that read it.
  for (const [name, v] of Object.entries(def.variables)) {
    if (v.kind !== 'objectSet' && v.kind !== 'selection') continue;
    const users = [...(variableUsers.get(name) ?? [])];
    if (types.has(v.objectTypeId)) for (const w of users.length > 0 ? users : [undefined]) use('objectType', v.objectTypeId, w);
    if (v.kind === 'objectSet') {
      for (const hop of v.traversal ?? []) if (links.has(hop.linkTypeId)) for (const w of users.length > 0 ? users : [undefined]) use('linkType', hop.linkTypeId, w);
      for (const property of v.filter?.properties ?? []) if (propertyOf(v.objectTypeId, property)) use('property', property);
    }
  }
  return { definition: def, findings, references };
}

function findCycle(edges: ReadonlyMap<string, ReadonlySet<string>>): string[] | undefined {
  const state = new Map<string, 1 | 2>();
  const path: string[] = [];
  const visit = (node: string): string[] | undefined => {
    state.set(node, 1);
    path.push(node);
    for (const next of edges.get(node) ?? []) {
      if (state.get(next) === 1) return [...path.slice(path.indexOf(next)), next];
      if (state.get(next) === undefined) {
        const found = visit(next);
        if (found) return found;
      }
    }
    path.pop();
    state.set(node, 2);
    return undefined;
  };
  for (const node of edges.keys()) {
    if (state.get(node) === undefined) {
      const found = visit(node);
      if (found) return found;
    }
  }
  return undefined;
}
