// Unresolved pairs (spec 23.2): records that exact resolution left apart but that may be the
// same things under keys differing by a format the normalisation does not cover.
//
// A candidate rule is a CEL normalisation over `value` (each key component as normalised so
// far). It is judged on every keyed record of the type, never on a sample:
// - pairs: objects it would merge across contributing objects (each counted once, as the
//   objects that would change identity);
// - ambiguous: it would give two records of one contributing object, with different keys
//   today, one key (a merge within a system is a guess, not a format);
// - lost: an object that spans systems today would come apart.
// A rule that is ambiguous or loses anything is never proposed; a wrong merge is worse than
// failing to merge.
//
// Deterministic candidates come first, from a fixed catalogue of the normalisations the
// spec names (trimming, case folding, separator removal, a declared prefix strip, leading
// zero removal), each and composed. For what they leave, the model is asked, with the key
// shapes (character class runs, separator positions) and counts of the unmatched records,
// never a key; its rules are judged the same way. Keys live only in this process's memory
// for the run.

import { z } from 'zod';
import { callModel, outputSpec, parseOutput } from '../../contracts/model-gateway/call.contract.ts';
import type { ObjectTypeView } from '../../contracts/ontology/manifest.contract.ts';
import { compileCel, type CompiledCel } from '../expression-evaluator/cel.service.ts';
import type { Context, ResolutionDeps } from './deps.service.ts';
import { applyNormalisations, keyShape } from './identity.service.ts';

export interface AnalysisRecord {
  /** Index of the contributing object. */
  source: number;
  /** The key components as normalised today. */
  components: readonly string[];
  /** Its object today. */
  object: string;
}

export interface RuleJudgement {
  pairs: number;
  ambiguous: boolean;
  lost: number;
  /** The new groups that merge objects across systems: record indexes. */
  groups: number[][];
}

export interface Candidate {
  cel: string;
  steps: string[];
  basis: 'deterministic' | 'model';
}

const compiledRule = (cel: string): CompiledCel | undefined => {
  try {
    return compileCel(cel, { value: 'string' });
  } catch {
    return undefined;
  }
};

/** What a rule would do to today's records. Undefined when it does not compile. */
export function judgeRule(records: readonly AnalysisRecord[], cel: string): RuleJudgement | undefined {
  const rule = compiledRule(cel);
  if (rule === undefined) return undefined;
  const newKeys = records.map((r) => {
    const out: string[] = [];
    for (const c of r.components) {
      const n = applyNormalisations(c, [rule]);
      if (n === undefined) return undefined;
      out.push(n);
    }
    return JSON.stringify(out);
  });
  // Objects today, and whether each spans systems.
  const objectSources = new Map<string, Set<number>>();
  records.forEach((r) => (objectSources.get(r.object) ?? objectSources.set(r.object, new Set()).get(r.object)!).add(r.source));
  // New groups.
  const groups = new Map<string, number[]>();
  newKeys.forEach((k, i) => {
    if (k !== undefined) (groups.get(k) ?? groups.set(k, []).get(k)!).push(i);
  });
  let ambiguous = false;
  let pairs = 0;
  const merging: number[][] = [];
  for (const members of groups.values()) {
    const perSource = new Map<number, Set<string>>();
    for (const i of members) {
      const r = records[i]!;
      (perSource.get(r.source) ?? perSource.set(r.source, new Set()).get(r.source)!).add(JSON.stringify(r.components));
    }
    if ([...perSource.values()].some((keys) => keys.size > 1)) ambiguous = true;
    const objects = new Set(members.map((i) => records[i]!.object));
    if (objects.size > 1 && perSource.size > 1) {
      pairs += objects.size - 1;
      merging.push(members);
    }
  }
  // An object spanning systems today whose records no longer share one key.
  let lost = 0;
  const objectKeys = new Map<string, Set<string | undefined>>();
  records.forEach((r, i) => (objectKeys.get(r.object) ?? objectKeys.set(r.object, new Set()).get(r.object)!).add(newKeys[i]));
  for (const [object, keys] of objectKeys) {
    if ((objectSources.get(object)?.size ?? 0) > 1 && (keys.size > 1 || keys.has(undefined))) lost += 1;
  }
  return { pairs, ambiguous, lost, groups: merging };
}

/** Records whose object no other contributing object holds. */
export function unmatched(records: readonly AnalysisRecord[]): AnalysisRecord[] {
  const objectSources = new Map<string, Set<number>>();
  for (const r of records) (objectSources.get(r.object) ?? objectSources.set(r.object, new Set()).get(r.object)!).add(r.source);
  return records.filter((r) => objectSources.get(r.object)!.size === 1);
}

// ----------------------------------------------------------------------------- deterministic

const SEPARATORS = [' ', '-', '.', '/', '_'];
const celString = (text: string): string => JSON.stringify(text);
/** Substitutes the inner expression for `value` in a step. */
const compose = (step: string, inner: string): string => step.replaceAll('value', `(${inner})`);

interface Step { name: string; cel: string }

/** The catalogue steps that could matter for these unmatched components, in the order they compose. */
export function catalogueSteps(rows: readonly AnalysisRecord[]): Step[] {
  const all = rows.flatMap((r) => r.components);
  const steps: Step[] = [];
  if (all.some((c) => c !== c.trim())) steps.push({ name: 'trim', cel: 'value.trim()' });
  if (all.some((c) => /[a-z]/.test(c)) && all.some((c) => /[A-Z]/.test(c))) steps.push({ name: 'upper', cel: 'value.upperAscii()' });
  const seps = SEPARATORS.filter((s) => all.some((c) => c.includes(s)));
  if (seps.length > 0) {
    steps.push({ name: `separators:${seps.map((s) => (s === ' ' ? 'space' : s)).join('')}`, cel: seps.reduce((e, s) => `${e}.split(${celString(s)}).join("")`, 'value') });
  }
  // A short alphabetic prefix that most of one system's unmatched keys carry and almost none of another's.
  const bySource = new Map<number, string[]>();
  for (const r of rows) bySource.set(r.source, [...bySource.get(r.source) ?? [], ...r.components]);
  const prefixOf = (c: string) => /^([A-Za-z]{2,4})[^A-Za-z]/.exec(c.trim())?.[1];
  for (const [source, comps] of bySource) {
    const counts = new Map<string, number>();
    for (const c of comps) {
      const p = prefixOf(c);
      if (p !== undefined) counts.set(p, (counts.get(p) ?? 0) + 1);
    }
    for (const [prefix, n] of counts) {
      if (n / comps.length < 0.9) continue;
      const others = [...bySource].filter(([s]) => s !== source).flatMap(([, cs]) => cs);
      if (others.length === 0 || others.filter((c) => c.trim().startsWith(prefix)).length / others.length > 0.1) continue;
      steps.push({ name: `prefix:${prefix}`, cel: `(value.startsWith(${celString(prefix)}) ? value.substring(${prefix.length}) : value)` });
    }
  }
  if (all.length > 0 && all.every((c) => /^\s*[\d\s.\-/_]+\s*$/.test(c)) && all.some((c) => /^\s*0\d/.test(c))) {
    steps.push({ name: 'leading_zeros', cel: 'string(int(value))' });
  }
  return steps;
}

/** Each catalogue step on its own, and all of them composed. */
export function deterministicCandidates(rows: readonly AnalysisRecord[]): Candidate[] {
  const steps = catalogueSteps(rows);
  const out: Candidate[] = steps.map((s) => ({ cel: s.cel, steps: [s.name], basis: 'deterministic' }));
  if (steps.length > 1) {
    out.push({ cel: steps.reduce((inner, s) => compose(s.cel, inner), 'value'), steps: steps.map((s) => s.name), basis: 'deterministic' });
  }
  return out;
}

/** The best candidate: most pairs, never ambiguous or lossy; fewer steps on a tie. */
export function bestCandidate(records: readonly AnalysisRecord[], candidates: readonly Candidate[])
  : { candidate: Candidate; judgement: RuleJudgement } | undefined {
  let best: { candidate: Candidate; judgement: RuleJudgement } | undefined;
  for (const candidate of candidates) {
    const judgement = judgeRule(records, candidate.cel);
    if (judgement === undefined || judgement.ambiguous || judgement.lost > 0 || judgement.pairs === 0) continue;
    if (best === undefined || judgement.pairs > best.judgement.pairs
      || (judgement.pairs === best.judgement.pairs && candidate.steps.length < best.candidate.steps.length)) {
      best = { candidate, judgement };
    }
  }
  return best;
}

// ----------------------------------------------------------------------------- the model

const MODEL_INSTRUCTIONS = [
  'Records of one kind of thing are held in several systems, each with a match key. Some records did not match across systems because',
  'their keys are written in different formats. You are given only the shapes of the unmatched keys (runs of character classes: U upper',
  'case letters, L lower case letters, D digits, X other characters, each followed by its count; separators are shown as themselves, ␣',
  'for a space) and how many keys have each shape. You never see a key.',
  'Propose at most three normalisation rules that would make keys of the same thing equal across systems. Each rule is a CEL expression',
  'over the string `value` returning a string, using only: trim(), lowerAscii(), upperAscii(), substring(start) or substring(start, end),',
  'startsWith(text), indexOf(text), size(value), split(text).join(""), int(), string(), and the conditional operator. No regular',
  'expressions. A rule is applied to every key of every system, so it must leave keys that already match unchanged in relation to each other.',
].join(' ');

const modelRules = z.object({
  rules: z.array(z.object({ cel: z.string().min(1).max(500), rationale: z.string().max(500) })).max(3),
});

/** The model's rules for what is still unmatched, judged before anything is proposed. Shapes and counts only reach it. */
export async function modelCandidates(deps: ResolutionDeps, ctx: Context, type: ObjectTypeView, rows: readonly AnalysisRecord[])
  : Promise<Candidate[]> {
  const keyNames = type.matchKeys.map((k) => type.properties.find((p) => p.identityId === k.propertyIdentityId));
  const lines: string[] = [];
  lines.push(`Match key: ${keyNames.map((p) => `${p?.displayName ?? 'key'} (${p?.dataType ?? 'string'})`).join(', ')}.`);
  type.contributingObjects.forEach((co, s) => {
    const mine = rows.filter((r) => r.source === s);
    if (mine.length === 0) return;
    const shapes = new Map<string, number>();
    for (const r of mine) {
      const shape = r.components.map(keyShape).join(' | ');
      shapes.set(shape, (shapes.get(shape) ?? 0) + 1);
    }
    const top = [...shapes].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([shape, n]) => `${shape} ×${n}`).join(', ');
    lines.push(`System ${s + 1} (${co.sourceObject}): ${mine.length} unmatched keys. Shapes: ${top}.`);
  });
  const result = await deps.services.call(callModel, {
    body: {
      role: 'resolution',
      instructions: MODEL_INSTRUCTIONS,
      vocabulary: {
        objectTypes: [{
          name: type.displayName, ...(type.description ? { description: type.description } : {}),
          properties: keyNames.filter((p) => p !== undefined).map((p) => ({ name: p!.displayName, type: p!.dataType })),
        }],
        documentation: [{ title: 'Unmatched key shapes', text: lines.join('\n') }],
      },
      output: outputSpec('NormalisationRules', modelRules),
      maxOutputTokens: 1024,
    },
  }, { request: ctx.request, correlationId: ctx.correlationId, timeoutMs: 30_000 });
  const parsed = parseOutput(modelRules, result.output);
  return parsed.rules.map((r) => ({ cel: r.cel, steps: [], basis: 'model' as const }));
}
