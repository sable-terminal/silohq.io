// Field authority: what a value is when systems disagree (spec 23.4 to 23.6). Pure: given an
// object's rows from its contributing objects, the type's mappings and the live
// declarations, each property gets exactly one state:
//
//   declared   a live authority's winning connection holds a reading (and its condition,
//              a CEL predicate over that connection's row as `object` by api name, holds):
//              its value, naming the declaration.
//   agreed     every contributing object holding a reading returns the same value.
//   only       one contributing object holds a reading; the others hold none (absence, not
//              disagreement).
//   disputed   readings differ and nobody declared who is right: no value at all, never an
//              average, a recency pick or a model's choice.
//   empty      nobody holds a reading.
//   unchecked  not settled: a contributing object that maps the property returned no row
//              for the object and could not be asked again by identity (spec 23.5), so its
//              silence cannot count as absence.
//
// Equality uses the property type: decimals at the declared scale, money as amount and
// currency, timestamps as instants (a value without an offset read in the mapping's source
// time zone), dates as days, enums and booleans after the mapping's value map, anything
// structured as canonical JSON.

import type { Coverage, CoverageCounts, MergedValue, ValueState } from '../../contracts/resolution/resolve.contract.ts';
import type { ObjectTypeView, PropertyView } from '../../contracts/ontology/manifest.contract.ts';
import { canonicalJson } from '../../utils/canonicalJson.util.ts';
import type { CompiledCel } from '../expression-evaluator/cel.service.ts';

export interface MergeSource {
  connectionId: string;
  sourceObject: string;
  rows: readonly { values: Readonly<Record<string, unknown>> }[];
  unchecked: boolean;
}

export interface MergeObject {
  /** Indexes into sources[] and its rows. */
  rows: readonly { source: number; row: number }[];
}

export interface Authority {
  id: string;
  propertyIdentityId: string;
  winningConnectionId: string;
  /** Compiled once per merge; null for a declaration over the whole type. */
  condition: CompiledCel | null;
}

const CONDITION_BOUNDS = { steps: 2_000, timeMs: 5 };

// ----------------------------------------------------------------------------- equality

/** A decimal as text at a scale: sign, digits, rounded half away from zero. Undefined when it is not a number. */
export function decimalAt(raw: unknown, scale: number | undefined): string | undefined {
  let text: string;
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw)) return undefined;
    text = raw.toString();
    if (/e/i.test(text)) text = raw.toFixed(20);
  } else if (typeof raw === 'string' && /^\s*[-+]?(\d+\.?\d*|\.\d+)\s*$/.test(raw)) {
    text = raw.trim();
  } else {
    return undefined;
  }
  const negative = text.startsWith('-');
  const unsigned = text.replace(/^[-+]/, '');
  let [whole = '0', fraction = ''] = unsigned.split('.');
  whole = whole.replace(/^0+(?=\d)/, '') || '0';
  if (scale === undefined) {
    fraction = fraction.replace(/0+$/, '');
  } else if (fraction.length > scale) {
    const roundUp = Number(fraction[scale]) >= 5;
    fraction = fraction.slice(0, scale);
    if (roundUp) {
      const digits = (whole + fraction).split('').map(Number);
      let i = digits.length - 1;
      for (; i >= 0; i -= 1) {
        if (digits[i]! < 9) { digits[i]! += 1; break; }
        digits[i] = 0;
      }
      const joined = (i < 0 ? '1' : '') + digits.join('');
      whole = joined.slice(0, joined.length - scale) || '0';
      fraction = joined.slice(joined.length - scale);
    }
  } else {
    fraction = fraction.padEnd(scale, '0');
  }
  const body = fraction.length > 0 ? `${whole}.${fraction}` : whole;
  const zero = /^0(\.0*)?$/.test(body);
  return negative && !zero ? `-${body}` : body;
}

/** The offset of a zone at an instant, in minutes east of UTC. */
function zoneOffsetMinutes(zone: string, at: Date): number {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(at);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return Math.round((asUtc - at.getTime()) / 60_000);
}

/** A timestamp as epoch milliseconds; a value without an offset is read in the source's zone (UTC when none is declared). */
export function instant(raw: unknown, sourceTimeZone: string | null): number | undefined {
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  if (typeof raw !== 'string') return undefined;
  const hasOffset = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(raw.trim());
  if (hasOffset || sourceTimeZone === null) {
    const ms = Date.parse(hasOffset ? raw : `${raw.trim()}Z`);
    return Number.isNaN(ms) ? undefined : ms;
  }
  const naive = Date.parse(`${raw.trim()}Z`);
  if (Number.isNaN(naive)) return undefined;
  try {
    const first = naive - zoneOffsetMinutes(sourceTimeZone, new Date(naive)) * 60_000;
    return naive - zoneOffsetMinutes(sourceTimeZone, new Date(first)) * 60_000;
  } catch {
    return undefined;
  }
}

interface Reading {
  connectionId: string;
  sourceObject: string;
  value: unknown;
  /** What equality compares. */
  comparable: string;
}

/** The value after the mapping's value map: enums and booleans compare as the ontology's values. */
function mapped(property: PropertyView, mapping: PropertyView['mappings'][number] | undefined, raw: unknown): unknown {
  if (mapping?.valueMap && (typeof raw === 'string' || typeof raw === 'number' || typeof raw === 'boolean')) {
    const hit = mapping.valueMap[String(raw)];
    if (hit !== undefined) {
      if (property.dataType === 'boolean') return hit === 'true' ? true : hit === 'false' ? false : hit;
      return hit;
    }
  }
  return raw;
}

function comparable(property: PropertyView, mapping: PropertyView['mappings'][number] | undefined, value: unknown): string {
  const scale = typeof property.typeParams['scale'] === 'number' ? property.typeParams['scale'] as number : undefined;
  switch (property.dataType) {
    case 'decimal':
      return decimalAt(value, scale) ?? canonicalJson(value);
    case 'integer':
      return decimalAt(value, 0) ?? canonicalJson(value);
    case 'money': {
      if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
        const m = value as Record<string, unknown>;
        return `${String(m['currency'] ?? '').toUpperCase()} ${decimalAt(m['amount'], scale ?? 2) ?? canonicalJson(m['amount'])}`;
      }
      return canonicalJson(value);
    }
    case 'timestamp': {
      const ms = instant(value, mapping?.sourceTimeZone ?? null);
      return ms === undefined ? canonicalJson(value) : `t${ms}`;
    }
    case 'date':
      return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value) ? value.slice(0, 10) : canonicalJson(value);
    case 'string':
      return typeof value === 'string' ? `s${value}` : canonicalJson(value);
    default:
      return canonicalJson(value);
  }
}

// ----------------------------------------------------------------------------- merge

const empty = (): CoverageCounts => ({ population: 0, decided: 0, disputed: 0, empty: 0, unchecked: 0 });

function count(counts: CoverageCounts, state: ValueState): void {
  counts.population += 1;
  if (state === 'declared' || state === 'agreed' || state === 'only') counts.decided += 1;
  else counts[state] += 1;
}

export interface MergeInput {
  type: ObjectTypeView;
  sources: readonly MergeSource[];
  objects: readonly MergeObject[];
  /** The property identities to merge. */
  properties: readonly string[];
  /** Live declarations of the type: conditional first, then newest first. */
  authorities: readonly Authority[];
}

export interface MergeOutput {
  properties: Record<string, MergedValue>[];
  coverage: Coverage;
}

export function merge(input: MergeInput): MergeOutput {
  const byId = new Map(input.type.properties.map((p) => [p.identityId, p]));
  const apiNames = new Map(input.type.properties.map((p) => [p.identityId, p.apiName]));
  const properties = input.properties.map((id) => byId.get(id)).filter((p): p is PropertyView => p !== undefined && p.mappings.length > 0);
  const authorities = new Map<string, Authority[]>();
  for (const a of input.authorities) authorities.set(a.propertyIdentityId, [...(authorities.get(a.propertyIdentityId) ?? []), a]);
  const mappingFor = (property: PropertyView, source: MergeSource) =>
    property.mappings.find((m) => m.connectionId === source.connectionId && m.sourceObject === source.sourceObject);

  const byProperty: Record<string, CoverageCounts> = {};
  const totals = empty();
  const out: Record<string, MergedValue>[] = [];

  for (const object of input.objects) {
    const states: ValueState[] = [];
    const values: Record<string, MergedValue> = {};
    const present = new Set(object.rows.map((r) => r.source));
    for (const property of properties) {
      const readings: Reading[] = [];
      for (const { source: s, row } of object.rows) {
        const source = input.sources[s]!;
        const mapping = mappingFor(property, source);
        if (mapping === undefined) continue;
        const raw = source.rows[row]!.values[property.identityId];
        if (raw === undefined || raw === null) continue;
        const value = mapped(property, mapping, raw);
        readings.push({ connectionId: source.connectionId, sourceObject: source.sourceObject, value, comparable: comparable(property, mapping, value) });
      }
      // Contributing objects that map the property but returned nothing for this object and could not be asked again.
      const uncheckedSilence = input.sources.some((source, s) => !present.has(s) && source.unchecked && mappingFor(property, source) !== undefined)
        || property.mappings.some((m) => !input.sources.some((source) => source.connectionId === m.connectionId && source.sourceObject === m.sourceObject));

      let result: MergedValue | undefined;
      for (const authority of authorities.get(property.identityId) ?? []) {
        const winners = readings.filter((r) => r.connectionId === authority.winningConnectionId);
        if (winners.length === 0) continue;
        if (authority.condition !== null) {
          const winnerRow = object.rows.map(({ source: s, row }) => ({ source: input.sources[s]!, row }))
            .find(({ source }) => source.connectionId === authority.winningConnectionId);
          const rowObject: Record<string, unknown> = {};
          for (const [id, raw] of Object.entries(winnerRow?.source.rows[winnerRow.row]?.values ?? {})) {
            const name = apiNames.get(id);
            if (name !== undefined) rowObject[name] = raw;
          }
          let holds = false;
          try {
            holds = authority.condition.evaluate({ object: rowObject }, CONDITION_BOUNDS) === true;
          } catch {
            holds = false;
          }
          if (!holds) continue;
        }
        const distinct = new Set(winners.map((w) => w.comparable));
        // The winning system disagreeing with itself (two of its records in one object) is still a dispute.
        result = distinct.size === 1
          ? { state: 'declared', value: winners[0]!.value as MergedValue['value'], from: authority.winningConnectionId, authorityId: authority.id }
          : { state: 'disputed' };
        break;
      }
      if (result === undefined) {
        const distinct = new Set(readings.map((r) => r.comparable));
        const holders = new Set(readings.map((r) => `${r.connectionId}/${r.sourceObject}`));
        if (distinct.size > 1) result = { state: 'disputed' };
        else if (uncheckedSilence) result = { state: 'unchecked' };
        else if (readings.length === 0) result = { state: 'empty' };
        else if (holders.size === 1) result = { state: 'only', value: readings[0]!.value as MergedValue['value'], from: readings[0]!.connectionId };
        else result = { state: 'agreed', value: readings[0]!.value as MergedValue['value'] };
      }
      values[property.identityId] = result;
      states.push(result.state);
      count(byProperty[property.apiName] ??= empty(), result.state);
    }
    out.push(values);
    const overall: ValueState = states.includes('disputed') ? 'disputed'
      : states.includes('unchecked') ? 'unchecked'
        : states.length > 0 && states.every((s) => s === 'empty') ? 'empty' : 'agreed';
    count(totals, overall);
  }
  return { properties: out, coverage: { ...totals, byProperty } };
}
