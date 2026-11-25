import type { FieldProfile } from './profile.render';
import { writtenAlike } from '../ontology/written.ontology';

/**
 * An answer, read by a model and written up — the parts that are not the model.
 *
 * ── THE MODEL WRITES; SILO KEEPS THE FIGURES HONEST ───────────────────────
 *
 * Rendering §2 used to forbid a model here outright: "if the sentence and the
 * table can disagree, the lineage guarantee is void". Answers are now written
 * up by one (129), and the guarantee is kept by three things in this file
 * rather than by the absence of a model:
 *
 * 1. WHAT IT IS SHOWN is the answer's own figures — the profile over every
 *    matched record, the totals asked for, and the first rows — and nothing it
 *    would need to add up itself.
 * 2. EVERY FIGURE IT WRITES IS CHECKED against those, and one that is not among
 *    them is handed back marked, so the Console can say it was worked out by
 *    the model rather than read from the systems.
 * 3. IT NEVER DRAWS. It names a chart — which kind, over which field — and the
 *    chart is computed from the records by the client, so a bar can never be a
 *    figure the model imagined. A chart that names a field the answer does not
 *    have, or cannot be drawn from what it holds, is no chart.
 */

/** How many of an answer's records the model is shown. The disclosure states this number. */
export const READING_ROWS = 60;
/* How many rows of one table the model is shown. A breakdown longer than this is a listing. */
const TABLE_ROWS = 60;
/* Past this many, the list of fields held apart is a second copy of the summary. */
const APART_MOST = 300;

export type ReadingPart = {
  concept: string;
  systems: string[];
  /** Every record the question matched. */
  matched: number;
  profile: FieldProfile[];
  aggregates: Array<{ operation: string; fieldPath: string; value: number | null }>;
  /**
   * The first records, as a person would list them: a name, and each field's
   * value. Where the question asked what changed (136), `was` is what each
   * changed field held before, and `added` says the record is new.
   */
  rows: Array<{
    name: string;
    values: Record<string, string | number | boolean | null>;
    was?: Record<string, string | number | boolean | null>;
    added?: boolean;
  }>;
  /** A criterion the question picked records by that no field holds — judged here, from outside. */
  judge?: string;
  /** Fields the system holds that are empty on every record the question matched. */
  empty?: string[];
  /** Whether these are every field the system holds — read from its own field list. */
  fieldsListed?: boolean;
  /**
   * Fields the question picked records by, and the systems that hold no such
   * field — so could not be asked. By the names people gave their systems.
   */
  unheld?: Array<{ field: string; systems: string[]; unchecked?: number }>;
  /**
   * Fields not every system holds, and the systems that do — the only fields
   * two systems could be calling different things. Worked out by Silo from the
   * concept, never taken from a request.
   */
  apart?: Array<{ field: string; systems: string[] }>;
  /** When the copy these were read from was made, where they came from a Silo and not from the systems live. */
  asOf?: string;
  /** Siloes (136) — the past moment the question asked about. `asOf` is when the copy read was really made. */
  asAt?: string;
  /**
   * Siloes (137) — the copy was caught up: when, and how many records the
   * systems mark as added or changed since the copy were read live.
   */
  fresh?: { at: string; records: number };
  /**
   * Siloes (136) — what differs between two copies, counted by Silo over every
   * record of both: per system, and the first few records that have gone.
   */
  changes?: {
    fields?: string[];
    systems: Array<{
      system: string;
      from: string;
      to: string;
      added: number;
      removed: number;
      changed: number;
      fields: Array<{ field: string; records: number }>;
    }>;
    gone: string[];
  };
  /**
   * §4.1 — the other kinds of record these were picked by: how many of them
   * matched, how many of these they reach, and through which key.
   */
  joins?: Array<{ concept: string; exists: boolean; matched: number; reached: number; route: string | null; as?: string }>;
  /**
   * §7 — exact figures over EVERY matched record, worked out by Silo: a
   * breakdown, a trend, two fields against each other. These are the figures a
   * write-up quotes; the rows listed are only the first few records.
   */
  tables?: Array<{
    kind: 'breakdown' | 'trend' | 'crosstab';
    by: string[];
    measure: { operation: string; field?: string };
    every?: string;
    rows: Array<{ key: string[]; value: number | null; records: number }>;
    left?: { disputed: number; unmeasured: number };
    beyond?: { groups: number; records: number };
  }>;
  /**
   * Pairs of values the systems keep giving for one field of the same records
   * (`ConceptAnswer.written`), by the systems' names. `alike` ones were read as
   * one thing; the rest are still shown as disagreeing.
   */
  written?: Array<{ field: string; a: { system: string; value: string }; b: { system: string; value: string }; records: number; alike: boolean }>;
  /**
   * What its records are about, read from its systems' field names alone
   * (134): the strictest reading across them. Worked out by Silo, never taken
   * from a request, and absent where no reading has been made.
   */
  kind?: 'organisation' | 'person' | 'other';
};

export type ReadingOutside = { paragraphs: string[]; sources: Array<{ n: number; title: string; url: string }> };

export type Visual = {
  kind: 'bars' | 'share' | 'line' | 'figure' | 'completeness';
  title: string;
  /** Which part it draws, counted from zero; `all` compares the parts of a survey. */
  part: number | 'all';
  groupBy?: string;
  time?: string;
  /** For completeness: the fields that matter, filled or not. */
  fields?: string[];
  measure: { operation: 'count' | 'sum' | 'average' | 'minimum' | 'maximum'; field?: string };
};

const OPERATIONS = ['count', 'sum', 'average', 'minimum', 'maximum'] as const;
const KINDS = ['bars', 'share', 'line', 'figure', 'completeness'] as const;
/* Past this many values a share is a smear; it is drawn as bars instead. */
const SHARE_MOST = 8;
/* A field with more values than this is a list of names, not a category. */
const GROUPS_MOST = 50;

const figure = (value: number) => value.toLocaleString('en-GB', { maximumFractionDigits: 2 });

/**
 * The answer as the model is shown it: plain lines, one part after another.
 *
 * VALUES ARE DATA. They are fenced as such in the instruction, and nothing here
 * puts one in the position of an instruction; what stops one mattering is that
 * what comes back is text to show and a chart to check, never an action.
 */
export function digestOf(parts: readonly ReadingPart[], outside: ReadingOutside | null): string {
  const lines: string[] = [];

  parts.forEach((part, index) => {
    lines.push(
      `Part ${index + 1}: ${part.concept}, held in ${part.systems.join(', ') || 'one system'}.`,
      `${figure(part.matched)} records matched. ${
        part.rows.length < part.matched
          ? `The first ${part.rows.length} are listed below; the field summaries cover all ${figure(part.matched)}.`
          : 'All of them are listed below.'
      }`,
      'Fields:',
    );

    for (const field of part.profile) {
      const counts = `${figure(field.present)} with a value, ${figure(field.missing)} without${
        field.disputed ? `, ${figure(field.disputed)} where the systems disagree` : ''
      }`;
      if (field.number) {
        const { sum, minimum, maximum, average } = field.number;
        lines.push(`- ${field.fieldPath} (number): ${counts}; sum ${figure(sum)}, minimum ${figure(minimum)}, maximum ${figure(maximum)}, average ${figure(average)}`);
      } else if (field.date) {
        const by = field.date.counts.map((one) => `${one.period} ${one.count}`).join(', ');
        lines.push(`- ${field.fieldPath} (date): ${counts}; from ${field.date.earliest} to ${field.date.latest}; records by ${field.date.by}: ${by}`);
      } else if (field.values) {
        const top = field.values.top.map((one) => `"${one.value}" ${one.count}`).join(', ');
        lines.push(`- ${field.fieldPath} (${field.kind}): ${counts}; ${figure(field.values.distinct)} different values${top ? `; commonest: ${top}` : ', every one different'}`);
      } else {
        lines.push(`- ${field.fieldPath}: ${counts}`);
      }
    }

    if (part.judge) {
      lines.push(
        `To judge: which of these records ${part.judge}. No field holds this. Decide it record by record from the web context, and say which could not be decided.`,
      );
    }

    /*
     * THE THREE THINGS "MISSING" CAN MEAN, KEPT APART. A field on the system's
     * list that is empty on every record is the customer's gap; a field not on
     * a list Silo read is one the system does not have; and without the list,
     * a field Silo did not read may still exist — and saying otherwise is a
     * false statement about somebody's data.
     */
    const system = part.systems.join(', ') || 'the system';
    /* With nothing matched every field is "empty", and saying so describes the question, not the data. */
    if (part.matched === 0) {
      lines.push(`No ${part.concept} records matched, so nothing can be said about which of its fields are filled.`);
    } else if (part.empty?.length) {
      lines.push(`Fields ${system} holds that are empty on every record matched: ${part.empty.slice(0, 200).join(', ')}`);
    }
    lines.push(
      part.fieldsListed
        ? `Silo read ${system}'s own list of every field ${part.concept} has: a field not named above does not exist in ${system}.`
        : `Silo may not read every field ${system} holds for ${part.concept}: never say ${system} lacks a field that is not named above.`,
    );

    /*
     * WHAT THE COUNT ABOVE WAS COUNTED OVER. The records were picked by a field
     * one of the systems does not hold, so that system was not asked — and a
     * record it alone holds is neither in the answer nor ruled out of it. Said
     * as a fact about the systems, in a sentence, and never as a reason the
     * question could not be answered: it was.
     */
    for (const gap of part.unheld ?? []) {
      const without = gap.systems.join(', ');
      const picked = `These records were picked by ${gap.field}, which ${without} ${gap.systems.length === 1 ? 'does' : 'do'} not hold: the answer comes from the systems that hold ${gap.field}`;

      if (gap.unchecked === 0) {
        /* Counted, and nothing was left out: said so the model does not hedge an answer that is whole. */
        lines.push(`${picked}. Every record ${without} holds is also held in one of those, so nothing was left unchecked.`);
      } else if (gap.unchecked !== undefined) {
        lines.push(
          `${picked}, and ${figure(gap.unchecked)} ${gap.unchecked === 1 ? 'record' : 'records'} held only in ${without} ` +
            `${gap.unchecked === 1 ? 'was' : 'were'} not checked. Say so in one sentence, with that number; it does not make the answer wrong.`,
        );
      } else {
        lines.push(
          `${picked}, and a record held only in ${without} was not checked. ` +
            'Say so in one sentence; it does not make the answer wrong.',
        );
      }
    }

    if (part.asOf && part.asAt) {
      /* The question is about the past: the copy is the answer, and its real date is the one to state. */
      lines.push(
        `The question asks how these stood at a past moment. They are read from the copy the organisation keeps in its Silo made nearest it, ` +
          `at ${part.asOf.slice(0, 16).replace('T', ' ')} UTC. Say "as at" that date once. Every figure here is as things stood then, not as they are now.`,
      );
    } else if (part.asOf && part.fresh) {
      lines.push(
        `These were read from a copy the organisation keeps in its Silo, made at ${part.asOf.slice(0, 16).replace('T', ' ')} UTC, ` +
          `and caught up at ${part.fresh.at.slice(0, 16).replace('T', ' ')} UTC by reading live the ${figure(part.fresh.records)} ` +
          `${part.fresh.records === 1 ? 'record' : 'records'} the systems mark as added or changed since. ` +
          'Treat it as current as of the later time, and do not caveat it as stale; a record deleted since the copy would still be counted, which is worth a clause only if the question is about what no longer exists.',
      );
    } else if (part.asOf) {
      lines.push(
        `These were read from a copy the organisation keeps in its Silo, made at ${part.asOf.slice(0, 16).replace('T', ' ')} UTC, not from the systems live. ` +
          'Say "as of" that time once; a record changed since is not in it.',
      );
    }

    /*
     * WHAT CHANGED, AS COUNTED. Two copies of each system compared by Silo,
     * every record of both: these counts are the answer to "what changed" and
     * are exact. The records listed below are the ones that differ, each with
     * what it held before — so a sentence about a record can say what it moved
     * from, and a sentence about the whole can give the counts.
     */
    if (part.changes) {
      const on = (iso: string) => iso.slice(0, 10);
      for (const system of part.changes.systems) {
        const fields = system.fields.map((field) => `${field.field} (${figure(field.records)})`).join(', ');
        lines.push(
          `What changed in ${system.system}, counted exactly by comparing the copy of ${on(system.from)} with the copy of ${on(system.to)}: ` +
            `${figure(system.added)} new records, ${figure(system.changed)} changed, ${figure(system.removed)} gone.` +
            (fields ? ` Fields that changed, and in how many records: ${fields}.` : ''),
        );
      }
      lines.push(
        part.changes.fields?.length
          ? `Only records in which ${part.changes.fields.join(' or ')} changed are listed below; each says what it held before.`
          : 'The records listed below are the new and the changed ones; each says whether it is new, or what it held before.',
      );
      if (part.changes.gone.length > 0) {
        lines.push(`Records no longer held (the first ${figure(part.changes.gone.length)}), as they were last called: ${part.changes.gone.join('; ')}`);
      }
    }

    /*
     * HOW THESE RECORDS WERE PICKED, WHERE IT WAS BY OTHER RECORDS. A list of
     * customers "with overdue invoices" is a claim about invoices; the model
     * is told how many matched and through which key, so it can say so and
     * does not present the list as a fact about the customers' own fields.
     */
    for (const join of part.joins ?? []) {
      lines.push(
        join.exists
          ? `Picked by related records: ${figure(join.matched)} ${join.concept} records matched and reach ${figure(join.reached)} ${part.concept} records` +
              `${join.route ? ` (${join.route})` : ''}; only those are kept.` +
              `${join.as ? ` The field ${join.as} on each record is worked out from them by Silo, exactly.` : ''}`
          : `Picked by related records: kept only ${part.concept} records that none of the ${figure(join.matched)} matching ${join.concept} records reach` +
              `${join.route ? ` (${join.route})` : ''}.`,
      );
    }

    /*
     * THE FIGURES TO QUOTE. Worked out over every matched record, which the
     * records listed below are not: for anything by group or over time, these
     * are the answer and the listing is an illustration.
     */
    for (const table of part.tables ?? []) {
      const measured = table.measure.operation === 'count' ? 'number of records' : `${table.measure.operation} of ${table.measure.field}`;
      const grouped = table.kind === 'trend' ? `by ${table.every ?? 'period'} of ${table.by[0]}` : `by ${table.by.join(' and ')}`;
      lines.push(`Exact, over all ${figure(part.matched)} matched records — ${measured} ${grouped}:`);
      for (const row of table.rows.slice(0, TABLE_ROWS)) {
        lines.push(`  ${row.key.join(' / ')}: ${row.value === null ? 'no figure' : figure(row.value)} (${figure(row.records)} ${row.records === 1 ? 'record' : 'records'})`);
      }
      if (table.rows.length > TABLE_ROWS) lines.push(`  …and ${figure(table.rows.length - TABLE_ROWS)} more groups not shown here.`);
      if (table.beyond) lines.push(`  Beyond these: ${figure(table.beyond.groups)} more groups holding ${figure(table.beyond.records)} records. The groups above are not the whole.`);
      if (table.left?.disputed) lines.push(`  ${figure(table.left.disputed)} records are in no group, because the systems disagree about ${table.by.join(' or ')}.`);
      if (table.left?.unmeasured) lines.push(`  ${figure(table.left.unmeasured)} records add nothing to their group's figure: ${table.measure.field} is disputed or not a number on them.`);
    }

    /*
     * ONE DISAGREEMENT MANY TIMES IS NOT MANY DISAGREEMENTS. Where two systems
     * keep giving the same pair of values, the model is told the pair: what
     * Silo already read as one thing written two ways, so it is not reported as
     * a conflict; and what it could not — a code beside a name, or one status
     * beside another — which only somebody who knows what the words mean can
     * call a spelling or a fault.
     */
    for (const pair of (part.written ?? []).slice(0, 12)) {
      const said = `in ${pair.field}, ${pair.a.system} has "${pair.a.value.slice(0, 80)}" where ${pair.b.system} has "${pair.b.value.slice(0, 80)}" on ${figure(pair.records)} ${pair.records === 1 ? 'record' : 'records'}`;
      lines.push(
        pair.alike
          ? `Read as the same thing, written two ways: ${said}. Not a disagreement.`
          : `The same disagreement repeated: ${said}, shown as disagreeing. Say in one sentence whether that is one thing written two ways (a code, a translation) or a real difference worth looking at.`,
      );
    }

    /*
     * WHICH FIELDS COULD BE ONE THING UNDER TWO NAMES. A field every system
     * holds is already read as one; these are the rest, with who holds each, so
     * the model can say that one system's `town` is another's `city`. Names
     * only — it has the values already, in the summaries and records.
     */
    const apart = part.apart ?? [];
    if (new Set(apart.flatMap((one) => one.systems)).size > 1) {
      lines.push(
        `Fields not every system holds, and where each is held: ${apart
          .slice(0, APART_MOST)
          .map((one) => `${one.field} (${one.systems.join(', ')})`)
          .join('; ')}`,
      );
    }

    const totals = part.aggregates.filter((one) => one.value !== null);
    if (totals.length) {
      lines.push(`Totals asked for: ${totals.map((one) => `${one.operation} of ${one.fieldPath} = ${figure(one.value!)}`).join('; ')}`);
    }

    lines.push('Records:');
    part.rows.forEach((row, at) => {
      const values = Object.entries(row.values)
        .filter(([, value]) => value !== null && value !== '')
        .map(([key, value]) => `${key}: ${String(value).slice(0, 200)}`)
        .join(' | ');
      const before = Object.entries(row.was ?? {})
        .map(([key, value]) => `${key} was ${value === null || value === '' ? 'empty' : String(value).slice(0, 200)}`)
        .join(', ');
      const since = row.added ? ' || new since the earlier copy' : before ? ` || before: ${before}` : '';
      lines.push(`${at + 1}. ${row.name}${values ? ` | ${values}` : ''}${since}`);
    });
    lines.push('');
  });

  if (outside) {
    lines.push('Context from outside their systems, from the web. Cite a source by its number, in square brackets:');
    lines.push(...outside.paragraphs);
    lines.push('Sources:', ...outside.sources.map((source) => `[${source.n}] ${source.title}`));
  }

  return lines.join('\n');
}

/* ── Figures ───────────────────────────────────────────────────────────── */

/*
 * A figure as written: an optional currency, digits with or without thousands
 * separators, decimals, and a scale or a percent. Not after a letter, a point,
 * a dash or an opening bracket — so "[2]", the "01" of "2026-01-04" and the
 * "3" of "Q3" are not figures.
 */
const FIGURE = /(?<![\p{L}\d.\-[])([£$€])?(\d{1,3}(?:,\d{3})+|\d+)(\.\d+)?(\s?(?:%|k\b|m\b|bn\b|million\b|thousand\b|billion\b))?/giu;

const SCALE: Record<string, number> = { k: 1e3, thousand: 1e3, m: 1e6, million: 1e6, bn: 1e9, billion: 1e9 };

/**
 * Every number a text contains, as a value — and, where it is written with a
 * scale, as the value it stands for too. What the answer and the web context
 * hold, for the check below: "£5,177.7 million" in a source is 5,177.7 and
 * 5,177,700,000, so a write-up quoting either is quoting it.
 */
function numbersIn(text: string): number[] {
  const found: number[] = [];
  for (const match of text.matchAll(/(\d+(?:,\d{3})*(?:\.\d+)?)(\s?(?:k\b|m\b|bn\b|million\b|thousand\b|billion\b))?/gi)) {
    const value = Number(match[1]!.replace(/,/g, ''));
    found.push(value);
    const scale = SCALE[(match[2] ?? '').trim().toLowerCase()];
    if (scale) found.push(value * scale);
  }
  return found;
}

/**
 * The figures in what the model wrote that are not among what Silo read.
 *
 * WITHIN THE PRECISION IT WAS WRITTEN TO. "£84k" is the 84,120 in the answer;
 * "175.3" is its 175.25. A percentage is the model's own arithmetic unless the
 * context it was given states that very share — the answer holds counts, not
 * shares, but a cited page can.
 */
/* A citation as a model writes one: [2], or [2, 5]. Its numbers are sources, not figures. */
const CITATION = /\[\d+(?:\s*,\s*\d+)*\]/g;

export function unverifiedFigures(paragraphs: readonly string[], held: readonly string[]): string[] {
  const allowed = held.flatMap(numbersIn);
  /* A share the answer's context states — "74% of its sales", from a cited page — is quoted, not worked out. */
  const shares = new Set(held.flatMap((text) => [...text.matchAll(/(\d+(?:\.\d+)?)\s?%/g)].map((match) => Number(match[1]))));
  const unverified = new Set<string>();

  for (const paragraph of paragraphs.map((one) => one.replace(CITATION, ' '))) {
    for (const match of paragraph.matchAll(FIGURE)) {
      const [written, , whole, decimals = '', suffix = ''] = match;
      const unit = suffix.trim().toLowerCase();
      if (unit === '%') {
        if (!shares.has(Number(`${whole!.replace(/,/g, '')}${decimals}`))) unverified.add(written.trim());
        continue;
      }

      const scale = SCALE[unit] ?? 1;
      const value = Number(`${whole!.replace(/,/g, '')}${decimals}`) * scale;
      const places = Math.max(decimals.length - 1, 0);
      const tolerance = (0.5 * scale) / 10 ** places;

      if (!allowed.some((one) => Math.abs(one - value) <= tolerance + 1e-9)) unverified.add(written.trim());
    }
  }

  return [...unverified];
}

/* ── The chart ─────────────────────────────────────────────────────────── */

/**
 * The chart the model named, if it can be drawn from what the answer holds.
 *
 * NOTHING IS REPAIRED. A chart over a field the part does not have, a sum of
 * something that is not a number, a line with no date: each is no chart, and
 * the View tab is not shown — which is what the model is told to do anyway
 * when nothing is worth drawing.
 */
export function visualOf(raw: unknown, parts: readonly ReadingPart[]): Visual | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const body = raw as Record<string, unknown>;

  const kind = body.kind as Visual['kind'];
  if (!KINDS.includes(kind)) return null;

  /*
   * HOW COMPLETE THE RECORDS ARE, field by field — the chart for an answer
   * about what is there and what is missing. The model names the fields that
   * matter; how full each one is comes from the profile.
   */
  if (kind === 'completeness') {
    const number = typeof body.part === 'number' ? body.part : parts.length === 1 ? 1 : NaN;
    const part = parts[number - 1];
    if (!part || part.matched === 0 || !Array.isArray(body.fields)) return null;
    const known = new Set([...part.profile.map((one) => one.fieldPath), ...(part.empty ?? [])]);
    const fields = [...new Set(body.fields.filter((one): one is string => typeof one === 'string' && known.has(one)))].slice(0, 12);
    if (fields.length < 2) return null;
    const title = typeof body.title === 'string' ? body.title.trim().slice(0, 80) : '';
    return { kind, title, part: number - 1, fields, measure: { operation: 'count' } };
  }

  const measured = (body.measure ?? {}) as Record<string, unknown>;
  const operation = measured.operation as Visual['measure']['operation'];
  if (!OPERATIONS.includes(operation)) return null;
  const measureField = typeof measured.field === 'string' ? measured.field : undefined;

  const title = typeof body.title === 'string' ? body.title.trim().slice(0, 80) : '';

  /* A comparison of a survey's parts: how many records of each kind. */
  if (body.part === 'all') {
    if (parts.length < 2 || (kind !== 'bars' && kind !== 'share') || operation !== 'count') return null;
    return { kind: kind === 'share' && parts.length > SHARE_MOST ? 'bars' : kind, title, part: 'all', measure: { operation: 'count' } };
  }

  const number = typeof body.part === 'number' ? body.part : parts.length === 1 ? 1 : NaN;
  if (!Number.isInteger(number) || number < 1 || number > parts.length) return null;
  const part = parts[number - 1]!;
  const fieldOf = (name: unknown) => (typeof name === 'string' ? part.profile.find((one) => one.fieldPath === name) : undefined);

  if (operation !== 'count' && fieldOf(measureField)?.kind !== 'number') return null;
  const measure = operation === 'count' ? { operation } : { operation, field: measureField! };
  if (part.matched === 0) return null;

  /* The count of records is on the answer's footer already; a chart of one number that says it again is no chart. */
  if (kind === 'figure') return operation === 'count' ? null : { kind, title, part: number - 1, measure };

  if (kind === 'line') {
    const time = fieldOf(body.time);
    if (time?.kind !== 'date' || (time.date?.counts.length ?? 0) < 2) return null;
    return { kind, title, part: number - 1, time: time.fieldPath, measure };
  }

  const group = fieldOf(body.groupBy);
  if (!group?.values || group.values.distinct < 2 || group.values.distinct > GROUPS_MOST) return null;
  /* Every value different is a list of names, and a bar each says nothing. */
  if (group.values.top.length === 0) return null;
  const drawn = kind === 'share' && group.values.distinct > SHARE_MOST ? 'bars' : kind;
  return { kind: drawn, title, part: number - 1, groupBy: group.fieldPath, measure };
}

/* ── What the web may be asked about ──────────────────────────────────── */

/*
 * FIELD NAMES THAT MEAN A PERSON, IN ENGLISH. Nothing from a record holding one
 * is ever searched for. Kept because it can only ever stop a lookup: it is one
 * of several things that do, and the others below do not need the language.
 */
const PEOPLE = /^(first|last|given|family|sur|middle)_?name$|e_?mail|phone|mobile|birth|salary|national_?insurance|passport/i;
/* A kind of record about organisations, by what it is called or what it holds — where the system happens to say so in English. */
const ORGANISATIONS = /compan|organi[sz]ation|account|customer|client|supplier|vendor|partner|business|firm|brand|competitor|institution|charity|school/i;
const ORGANISATION_FIELD = /^(domain|website|web_?site|url|industry|sector|company_?number|registration_?number|vat_?number|duns)$/i;
const DOMAIN_FIELD = /^(domain|website|web_?site)$/i;

/*
 * ── WHAT A VALUE LOOKS LIKE, WHICH NO LANGUAGE CHANGES ────────────────────
 *
 * An email address, a phone number and a web address look the same in every
 * system, whatever the field holding them is called. They are what lets the
 * rule below work on a table named `tbl_cust_m` or a system in German.
 */
const WEB_ADDRESS = /^(https?:\/\/)?[a-z0-9-]+(\.[a-z0-9-]+)+(\/.*)?$/i;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/*
 * A PHONE NUMBER AS ONE IS WRITTEN, NOT ANY RUN OF DIGITS. Seven to fifteen
 * digits with nothing else but what a number is punctuated with, and either a
 * leading plus or its digits in groups: "+44 20 7946 0958", "(415) 555-2671",
 * "020 7946 0958". A bare run of digits is not taken for one — company numbers,
 * invoice numbers and identifiers are exactly that, and stopping every lookup
 * for a table that holds an identifier would stop them all. Nor is a date.
 */
const PHONE = /^\+?[\d\s().-]+$/;
const DATE = /^\d{4}-\d{2}-\d{2}/;

const isPhone = (text: string): boolean => {
  if (!PHONE.test(text) || DATE.test(text)) return false;
  const digits = text.replace(/\D/g, '').length;
  if (digits < 7 || digits > 15) return false;
  return text.startsWith('+') || /\d[\s()-]+\d/.test(text);
};

const hostOf = (value: string) => value.replace(/^https?:\/\//i, '').replace(/\/.*$/, '').toLowerCase();

/** A text value of a record, or nothing. */
const textOf = (value: string | number | boolean | null | undefined): string | null =>
  typeof value === 'string' && value.trim() !== '' ? value.trim() : null;

/**
 * Whether any listed record holds something that is an email address or a
 * phone number.
 *
 * NOT WHAT THE RECORD IS CALLED. A company filed under an email address is a
 * badly named company, and is dealt with where names are: that one name is
 * not sent. Its neighbours are still companies.
 */
function holdsPersonalDetails(part: ReadingPart): boolean {
  return part.rows.some((row) =>
    Object.values(row.values).some((value) => {
      const text = textOf(value);
      if (text === null || text === row.name.trim()) return false;
      return EMAIL.test(text) || isPhone(text);
    }),
  );
}

/**
 * The field that holds each organisation's own web address, if one does.
 *
 * BY WHAT THE VALUES ARE, NOT BY WHAT THE FIELD IS CALLED — except that a field
 * the system calls its website wins outright. Otherwise: a field whose values
 * are web addresses, and DIFFERENT ones from record to record. A column of
 * links into one site (every record's page on a social network, a shared
 * portal) is a web address in every row and is nobody's own.
 */
function domainFieldOf(part: ReadingPart): string | null {
  const seen = new Map<string, { hosts: Set<string>; count: number }>();

  for (const row of part.rows) {
    for (const [field, value] of Object.entries(row.values)) {
      const text = textOf(value);
      if (text === null || text.includes('@') || !WEB_ADDRESS.test(text)) continue;
      const held = seen.get(field) ?? { hosts: new Set<string>(), count: 0 };
      held.hosts.add(hostOf(text));
      held.count += 1;
      seen.set(field, held);
    }
  }

  const named = [...seen.keys()].filter((field) => DOMAIN_FIELD.test(field)).sort()[0];
  if (named) return named;

  const own = [...seen]
    /* One record proves nothing about being different from the next. */
    .filter(([, held]) => held.count >= 2 && held.hosts.size / held.count > 0.5)
    .sort(([a, x], [b, y]) => y.hosts.size - x.hosts.size || (a < b ? -1 : a > b ? 1 : 0));

  return own[0]?.[0] ?? null;
}

/**
 * The organisations an answer names, which the web may be asked about.
 *
 * ── ORGANISATIONS ONLY, AND NEVER PEOPLE ──────────────────────────────────
 *
 * A company is public in a way a person is not: "Babcock International" is on
 * its own website, and a contact's name, email or phone number belongs to
 * nobody who asked for it to be searched. So a kind of record that holds
 * anything about people contributes nothing, a kind that is not about
 * organisations contributes nothing — a deal's name is an internal label, not
 * a public fact — and a name that is an address, a number or an identifier is
 * not a name.
 *
 * ── NOTHING ABOUT PEOPLE, BY EVERY SIGN THERE IS ──────────────────────────
 *
 * Any one of these stops a part contributing anything, and none can be
 * overruled by another:
 *
 *  - a field named, in English, for something personal;
 *  - a VALUE that is an email address or a phone number, whatever its field is
 *    called and whatever language the system is in;
 *  - a model's reading of the object's field names saying its records are
 *    people (134).
 *
 * ── AND ABOUT ORGANISATIONS, BY ONE OF TWO ────────────────────────────────
 *
 *  - the system says so in English: what the concept is called, or a field
 *    called `website` or `industry`; or
 *  - the records themselves carry their own web addresses AND the model's
 *    reading of the field names says organisations. Both, because each alone
 *    is one opinion: together a person's name reaches a search only if the
 *    records look like companies, the names read like a company table, and no
 *    email or phone number sits among the values.
 *
 * DECIDED HERE, NOT BY A MODEL. A model's reading of NAMES is one input, and
 * can only tighten the rule or agree with the records; what leaves for a
 * search is still chosen by rules that can be read and tested, never by a
 * model that has seen the records.
 */
/**
 * Whether anything from this part could be looked up on the web, were its
 * field names read as an organisation's.
 *
 * WHAT DECIDES WHETHER A READING IS WORTH ASKING FOR (134). A part the rules
 * already stop — a field named for something personal, an email address among
 * its values — needs none, and neither does one with no sign of being about
 * organisations at all. Everything else does: the reading is the last check
 * before a name leaves, including for a system that says "customer" in English
 * and means people.
 */
export function couldBeLookedUp(part: ReadingPart): boolean {
  const fields = part.profile.map((field) => field.fieldPath);
  if (fields.some((field) => PEOPLE.test(field)) || holdsPersonalDetails(part)) return false;
  return ORGANISATIONS.test(part.concept) || fields.some((field) => ORGANISATION_FIELD.test(field)) || domainFieldOf(part) !== null;
}

/* Organisations looked up to add context, and — when a question asked to pick by a criterion — to judge it. */
const CONTEXT_MOST = 8;
const JUDGE_MOST = 25;

export function subjectsOf(parts: readonly ReadingPart[]): string[] {
  const most = parts.some((part) => part.judge) ? JUDGE_MOST : CONTEXT_MOST;
  const names = new Set<string>();

  for (const part of parts) {
    const fields = part.profile.map((field) => field.fieldPath);

    if (part.kind === 'person' || fields.some((field) => PEOPLE.test(field)) || holdsPersonalDetails(part)) continue;

    const domainField = domainFieldOf(part);
    const saidInEnglish = ORGANISATIONS.test(part.concept) || fields.some((field) => ORGANISATION_FIELD.test(field));
    const shownByRecords = part.kind === 'organisation' && domainField !== null;
    if (!saidInEnglish && !shownByRecords) continue;

    for (const row of part.rows) {
      const name = row.name.trim();
      const digits = name.replace(/\D/g, '').length;
      if (name.length < 2 || name.length > 100 || name.includes('@') || !/\p{L}/u.test(name) || digits > name.length / 2) {
        continue;
      }
      /* Its website, where the record holds one: the surest way to find the right organisation of that name. */
      const address = domainField === null ? null : textOf(row.values[domainField]);
      const domain = address !== null && !address.includes('@') && WEB_ADDRESS.test(address) ? hostOf(address) : null;
      names.add(domain ? `${name} (${domain})` : name);
      if (names.size >= most) return [...names];
    }
  }

  return [...names];
}

/* ── Fields that hold the same thing ──────────────────────────────────── */

/** Fields the model said are one thing, checked against the records listed. */
export type SameFields = {
  /** Counted from zero. */
  part: number;
  /** The names that hold one thing, each from different systems. */
  fields: string[];
  /** Which of those names all of them are read by from now on. */
  as: string;
  /** How many listed records held two or more of them, and how many of those held the same thing. */
  compared: number;
  agreed: number;
};

/* Fewer records than this holding both fields is not enough to check against. */
const SAME_NEEDS = 3;
/* And this share of them must hold the same thing. Two systems disagree about some records; not about most. */
const SAME_AGREES = 0.6;

const comparable = (value: string | number | boolean | null | undefined): string | null => {
  if (value === null || value === undefined) return null;
  const text = String(value).trim().toLowerCase().replace(/\s+/g, ' ');
  return text === '' ? null : text;
};

/**
 * The fields the model said hold the same thing, kept only where the records
 * bear it out.
 *
 * ── THE MODEL READS MEANING; THE RECORDS DECIDE ───────────────────────────
 *
 * Nobody can list every word every system uses for the same thing, which is
 * why a model is asked: it sees `town` in one system and `city` in another and
 * knows what both are. But what it says changes how every later question is
 * read, so it is checked, not trusted. Each claim has to be:
 *
 *  - about fields Silo itself listed as held apart, in different systems —
 *    two fields of ONE system are two things there, whatever they are called;
 *  - borne out by the records in front of it: enough of them hold both, and
 *    most of those hold the same thing.
 *
 * A claim that fails is dropped without a word. The fields stay two fields,
 * which is what they were.
 *
 * COUNTS COME BACK, NEVER VALUES: how many records were compared and how many
 * agreed is the evidence shown beside the match and all that is kept of it.
 */
export function sameFieldsOf(raw: unknown, parts: readonly ReadingPart[]): SameFields[] {
  if (!Array.isArray(raw)) return [];
  const kept: SameFields[] = [];
  /* A field belongs to one match at most, per part. */
  const taken = new Set<string>();

  for (const entry of raw.slice(0, 8)) {
    if (!entry || typeof entry !== 'object') continue;
    const body = entry as Record<string, unknown>;
    const index = typeof body.part === 'number' ? body.part - 1 : parts.length === 1 ? 0 : -1;
    const part = parts[index];
    if (!part?.apart || !Array.isArray(body.fields)) continue;

    const fields = [...new Set(body.fields.filter((one): one is string => typeof one === 'string'))];
    if (fields.length < 2 || fields.length > 4) continue;
    if (fields.some((field) => taken.has(`${index}:${field}`))) continue;

    const held = fields.map((field) => part.apart!.find((one) => one.field === field)?.systems);
    if (held.some((systems) => !systems || systems.length === 0)) continue;

    /* Different systems, and no system twice: one system's two fields are two things. */
    const systems = held.flatMap((one) => one!);
    if (new Set(systems).size !== systems.length) continue;

    let compared = 0;
    let agreed = 0;
    for (const row of part.rows) {
      const values = fields.map((field) => comparable(row.values[field])).filter((one): one is string => one !== null);
      if (values.length < 2) continue;
      compared += 1;
      /* One thing written two ways — `UK`, `United Kingdom` — is agreement. */
      if (values.every((one) => one === values[0] || writtenAlike(one, values[0]) !== null)) agreed += 1;
    }

    if (compared < SAME_NEEDS || agreed / compared < SAME_AGREES) continue;

    /* The name the model chose where it is one of them; otherwise the one most systems already use. */
    const as =
      typeof body.as === 'string' && fields.includes(body.as)
        ? body.as
        : [...fields].sort(
            (a, b) =>
              held[fields.indexOf(b)]!.length - held[fields.indexOf(a)]!.length || (a < b ? -1 : a > b ? 1 : 0),
          )[0]!;

    for (const field of fields) taken.add(`${index}:${field}`);
    kept.push({ part: index, fields, as, compared, agreed });
  }

  return kept;
}

/* ── Judging, coverage and recommendations ────────────────────────────── */

export type Judged = {
  part: number;
  record: string;
  meets: 'yes' | 'no' | 'unclear';
  /** Where the judgement came from: the record's own field, the web, or nowhere. */
  from: 'records' | 'web' | 'none';
  field?: string;
  sources?: number[];
};

export type Coverage = {
  part: number;
  criterion: string;
  /** Records the question matched, and how many of them were judged at all. */
  matched: number;
  judged: number;
  fromRecords: number;
  fromWeb: number;
  undetermined: number;
};

export type Recommendation = {
  part: number;
  field: string;
  why: string;
  records: Array<{ record: string; value: string; sources?: number[] }>;
};

const present = (value: unknown) => value !== null && value !== undefined && value !== '';

/**
 * The judgements the model made, kept only where they hold.
 *
 * ── A CLAIM ABOUT WHERE IT CAME FROM IS CHECKED ───────────────────────────
 *
 * "From the records" must name a field the record actually holds a value in;
 * "from the web" must cite a source that was given. A judgement that claims
 * either and cannot show it is not dropped — the record still needs saying —
 * but becomes what it honestly is: undetermined.
 */
export function judgedOf(raw: unknown, parts: readonly ReadingPart[], sources: ReadonlySet<number>): Judged[] {
  if (!Array.isArray(raw)) return [];
  const kept: Judged[] = [];
  const seen = new Set<string>();

  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const body = entry as Record<string, unknown>;
    const index = typeof body.part === 'number' ? body.part - 1 : parts.length === 1 ? 0 : -1;
    const part = parts[index];
    if (!part?.judge) continue;
    const row = part.rows.find((one) => one.name === body.record);
    if (!row || seen.has(`${index}|${row.name}`)) continue;
    seen.add(`${index}|${row.name}`);

    const meets = body.meets === 'yes' || body.meets === 'no' ? body.meets : 'unclear';
    const cited = Array.isArray(body.sources) ? body.sources.filter((n): n is number => typeof n === 'number' && sources.has(n)) : [];
    const field = typeof body.field === 'string' ? body.field : undefined;

    if (body.from === 'records' && field && present(row.values[field]) && meets !== 'unclear') {
      kept.push({ part: index, record: row.name, meets, from: 'records', field });
    } else if (body.from === 'web' && cited.length > 0 && meets !== 'unclear') {
      kept.push({ part: index, record: row.name, meets, from: 'web', sources: cited });
    } else {
      kept.push({ part: index, record: row.name, meets: 'unclear', from: 'none' });
    }
  }
  return kept;
}

/** How much of each judged part was answered, and from where — counted here, not by the model. */
export function coverageOf(judged: readonly Judged[], parts: readonly ReadingPart[]): Coverage[] {
  return parts.flatMap((part, index) => {
    if (!part.judge) return [];
    const mine = judged.filter((one) => one.part === index);
    return [
      {
        part: index,
        criterion: part.judge,
        matched: part.matched,
        judged: part.rows.length,
        fromRecords: mine.filter((one) => one.from === 'records').length,
        fromWeb: mine.filter((one) => one.from === 'web').length,
        undetermined: part.rows.length - mine.filter((one) => one.from !== 'none').length,
      },
    ];
  });
}

/**
 * What the model recommends recording, kept only where it can be.
 *
 * A FIELD THE SYSTEM HOLDS, ON A RECORD THAT WAS READ. A recommendation is an
 * offer to write, and a write can only set a field that exists on a record
 * that exists — so a field not on the system's list, or a record not in the
 * answer, is dropped rather than offered and refused later.
 */
export function recommendationsOf(raw: unknown, parts: readonly ReadingPart[], sources: ReadonlySet<number>): Recommendation[] {
  if (!Array.isArray(raw)) return [];
  const kept: Recommendation[] = [];

  for (const entry of raw.slice(0, 8)) {
    if (!entry || typeof entry !== 'object') continue;
    const body = entry as Record<string, unknown>;
    const index = typeof body.part === 'number' ? body.part - 1 : parts.length === 1 ? 0 : -1;
    const part = parts[index];
    if (!part || typeof body.field !== 'string') continue;
    const known = new Set([...part.profile.map((one) => one.fieldPath), ...(part.empty ?? [])]);
    if (!known.has(body.field)) continue;

    const records = (Array.isArray(body.records) ? body.records : []).flatMap((one) => {
      if (!one || typeof one !== 'object') return [];
      const item = one as Record<string, unknown>;
      const row = part.rows.find((candidate) => candidate.name === item.record);
      const value = typeof item.value === 'string' || typeof item.value === 'number' ? String(item.value).trim().slice(0, 500) : '';
      if (!row || !value) return [];
      const cited = Array.isArray(item.sources) ? item.sources.filter((n): n is number => typeof n === 'number' && sources.has(n)) : [];
      return [{ record: row.name, value, ...(cited.length ? { sources: cited } : {}) }];
    });
    if (records.length === 0) continue;

    kept.push({
      part: index,
      field: body.field,
      why: typeof body.why === 'string' ? body.why.trim().slice(0, 300) : '',
      records,
    });
  }
  return kept;
}
