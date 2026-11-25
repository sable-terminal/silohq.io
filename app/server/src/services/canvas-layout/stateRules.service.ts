// State rules (spec 28.4): proposed against main's ontology, confirmed by a person, retired.
// The type and every input are checked against main's head on proposal and again on
// confirmation, so a rule never reads a property the ontology no longer has. Markings are
// computed from the type and the inputs (direct markings), never supplied by the caller.

import type { StateRuleEntry, StateRuleView } from '../../contracts/canvas-layout/stateRule.contract.ts';
import type { OntologyManifest } from '../../contracts/ontology/manifest.contract.ts';
import { inTransaction, type Queryable } from '../../infra/postgres.infra.ts';
import type { StateRule } from '../../models/clone/stateRule.model.ts';
import { stateRuleRepo } from '../../repos/clone/index.repo.ts';
import { resourceMarkingRepo } from '../../repos/gov/index.repo.ts';
import { objectTypeMarkingRepo } from '../../repos/iam/index.repo.ts';
import { AppError } from '../../utils/errors.util.ts';
import { uuidv7 } from '../../utils/id.util.ts';
import { access, actor, demand, mainManifest, member, notFound, recordEvent, type CanvasDeps, type Context } from './deps.service.ts';
import { compileStateRules, evaluateState, refuseIssues, type InputState, type RuleInput } from './stateEvaluation.service.ts';

const ruleNotFound = () => notFound('state rule', 'clone.state_rule_not_found');
const stale = () => new AppError('conflict', 'the rule changed since you read it', { code: 'clone.state_rule_stale' });

/** The inputs, as properties of an active type in this manifest; refused naming the first that is not. */
export function resolveInputs(manifest: OntologyManifest, objectTypeId: string, propertyIds: readonly string[]): RuleInput[] {
  const type = manifest.objectTypes.find((t) => t.id === objectTypeId && t.status === 'active');
  if (!type) throw new AppError('validation', 'no such object type on main', { code: 'clone.object_type_unknown' });
  return [...new Set(propertyIds)].map((id) => {
    const property = type.properties.find((p) => p.identityId === id && p.status === 'active');
    if (!property) {
      throw new AppError('validation', 'an input is not an active property of the type', { code: 'clone.input_unknown', details: { propertyId: id } });
    }
    return { propertyIdentityId: id, apiName: property.apiName, dataType: property.dataType };
  });
}

/** The union of the type's and the inputs' direct markings (spec 28.4: a state inherits the markings of every input). */
async function markingsOf(db: Queryable, objectTypeId: string, propertyIds: readonly string[]): Promise<string[]> {
  const marks = [
    ...await objectTypeMarkingRepo.markingsFor(db, [objectTypeId]),
    ...await resourceMarkingRepo.markingsFor(db, 'property', propertyIds),
  ];
  return [...new Set(marks.map((m) => m.markingId))].sort();
}

export function ruleView(rule: StateRule, manifest?: OntologyManifest): StateRuleView {
  const type = manifest?.objectTypes.find((t) => t.id === rule.objectTypeId);
  return {
    id: rule.id, objectTypeId: rule.objectTypeId, version: rule.version,
    status: rule.retiredAt !== null ? 'retired' : rule.confirmedAt !== null ? 'active' : 'proposed',
    inputs: rule.inputPropertyIds.map((id) => {
      const property = type?.properties.find((p) => p.identityId === id);
      return { propertyIdentityId: id, apiName: property?.apiName ?? '', dataType: property?.dataType ?? '' };
    }),
    rules: rule.rules as StateRuleEntry[], compiledHash: rule.compiledHash, freshnessWindowSeconds: rule.freshnessWindowSeconds,
    markingIds: rule.markingIds,
    proposedBy: rule.proposedByMembershipId !== null
      ? { kind: 'membership', membershipId: rule.proposedByMembershipId }
      : { kind: 'service_principal', servicePrincipalId: rule.proposedByServicePrincipalId! },
    confirmedBy: rule.confirmedBy, confirmedAt: rule.confirmedAt, retiredAt: rule.retiredAt, createdAt: rule.createdAt, lockVersion: rule.lockVersion,
  };
}

/** state_rule.manage, which requires ontology.manage on the type (spec 32.5). */
async function demandManage(deps: CanvasDeps, ctx: Context, objectTypeId: string): Promise<void> {
  await demand(deps, ctx, { permission: 'state_rule.manage', resource: { type: 'object_type', id: objectTypeId } });
  await demand(deps, ctx, { permission: 'ontology.manage', resource: { type: 'object_type', id: objectTypeId } });
}

export interface ProposeInput {
  objectTypeId: string;
  inputPropertyIds: string[];
  rules: StateRuleEntry[];
  freshnessWindowSeconds: number;
}

export async function propose(deps: CanvasDeps, ctx: Context, input: ProposeInput): Promise<StateRuleView> {
  const who = actor(ctx);
  await demandManage(deps, ctx, input.objectTypeId);
  const manifest = await mainManifest(deps, ctx);
  const inputs = resolveInputs(manifest, input.objectTypeId, input.inputPropertyIds);
  const compiled = compileStateRules(inputs, input.rules, input.freshnessWindowSeconds);
  if ('issues' in compiled) throw refuseIssues(compiled.issues);
  return inTransaction(deps.databases.pool('control'), who.request, async (db) => {
    const row = await stateRuleRepo.insert(db, {
      id: uuidv7(), organisationId: who.organisationId, objectTypeId: input.objectTypeId,
      version: await stateRuleRepo.nextVersion(db, input.objectTypeId),
      inputPropertyIds: inputs.map((i) => i.propertyIdentityId), rules: input.rules, compiledHash: compiled.compiled.hash,
      freshnessWindowSeconds: input.freshnessWindowSeconds, markingIds: await markingsOf(db, input.objectTypeId, inputs.map((i) => i.propertyIdentityId)),
      proposedByMembershipId: who.membershipId ?? null, proposedByServicePrincipalId: who.membershipId === undefined ? who.servicePrincipalId! : null,
    });
    await recordEvent(db, who, ctx.correlationId, {
      event: 'state_rule_proposed', resource: { type: 'state_rule', id: row.id },
      detail: { object_type_id: row.objectTypeId, version: row.version, rules: input.rules.length, inputs: inputs.length },
    });
    return ruleView(row, manifest);
  });
}

/** A person confirms (invariant 9). The type's active rule is retired in the same transaction. */
export async function confirm(deps: CanvasDeps, ctx: Context, ruleId: string, lockVersion: number): Promise<StateRuleView> {
  const me = member(ctx);
  const found = await inTransaction(deps.databases.pool('control'), me.request, (db) => stateRuleRepo.findById(db, ruleId), { readOnly: true });
  if (!found) throw ruleNotFound();
  await demandManage(deps, ctx, found.objectTypeId);
  // Re-checked against main now: the ontology may have moved since the proposal.
  const manifest = await mainManifest(deps, ctx);
  const inputs = resolveInputs(manifest, found.objectTypeId, found.inputPropertyIds);
  const compiled = compileStateRules(inputs, found.rules as StateRuleEntry[], found.freshnessWindowSeconds);
  if ('issues' in compiled) throw refuseIssues(compiled.issues);
  return inTransaction(deps.databases.pool('control'), me.request, async (db) => {
    const rule = await stateRuleRepo.findForUpdate(db, ruleId);
    if (!rule) throw ruleNotFound();
    if (rule.lockVersion !== lockVersion) throw stale();
    if (rule.retiredAt !== null || rule.confirmedAt !== null) {
      throw new AppError('conflict', 'only a proposed rule is confirmed', { code: 'clone.state_rule_not_proposed' });
    }
    const now = new Date().toISOString();
    const previous = await stateRuleRepo.findActiveForUpdate(db, rule.objectTypeId);
    if (previous) await stateRuleRepo.update(db, previous.id, { retiredAt: now, lockVersion: previous.lockVersion + 1 });
    const confirmed = (await stateRuleRepo.update(db, rule.id, {
      confirmedBy: me.membershipId, confirmedAt: now, lockVersion: rule.lockVersion + 1,
      // The inputs' markings now, which the rule carries for its life.
      markingIds: await markingsOf(db, rule.objectTypeId, rule.inputPropertyIds),
    }))!;
    await recordEvent(db, me, ctx.correlationId, {
      event: previous ? 'state_rule_revised' : 'state_rule_confirmed', resource: { type: 'state_rule', id: rule.id },
      detail: { object_type_id: rule.objectTypeId, version: rule.version, ...(previous ? { replaced_version: previous.version } : {}) },
    });
    return ruleView(confirmed, manifest);
  });
}

export async function retire(deps: CanvasDeps, ctx: Context, ruleId: string, lockVersion: number): Promise<StateRuleView> {
  const me = member(ctx);
  const found = await inTransaction(deps.databases.pool('control'), me.request, (db) => stateRuleRepo.findById(db, ruleId), { readOnly: true });
  if (!found) throw ruleNotFound();
  await demandManage(deps, ctx, found.objectTypeId);
  return inTransaction(deps.databases.pool('control'), me.request, async (db) => {
    const rule = await stateRuleRepo.findForUpdate(db, ruleId);
    if (!rule) throw ruleNotFound();
    if (rule.lockVersion !== lockVersion) throw stale();
    if (rule.retiredAt !== null) return ruleView(rule);
    const retired = (await stateRuleRepo.update(db, rule.id, { retiredAt: new Date().toISOString(), lockVersion: rule.lockVersion + 1 }))!;
    await recordEvent(db, me, ctx.correlationId, {
      event: 'state_rule_retired', resource: { type: 'state_rule', id: rule.id },
      detail: { object_type_id: rule.objectTypeId, version: rule.version, was_active: rule.confirmedAt !== null },
    });
    return ruleView(retired);
  });
}

/** Every version of a type's rules, for a holder of clone.view. */
export async function list(deps: CanvasDeps, ctx: Context, objectTypeId: string): Promise<StateRuleView[]> {
  const who = actor(ctx);
  await demand(deps, ctx, { permission: 'clone.view', resource: { type: 'object_type', id: objectTypeId } });
  const manifest = await mainManifest(deps, ctx);
  const rows = await inTransaction(deps.databases.pool('control'), who.request, (db) => stateRuleRepo.listForType(db, objectTypeId), { readOnly: true });
  return rows.map((r) => ruleView(r, manifest));
}

/** The active rules of these types: what the state plane subscribes to and both sides evaluate. */
export async function active(deps: CanvasDeps, ctx: Context, objectTypeIds: readonly string[]): Promise<StateRuleView[]> {
  const who = actor(ctx);
  const manifest = await mainManifest(deps, ctx);
  const rows = await inTransaction(deps.databases.pool('control'), who.request, (db) => stateRuleRepo.activeFor(db, [...new Set(objectTypeIds)]),
    { readOnly: true });
  return rows.map((r) => ruleView(r, manifest));
}

/** One rule by id: a keyed proposal's replay. */
export async function read(deps: CanvasDeps, ctx: Context, ruleId: string): Promise<StateRuleView> {
  const who = actor(ctx);
  const row = await inTransaction(deps.databases.pool('control'), who.request, (db) => stateRuleRepo.findById(db, ruleId), { readOnly: true });
  if (!row) throw ruleNotFound();
  return ruleView(row, await mainManifest(deps, ctx));
}

/** The active rule over values the caller read (28.4, 35.5): unknown, with why, where an input was not sent or is not visible to them. */
export async function evaluateFor(deps: CanvasDeps, ctx: Context, input: { objectTypeId: string; objects: { ref: string; values: Record<string, unknown> }[] }) {
  const [rule] = await active(deps, ctx, [input.objectTypeId]);
  if (rule === undefined) return { rule: false, states: input.objects.map((o) => ({ ref: o.ref, state: 'normal' as const, reason: 'no state rule is active for this type' })) };
  const compiled = compileStateRules(rule.inputs, rule.rules, rule.freshnessWindowSeconds);
  if (!('compiled' in compiled)) throw new AppError('integrity', 'an active state rule does not compile', { code: 'clone.rule_invalid' });
  const seen = await access(deps, ctx, { properties: rule.inputs.map((i) => i.propertyIdentityId) });
  const visible = new Set(seen.decision === 'allow' ? seen.properties.filter((p) => p.visible && p.effect === 'allow').map((p) => p.id) : []);
  const now = new Date();
  return {
    rule: true,
    states: input.objects.map((o) => {
      const inputs: Record<string, InputState> = Object.fromEntries(compiled.compiled.inputs.map((i) => [i.propertyIdentityId, {
        value: o.values[i.apiName] ?? null, visible: visible.has(i.propertyIdentityId) && i.apiName in o.values,
      }]));
      const evaluated = evaluateState(compiled.compiled, inputs, now);
      return { ref: o.ref, state: evaluated.state, reason: evaluated.reason };
    }),
  };
}
