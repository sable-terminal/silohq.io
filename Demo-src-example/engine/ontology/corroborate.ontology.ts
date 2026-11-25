import { keyOf } from '../detectors/shared.detector';
import { writtenAlike } from './written.ontology';
import type { ContributingObject } from '../../models/concept.model';

/**
 * §2.4 (132) — whether records two systems match on a key are the same things.
 *
 * ── A SHARED KEY IS A CLAIM, AND THIS IS THE CHECK ON IT ──────────────────
 *
 * Derivation proposes that two objects are one concept because the same
 * identifiers appear in both. That is usually right and sometimes a
 * coincidence: two tables numbered from one share every number and nothing
 * else, and company 17 is not support organisation 17.
 *
 * A person confirming a proposal settles it by looking. For Silo to make the
 * concept itself, the records have to settle it: among the records that match
 * on the key, SOMETHING ELSE must agree too — a name, an email, an amount.
 * Rows that are the same thing agree about more than their number; rows that
 * merely share one do not.
 *
 * ── WHICH FIELD IS NOT SAID IN ADVANCE ────────────────────────────────────
 *
 * Nothing here knows what a name is. Every field of one side is compared with
 * every field of the other, by value, over the matched records, and the pair
 * that agrees most is the evidence — whatever the two systems call it.
 *
 * ── AND IT HAS TO BE EVIDENCE ─────────────────────────────────────────────
 *
 *  - not the key again: a second column holding the same identifier agrees by
 *    construction, and says nothing the key did not;
 *  - not one value repeated: every record being in the UK, or active, makes two
 *    country columns agree on any pairing of any records at all;
 *  - not a yes or a no, for the same reason.
 *
 * VALUES ARE ARGUMENTS HERE AND NOTHING ELSE. Counts come back.
 */

type Row = Record<string, unknown>;

export type Corroboration = {
  /** Records both systems hold, by the proposed key. */
  matched: number;
  /**
   * The other field they agree on most, in each system's own name: how many
   * matched records held both, and how many of those held the same thing.
   * Null where nothing bears the match out.
   */
  on: { a: string; b: string; compared: number; agreed: number } | null;
  /**
   * Every pair of fields the matched records agree on, best first, each field
   * in one pair at most — `on` is the first of them.
   *
   * THE SAME EVIDENCE ANSWERS A SECOND QUESTION. Fields that agree on most of
   * the records two systems share are the same field under two names, and the
   * concept made from this should read them as one from its first question.
   */
  same: Array<{ a: string; b: string; compared: number; agreed: number }>;
};

/* Fewer matched records than this is not enough to say anything about them. */
const MATCHED_NEEDS = 5;
/* This share of the matched records holding both fields must hold the same thing in them. */
const AGREES = 0.6;
/* And over at least this many different values, or it is one value repeated. */
const DISTINCT_NEEDS = 3;

const scalar = (value: unknown): string | null => {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const text = String(value).trim().toLowerCase().replace(/\s+/g, ' ');
  return text === '' ? null : text;
};

export function corroborate(input: {
  a: { rows: readonly Row[]; keys: readonly string[] };
  b: { rows: readonly Row[]; keys: readonly string[] };
}): Corroboration {
  const theirs = new Map<string, Row>();
  for (const row of input.b.rows) {
    const key = keyOf(row, [...input.b.keys]);
    if (key !== null && !theirs.has(key)) theirs.set(key, row);
  }

  const pairs: Array<{ a: Row; b: Row; key: Set<string> }> = [];
  const seen = new Set<string>();
  for (const row of input.a.rows) {
    const key = keyOf(row, [...input.a.keys]);
    if (key === null || seen.has(key)) continue;
    const other = theirs.get(key);
    if (!other) continue;
    seen.add(key);

    /* What the key itself holds, on either side: a field repeating it is not a second fact. */
    const held = new Set<string>();
    for (const column of input.a.keys) {
      const value = scalar(row[column]);
      if (value !== null) held.add(value);
    }
    for (const column of input.b.keys) {
      const value = scalar(other[column]);
      if (value !== null) held.add(value);
    }
    pairs.push({ a: row, b: other, key: held });
  }

  if (pairs.length < MATCHED_NEEDS) return { matched: pairs.length, on: null, same: [] };

  const keyA = new Set(input.a.keys);
  const keyB = new Set(input.b.keys);

  /* "a column\u0000b column" -> the values they agreed on. */
  const agreed = new Map<string, { count: number; values: Set<string> }>();

  for (const pair of pairs) {
    const byValue = new Map<string, string[]>();
    for (const [column, raw] of Object.entries(pair.b)) {
      if (keyB.has(column)) continue;
      const value = scalar(raw);
      if (value === null || pair.key.has(value)) continue;
      byValue.set(value, [...(byValue.get(value) ?? []), column]);
    }

    for (const [column, raw] of Object.entries(pair.a)) {
      if (keyA.has(column)) continue;
      const value = scalar(raw);
      if (value === null || pair.key.has(value)) continue;

      for (const other of byValue.get(value) ?? []) {
        const id = `${column}\u0000${other}`;
        const held = agreed.get(id) ?? { count: 0, values: new Set<string>() };
        held.count += 1;
        if (held.values.size < DISTINCT_NEEDS) held.values.add(value);
        agreed.set(id, held);
      }
    }
  }

  const borne: Corroboration['same'] = [];

  for (const [id, held] of agreed) {
    if (held.values.size < DISTINCT_NEEDS) continue;
    const [a, b] = id.split('\u0000') as [string, string];

    const compared = pairs.filter((pair) => scalar(pair.a[a]) !== null && scalar(pair.b[b]) !== null).length;
    if (compared < MATCHED_NEEDS || held.count / compared < AGREES) continue;

    borne.push({ a, b, compared, agreed: held.count });
  }

  /* The most agreement first, then the names, so the same records always give the same answer. */
  borne.sort((x, y) => y.agreed - x.agreed || (x.a < y.a ? -1 : x.a > y.a ? 1 : 0) || (x.b < y.b ? -1 : x.b > y.b ? 1 : 0));

  /* One partner each. A field agreeing with two of the other side's is matched with the one it agrees with more. */
  const takenA = new Set<string>();
  const takenB = new Set<string>();
  const same = borne.filter((one) => {
    if (takenA.has(one.a) || takenB.has(one.b)) return false;
    takenA.add(one.a);
    takenB.add(one.b);
    return true;
  });

  return { matched: pairs.length, on: same[0] ?? null, same };
}

/**
 * Whether two NAMED columns hold the same thing, over the records two objects
 * share (131).
 *
 * ── THE SAME CHECK, ASKED ABOUT ONE PAIR ──────────────────────────────────
 *
 * `corroborate` finds which fields agree. This is told which two — because a
 * model writing an answer up said one system's `town` is another's `city` —
 * and says whether the systems' own records bear that out, by the same rule:
 * enough matched records hold both, most of those hold the same thing, and
 * over more than one value repeated.
 *
 * READ FROM THE SYSTEMS, NOT FROM WHOEVER ASKED. The rows are ones Silo fetched
 * for this, so what is learned does not rest on anything a request supplied.
 */
export function agreementOn(input: {
  a: { rows: readonly Row[]; keys: readonly string[]; column: string };
  b: { rows: readonly Row[]; keys: readonly string[]; column: string };
}): { compared: number; agreed: number; borneOut: boolean } {
  const theirs = new Map<string, Row>();
  for (const row of input.b.rows) {
    const key = keyOf(row, [...input.b.keys]);
    if (key !== null && !theirs.has(key)) theirs.set(key, row);
  }

  let compared = 0;
  let agreed = 0;
  const values = new Set<string>();
  const seen = new Set<string>();

  for (const row of input.a.rows) {
    const key = keyOf(row, [...input.a.keys]);
    if (key === null || seen.has(key)) continue;
    const other = theirs.get(key);
    if (!other) continue;
    seen.add(key);

    const mine = scalar(row[input.a.column]);
    const yours = scalar(other[input.b.column]);
    if (mine === null || yours === null) continue;

    compared += 1;
    /* `UK` and `United Kingdom` are two systems agreeing: a field is not a different field for being abbreviated in one of them. */
    if (mine === yours || writtenAlike(row[input.a.column], other[input.b.column]) !== null) {
      agreed += 1;
      if (values.size < DISTINCT_NEEDS) values.add(mine);
    }
  }

  return {
    compared,
    agreed,
    borneOut: compared >= MATCHED_NEEDS && agreed / compared >= AGREES && values.size >= DISTINCT_NEEDS,
  };
}

/**
 * A concept's objects with one name for each field its systems were found to
 * share.
 *
 * ── WHAT A NAMING CONVENTION CANNOT KNOW ──────────────────────────────────
 *
 * Field maps are derived from each system's own column names, so `town` and
 * `City` are two fields, and — less forgivably — so are the two columns the
 * concept is MATCHED ON whenever the convention spells them differently:
 * `companies.company_number` loses its object's name and becomes `number`,
 * beside a ledger's `company_number`. A question about the company number then
 * reaches one system.
 *
 * `links` are columns known to hold the same thing: each slot of the match
 * key, which is the same by definition, and every pair `corroborate` found the
 * matched records agreeing on. Each group of linked columns is given one name.
 *
 * THE NAME IS ONE THE SYSTEMS ALREADY USE — the commonest among the group,
 * then the longer, then the first in order — never a new word.
 *
 * NEVER OVER A FIELD AN OBJECT ALREADY HAS under that name for another column:
 * that object keeps its own name for it, which is no worse than before.
 *
 * FOR A CONCEPT SILO IS MAKING. One a person confirmed says what they decided,
 * and is not rewritten; what is learned about its fields afterwards is applied
 * as it is read (`withLearned`).
 */
export function unifyFields(input: {
  objects: readonly ContributingObject[];
  links: ReadonlyArray<{
    a: { connectionId: string; objectName: string; column: string };
    b: { connectionId: string; objectName: string; column: string };
  }>;
}): ContributingObject[] {
  const idOf = (one: { connectionId: string; objectName: string; column: string }) =>
    `${one.connectionId}\u0000${one.objectName}\u0000${one.column}`;

  const parent = new Map<string, string>();
  const rootOf = (id: string): string => {
    const held = parent.get(id);
    if (held === undefined || held === id) return id;
    const root = rootOf(held);
    parent.set(id, root);
    return root;
  };

  for (const link of input.links) {
    const [a, b] = [rootOf(idOf(link.a)), rootOf(idOf(link.b))];
    if (a !== b) parent.set(a < b ? b : a, a < b ? a : b);
  }

  const linked = new Set(input.links.flatMap((link) => [idOf(link.a), idOf(link.b)]));

  /* Group -> the names its columns have now, one entry per column that is mapped at all. */
  const groups = new Map<string, Array<{ object: ContributingObject; column: string; name: string }>>();

  for (const object of input.objects) {
    for (const [name, column] of Object.entries(object.fieldMap)) {
      const id = idOf({ connectionId: object.connectionId, objectName: object.objectName, column });
      if (!linked.has(id)) continue;
      const root = rootOf(id);
      groups.set(root, [...(groups.get(root) ?? []), { object, column, name }]);
    }
  }

  const renames = new Map<ContributingObject, Array<{ from: string; to: string; column: string }>>();

  for (const members of groups.values()) {
    if (members.length < 2) continue;

    const counted = new Map<string, number>();
    for (const member of members) counted.set(member.name, (counted.get(member.name) ?? 0) + 1);

    const [chosen] = [...counted].sort(
      ([a, countA], [b, countB]) => countB - countA || b.length - a.length || (a < b ? -1 : a > b ? 1 : 0),
    )[0]!;

    for (const member of members) {
      if (member.name === chosen) continue;
      renames.set(member.object, [...(renames.get(member.object) ?? []), { from: member.name, to: chosen, column: member.column }]);
    }
  }

  return input.objects.map((object) => {
    const fieldMap = { ...object.fieldMap };

    for (const rename of renames.get(object) ?? []) {
      /* Its own field of that name already, for another column: left as it was. */
      if (rename.to in fieldMap) continue;
      delete fieldMap[rename.from];
      fieldMap[rename.to] = rename.column;
    }

    return {
      ...object,
      fieldMap: Object.fromEntries(Object.entries(fieldMap).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))),
    };
  });
}
