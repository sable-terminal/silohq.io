// Opening an app (spec 35.6): under the viewer's permissions, never the author's. Every
// variable, widget binding, Function and Action reference is re-resolved against the
// viewer's own access (policy's resolveAccess: markings, connection grants, field
// policies); the app reveals nothing the viewer could not query directly.
//
// - A withheld column, property or facet is dropped and the widget is reduced; a widget
//   whose whole binding is unavailable is an empty frame saying so; an Action the viewer
//   may not see is disabled with the reason.
// - The version's markings (the union over what it references) must be satisfied for an
//   app that requires full clearance, or it does not open and names the missing marking
//   classes; otherwise marked elements are dropped and the open is reduced and audited.
// - A published version the ontology has since invalidated is never altered: its invalid
//   widgets show "unavailable since ontology version N".
// What is withheld is counted, never named.

import { appDefinition, type AppDefinition, type AppWidget } from '../../contracts/studio/definition.contract.ts';
import type { AppPreview, OpenedApp } from '../../contracts/studio/app.contract.ts';
import { runObjectSet, type RunOutcome } from '../../contracts/executor/result.contract.ts';
import { compileCel } from '../expression-evaluator/cel.service.ts';
import type { SetDefinition } from '../../contracts/ontology/objectSet.contract.ts';
import { inTransaction } from '../../infra/postgres.infra.ts';
import { markingRepo } from '../../repos/gov/index.repo.ts';
import { appRepo, appVersionRepo } from '../../repos/workspace/index.repo.ts';
import { AppError } from '../../utils/errors.util.ts';
import { accessTo, appView, check, markingsOf, skeleton } from './apps.service.ts';
import { access, appNotFound, demand, mainManifest, member, recordEvent, recordServiceEvent, type Context, type StudioDeps } from './deps.service.ts';
import { layoutDefinition, layoutFindings } from './layoutRules.service.ts';
import { servedVersionId } from './releases.service.ts';
import { instantiate, type Bindings, type TemplateName } from './templates.service.ts';

type Status = OpenedApp['widgets'][number];

const WITHHELD = 'Part of this app is not visible to you, so it is not shown.';

/** The property ids a widget binds, and where in the widget each list lives. */
function boundProperties(w: AppWidget): string[] {
  switch (w.kind) {
    case 'objectTable': return w.columns;
    case 'objectList':
    case 'propertyList': return w.properties;
    case 'filterControls': return [...w.facets, ...(w.period === undefined ? [] : [w.period])];
    case 'chart': return [...(w.measure.property === undefined ? [] : [w.measure.property]), ...(w.groupBy === undefined ? [] : [w.groupBy])];
    case 'metric': return w.property === undefined ? [] : [w.property];
    case 'map': return [w.geoPropertyId];
    default: return [];
  }
}

/** A definition as this viewer would see it: what they may not see dropped, counted and never named. */
export interface Rendered {
  pages: AppDefinition['pages']; widgets: Status[]; withheld: number; reduced: boolean;
  /** The ontology version whose change left widgets invalid, and how many. */
  invalidAt?: { version: number; widgets: number } | undefined;
}

/**
 * Renders a definition for the viewer in ctx (35.6): undefined when they may not open it at
 * all. With fullClearance, missing markings refuse it, naming their classes.
 */
export async function renderFor(deps: StudioDeps, ctx: Context, def: AppDefinition, markings: readonly string[], fullClearance: boolean)
  : Promise<Rendered | undefined> {
  const widgetsAll = def.pages.flatMap((p) => p.widgets);

  // What the version references, re-resolved for this viewer.
  const typeIds = [...new Set(Object.values(def.variables).flatMap((v) => (v.kind === 'objectSet' || v.kind === 'selection' ? [v.objectTypeId] : [])))];
  const linkIds = [...new Set(Object.values(def.variables).flatMap((v) => (v.kind === 'objectSet' ? (v.traversal ?? []).map((h) => h.linkTypeId) : [])))];
  const propertyIds = [...new Set(widgetsAll.flatMap(boundProperties))];
  const decided = await access(deps, ctx, { objectTypes: typeIds, properties: propertyIds, linkTypes: linkIds, actionTypes: def.actions, markings: [...markings] });
  if (decided.decision !== 'allow') return undefined;
  const unsatisfied = decided.markings.filter((m) => !m.satisfied).map((m) => m.id);
  if (unsatisfied.length > 0 && fullClearance) {
    const classes = await inTransaction(deps.databases.pool('control'), ctx.request, async (db) => {
      const kinds = new Set<string>();
      for (const id of unsatisfied) {
        const marking = await markingRepo.findById(db, id);
        if (marking) kinds.add(marking.kind);
      }
      return [...kinds].sort();
    }, { readOnly: true });
    throw new AppError('forbidden', `this app needs full clearance: missing ${classes.join(', ')} markings`, {
      code: 'studio.clearance_required', details: { markingClasses: classes.join(',') },
    });
  }
  const visibleType = new Set(decided.objectTypes.filter((t) => t.visible).map((t) => t.id));
  const visibleLink = new Set(decided.linkTypes.filter((l) => l.visible).map((l) => l.id));
  const visibleAction = new Set(decided.actionTypes.filter((a) => a.visible).map((a) => a.id));
  const visibleProperty = new Set(decided.properties.filter((p) => p.visible && p.effect !== 'deny').map((p) => p.id));
  const withheld = typeIds.filter((t) => !visibleType.has(t)).length + linkIds.filter((l) => !visibleLink.has(l)).length
    + def.actions.filter((a) => !visibleAction.has(a)).length + propertyIds.filter((p) => !visibleProperty.has(p)).length;

  // Widgets the current ontology has invalidated (never altered silently).
  const main = await mainManifest(deps, ctx);
  const invalid = new Set<string>();
  if (main.version.sequence !== def.ontologyVersion) {
    const current = await check(deps, ctx, { ...def, ontologyVersion: main.version.sequence } as unknown as Record<string, unknown>);
    for (const f of current.findings) {
      const match = /^pages\.(\d+)\.widgets\.(\d+)/.exec(f.path);
      if (match) invalid.add(def.pages[Number(match[1])]?.widgets[Number(match[2])]?.id ?? '');
    }
  }

  const variableVisible = (name: string): boolean => {
    const v = def.variables[name];
    if (v === undefined) return false;
    if (v.kind === 'objectSet') return visibleType.has(v.objectTypeId) && (v.traversal ?? []).every((h) => visibleLink.has(h.linkTypeId));
    if (v.kind === 'selection') return visibleType.has(v.objectTypeId);
    return true;
  };
  const statuses: Status[] = [];
  const reducedPages = def.pages.map((page) => ({
    ...page,
    widgets: page.widgets.map((w): AppWidget => {
      const set = (status: Status['status'], reason: string | null): void => { statuses.push({ id: w.id, status, reason }); };
      if (invalid.has(w.id)) {
        set('unavailable', `unavailable since ontology version ${main.version.sequence}`);
        return w;
      }
      const source = 'source' in w ? w.source : 'target' in w ? w.target : undefined;
      if (source !== undefined && !variableVisible(source)) {
        set('unavailable', 'not visible to you');
        return w;
      }
      if ((w.kind === 'actionForm' || w.kind === 'actionButton') && !visibleAction.has(w.actionTypeId)) {
        set('disabled', 'you may not submit this Action');
        return w;
      }
      const bound = boundProperties(w);
      const kept = bound.filter((p) => visibleProperty.has(p));
      if (kept.length === bound.length) {
        set('available', null);
        return w;
      }
      // A widget whose required binding is gone is an empty frame; a list loses only what is withheld.
      if (w.kind === 'objectTable' || w.kind === 'propertyList') {
        const remaining = (w.kind === 'objectTable' ? w.columns : w.properties).filter((p) => visibleProperty.has(p));
        if (remaining.length === 0) {
          set('unavailable', 'not visible to you');
          return w;
        }
        set('reduced', 'part of it is not visible to you');
        return w.kind === 'objectTable' ? { ...w, columns: remaining } : { ...w, properties: remaining };
      }
      if (w.kind === 'objectList') {
        set('reduced', 'part of it is not visible to you');
        return { ...w, properties: w.properties.filter((p) => visibleProperty.has(p)) };
      }
      if (w.kind === 'filterControls') {
        set('reduced', 'part of it is not visible to you');
        const { period, ...rest } = w;
        return { ...rest, facets: w.facets.filter((p) => visibleProperty.has(p)), ...(period !== undefined && visibleProperty.has(period) ? { period } : {}) };
      }
      set('unavailable', 'not visible to you');
      return w;
    }),
  }));
  const reduced = withheld > 0 || statuses.some((s) => s.status !== 'available' && s.reason !== null && !s.reason.startsWith('unavailable since'));
  // The ontology version that invalidated widgets, if any: the open records it once (35.13).
  return { pages: reducedPages, widgets: statuses, withheld, reduced, invalidAt: invalid.size > 0 ? { version: main.version.sequence, widgets: invalid.size } : undefined };
}

export async function open(deps: StudioDeps, ctx: Context, appId: string, version: number | undefined): Promise<OpenedApp> {
  const me = member(ctx);
  const loaded = await inTransaction(deps.databases.pool('control'), me.request, async (db) => {
    const app = await appRepo.findById(db, appId);
    if (!app || app.kind !== 'app' || app.archivedAt !== null) return undefined;
    const held = await accessTo(db, app, me.membershipId);
    if (held === undefined) return undefined;
    const editor = held === 'owner' || held === 'edit';
    // Unnamed, the version this viewer is served: a staged release decides it (D230).
    const served = version === undefined ? await servedVersionId(db, app, me.membershipId, held) : null;
    const row = version !== undefined
      ? (editor ? await appVersionRepo.findByAppIdAndVersion(db, { organisationId: me.organisationId, appId, version }) : undefined)
      : served === null ? undefined : await appVersionRepo.findById(db, served);
    return { app, held, row };
  }, { readOnly: true });
  if (loaded === undefined) throw appNotFound();
  const { app, held, row } = loaded;
  if (row === undefined) throw new AppError('not_found', 'the app has no published version', { code: 'studio.not_published' });

  const parsed = appDefinition.safeParse(row.definition);
  if (!parsed.success) throw new AppError('conflict', 'this version does not validate and cannot run', { code: 'studio.version_invalid' });
  const def: AppDefinition = parsed.data;

  const rendered = await renderFor(deps, ctx, def, row.markings, app.requireFullClearance);
  if (rendered === undefined) throw appNotFound();
  const { pages: reducedPages, widgets: statuses, withheld, reduced, invalidAt } = rendered;
  await inTransaction(deps.databases.pool('control'), me.request, async (db) => {
    // Every open: who opened which version (54.1: the AI FDE's time to first app reads it).
    await recordEvent(db, me, ctx.correlationId, {
      event: 'app_opened', resource: { type: 'app', id: app.id }, detail: { version: row.version, published: version === undefined, reduced },
    });
    if (reduced) {
      await recordEvent(db, me, ctx.correlationId, {
        event: 'app_opened_with_reduced_permissions', resource: { type: 'app', id: app.id },
        detail: { version: row.version, dropped: withheld, widgets_affected: statuses.filter((s) => s.status !== 'available').length },
      });
    }
    // An ontology change left widgets of this version invalid (never altered silently): recorded once per version and ontology version,
    // as studio's finding, its owner the subject.
    if (invalidAt !== undefined && await appVersionRepo.markInvalidated(db, row.id, invalidAt.version)) {
      await recordServiceEvent(db, me.organisationId, ctx.correlationId, {
        event: 'app_invalidated_by_ontology_change', resource: { type: 'app', id: app.id }, subjectMembershipId: app.ownerMembershipId,
        detail: { version: row.version, ontology_version: invalidAt.version, built_on: def.ontologyVersion, widgets: invalidAt.widgets },
      });
    }
  });
  return {
    app: appView(app, held, undefined), version: { id: row.id, version: row.version, ontologyVersion: def.ontologyVersion },
    definition: { ...def, pages: reducedPages } as unknown as Record<string, never>, widgets: statuses, withheld,
    statement: reduced ? WITHHELD : null,
  };
}

/** The version the viewer may run: a draft by number for its author and co-editors, otherwise the published one (as open). */
export async function runnableVersion(deps: StudioDeps, ctx: Context, appId: string, version: number | undefined): Promise<AppDefinition> {
  const me = member(ctx);
  const row = await inTransaction(deps.databases.pool('control'), me.request, async (db) => {
    const app = await appRepo.findById(db, appId);
    if (!app || app.kind !== 'app' || app.archivedAt !== null) return undefined;
    const held = await accessTo(db, app, me.membershipId);
    if (held === undefined) return undefined;
    const editor = held === 'owner' || held === 'edit';
    if (version !== undefined) return editor ? appVersionRepo.findByAppIdAndVersion(db, { organisationId: me.organisationId, appId, version }) : undefined;
    const served = await servedVersionId(db, app, me.membershipId, held);
    return served === null ? undefined : appVersionRepo.findById(db, served);
  }, { readOnly: true });
  if (row === undefined) throw appNotFound();
  const parsed = appDefinition.safeParse(row.definition);
  if (!parsed.success) throw new AppError('conflict', 'this version does not validate and cannot run', { code: 'studio.version_invalid' });
  return parsed.data;
}

/**
 * The app's parameter variables as names its predicates read: every one it declares, unset as null.
 * A name it does not declare is refused.
 */
export function parameterBindings(def: AppDefinition, given: Readonly<Record<string, string | number | boolean | null>>): Record<string, string | number | boolean | null> {
  const parameterNames = Object.entries(def.variables).filter(([, v]) => v.kind === 'parameter').map(([n]) => n);
  const unknown = Object.keys(given).filter((n) => !parameterNames.includes(n));
  if (unknown.length > 0) throw new AppError('validation', `${unknown.join(', ')} ${unknown.length === 1 ? 'is not a parameter' : 'are not parameters'} of this app`, { code: 'studio.parameter_unknown' });
  return Object.fromEntries(parameterNames.map((n) => [n, given[n] ?? null]));
}

/**
 * One object set variable of an app, run for the viewer (35.2, 35.6): the definition the version
 * holds, evaluated by the executor under the viewer's own access, with the app's parameter
 * variables bound by name. Only the app's own parameters are bound, and only as values; an unset
 * one is null to the predicate.
 */
export async function runVariable(deps: StudioDeps, ctx: Context, appId: string, name: string,
  input: { version?: number | undefined; select: readonly string[]; parameters: Readonly<Record<string, string | number | boolean | null>> }): Promise<RunOutcome> {
  const def = await runnableVersion(deps, ctx, appId, input.version);
  const variable = def.variables[name];
  if (variable === undefined || variable.kind !== 'objectSet') {
    throw new AppError('not_found', 'the app has no object set variable of that name', { code: 'studio.variable_not_found' });
  }
  const bindings = parameterBindings(def, input.parameters) as Record<string, never>;
  const parameterNames = Object.keys(bindings);
  const predicate = variable.filter === undefined ? undefined : { cel: variable.filter.cel, properties: [...variable.filter.properties] };
  const definition: SetDefinition = variable.traversal !== undefined && variable.traversal.length > 0
    ? { kind: 'traversal', start: { objectTypeId: variable.objectTypeId, ...(predicate === undefined ? {} : { predicate }) }, path: variable.traversal.map((h) => ({ linkTypeId: h.linkTypeId, direction: h.direction })) }
    : { kind: 'filter', base: { objectTypeId: variable.objectTypeId }, predicate: predicate ?? { cel: 'true', properties: [] } };
  return deps.services.call(runObjectSet, {
    body: { definition, ...(parameterNames.length === 0 ? {} : { bindings }), select: [...input.select], trigger: 'app_widget', useCache: true },
  }, { request: ctx.request, correlationId: ctx.correlationId });
}

const EXPRESSION_BOUNDS = { steps: 10_000, timeMs: 10 };

/**
 * Visibility rules and event conditions for the viewer's current values (35.2): compiled with every
 * variable as a name, as the validator compiles them, and evaluated within the expression bounds.
 * A variable the app does not declare is refused; one not given is null; a failing rule does not hold.
 */
export async function evaluateExpressions(deps: StudioDeps, ctx: Context, appId: string,
  input: { version?: number | undefined; values: Readonly<Record<string, string | number | boolean | null | readonly string[]>> }): Promise<{ widgets: Record<string, boolean>; events: Record<string, boolean> }> {
  const def = await runnableVersion(deps, ctx, appId, input.version);
  const names = Object.keys(def.variables);
  const unknown = Object.keys(input.values).filter((n) => !names.includes(n));
  if (unknown.length > 0) throw new AppError('validation', `${unknown.join(', ')} ${unknown.length === 1 ? 'is not a variable' : 'are not variables'} of this app`, { code: 'studio.variable_unknown' });
  const types = Object.fromEntries(names.map((n) => [n, 'dyn' as const]));
  const activation = Object.fromEntries(names.map((n) => [n, input.values[n] ?? null]));
  const holds = (source: string): boolean => {
    try {
      return compileCel(source, types).evaluate(activation, EXPRESSION_BOUNDS) === true;
    } catch {
      return false;
    }
  };
  const widgets: Record<string, boolean> = {};
  for (const page of def.pages) for (const w of page.widgets) if (w.visibleWhen !== undefined) widgets[w.id] = holds(w.visibleWhen);
  const events: Record<string, boolean> = {};
  def.events.forEach((e, i) => { if (e.condition !== undefined) events[String(i)] = holds(e.condition); });
  return { widgets, events };
}

/**
 * A definition, or a template's, validated against main and rendered for the caller, saving
 * nothing (50.9, 51.8). A principal previews within its ceiling; a person, under their own
 * permissions. Findings mean it would save as an invalid draft: nothing is rendered.
 */
export async function preview(deps: StudioDeps, ctx: Context,
  input: {
    name: string; template?: { name: TemplateName; bindings: Bindings }; definition?: Record<string, unknown>; layoutFor?: string | undefined;
    layout?: { objectTypeId: string; actionTypeId?: string | undefined };
  }): Promise<AppPreview> {
  await demand(deps, ctx, { permission: 'app.create' });
  const manifest = await mainManifest(deps, ctx);
  const layoutType = input.layout === undefined ? undefined : manifest.objectTypes.find((t) => t.id === input.layout!.objectTypeId && t.status === 'active');
  if (input.layout !== undefined && layoutType === undefined) throw new AppError('validation', 'a layout is for an active object type', { code: 'studio.layout_type' });
  const definition = (input.definition ?? (layoutType !== undefined ? layoutDefinition(layoutType, manifest, input.layout?.actionTypeId)
    : input.template !== undefined ? instantiate(input.template.name, input.template.bindings, manifest) : skeleton(input.name, manifest))) as Record<string, unknown>;
  const checked = await check(deps, ctx, definition);
  const layoutFor = input.layoutFor ?? layoutType?.id;
  if (layoutFor !== undefined) checked.findings.push(...layoutFindings(definition, layoutFor));
  const markings = await inTransaction(deps.databases.pool('control'), ctx.request, (db) => markingsOf(db, checked.references), { readOnly: true });
  const parsed = appDefinition.safeParse(definition);
  if (checked.findings.length > 0 || !parsed.success) return { definition: definition as never, findings: checked.findings, markings, rendered: null };
  const rendered = await renderFor(deps, ctx, parsed.data, markings, false);
  return {
    definition: definition as never, findings: [], markings,
    rendered: rendered === undefined ? null : {
      definition: { ...parsed.data, pages: rendered.pages } as never, widgets: rendered.widgets, withheld: rendered.withheld,
      statement: rendered.reduced ? WITHHELD : null,
    },
  };
}
