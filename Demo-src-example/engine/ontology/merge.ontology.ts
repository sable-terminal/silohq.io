/**
 * §2.8 — what a field's value IS, when the systems holding it disagree.
 *
 * ── The question every cross-system answer runs into ───────────────────────
 *
 * Resolution says these two rows are one invoice. Netsuite says its total is
 * £200 and Sage says £260. A finding is entitled to report both and decide
 * nothing — a disagreement detector that picked a side would be inventing the
 * thing it was asked to look for. A TOTAL is not: it cannot carry two readings,
 * and something has to choose.
 *
 * ── Nothing here chooses ───────────────────────────────────────────────────
 *
 * This applies a choice a person already made, and REFUSES where they have not.
 * Every heuristic that looks like it could stand in is wrong somewhere
 * expensive: most-recently-written is wrong when a nightly sync overwrites a
 * correction; highest-precision is wrong when one system rounds on purpose;
 * the-one-with-more-rows is wrong when it is the stale one. A wrong merge is
 * worse than a refusal, because it produces a number somebody acts on and
 * nothing about it says it was guessed.
 *
 * ── The four answers, and why `disputed` is the important one ──────────────
 *
 * `declared`  — an authority is set and that system had a reading.
 * `agreed`    — no authority, and every system that holds it says the same.
 * `only`      — exactly one system holds it, so there is nothing to reconcile.
 * `disputed`  — they differ and nobody has said who is right. NO VALUE.
 *
 * `disputed` carrying no value is the whole design. It is what makes a total
 * built on this either correct or absent, never quietly wrong.
 */

/**
 * Import §5 — how a value was got, when it was not simply read from a system.
 * Absent means certain: a column, an API field, a confirmed value.
 */
export type Certainty = 'near' | 'inferred';

export type Reading = {
  connectionId: string;
  /** Exactly as that system stated it. Comparison is the caller's rule, below. */
  value: unknown;
  /** Set only for a value read from a document, and not yet confirmed. */
  certainty?: Certainty;
};

/**
 * A source row's certainty for one of its columns, as the row store marks it.
 *
 * `_certainty` IS THE ONLY PLACE IT IS READ FROM, and anything else in it is
 * ignored rather than trusted: a row from a connector that happened to carry a
 * column of that name does not make its values uncertain by accident.
 */
export function certaintyOf(row: Record<string, unknown>, column: string): Certainty | undefined {
  const marks = row._certainty;
  if (!marks || typeof marks !== 'object') return undefined;
  const mark = (marks as Record<string, unknown>)[column];
  return mark === 'near' || mark === 'inferred' ? mark : undefined;
}

/**
 * The certainty of a value several readings agree on.
 *
 * ONE CERTAIN READING MAKES AN AGREED VALUE CERTAIN. A system that holds the
 * figure as a column saying the same as a document is corroboration, not doubt.
 * Where every reading is uncertain, the value is as uncertain as the weakest.
 */
function agreedCertainty(readings: readonly Reading[]): Certainty | undefined {
  if (readings.some((reading) => !reading.certainty)) return undefined;
  return readings.some((reading) => reading.certainty === 'inferred') ? 'inferred' : 'near';
}

export type Authority = {
  conceptId: string;
  fieldPath: string;
  /** The system whose reading wins. */
  connectionId: string;
};

export type Merged = {
  fieldPath: string;
  /** Absent on `disputed`, which is the point rather than an omission. */
  value?: unknown;
  basis: 'declared' | 'agreed' | 'only' | 'disputed';
  /**
   * Every reading, always, including on the paths that produced a value.
   *
   * A MERGED FIGURE WITHOUT ITS SOURCES IS AN ASSERTION. Somebody asking why
   * the total is £200 when they were looking at £260 this morning is owed the
   * two readings and the reason one was taken, not a second copy of the number.
   */
  readings: Reading[];
  /** Set on `declared` where the authority held nothing. See `mergeField`. */
  authorityHeldNothing?: true;
  /**
   * Set on `agreed` where the systems wrote the value differently — `UK` and
   * `United Kingdom` — and it is one thing by how it is written
   * (`written.ontology`). The value is the fuller of them; the readings are
   * each system's own, as it wrote them.
   */
  written?: true;
  /**
   * Set where the value was worked out by Silo rather than read from a system
   * — a count or a total of the records related to this one (§4.1). It has no
   * readings because no system holds it.
   */
  computed?: true;
  /**
   * Import §5 — "This travels with the value everywhere." Set when the value
   * given was read from a document and nothing certain corroborates it.
   */
  certainty?: Certainty;
};

/**
 * Is this the same value, for the purpose of "do they agree"?
 *
 * NUMBERS BY VALUE, TEXT BY THE RESOLVER'S RULE, so `ACME ` and `acme` agree
 * here exactly as they resolve to one entity elsewhere. Anything else is
 * compared by its JSON form, which is strict — two objects that differ only in
 * key order would read as disagreeing, and that is the safe direction: it
 * produces a refusal rather than a merge nobody checked.
 */
function same(a: unknown, b: unknown): boolean {
  if (a === null || a === undefined) return b === null || b === undefined;
  if (b === null || b === undefined) return false;

  if (typeof a === 'number' && typeof b === 'number') return a === b;
  if (typeof a === 'string' && typeof b === 'string') {
    return a.trim().toLowerCase() === b.trim().toLowerCase();
  }

  /*
   * THE FALLBACK CANNOT BE ALLOWED TO THROW. `JSON.stringify` raises a
   * TypeError on a BigInt, and a source returning one turned a question into a
   * 500 rather than into a refusal — the one failure mode this file exists to
   * avoid. Two values it cannot compare are reported as DIFFERENT, which
   * produces a dispute: a refusal to decide, which is the safe direction.
   */
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

/**
 * Is this a number this may add up?
 *
 * ── Coercion was doing arithmetic on things that are not numbers ───────────
 *
 * `Number()` takes far more than it should. Executed against the first version:
 * `'   '` became 0 and halved an average, `'0x10'` became 16, and a Date became
 * 1704067200000 — offered as the earliest invoice date. The guard's own comment
 * claimed non-numeric values were not coerced, and it had only closed off `''`.
 *
 * A STRING IS STILL ACCEPTED, and has to be: `numeric` columns arrive from
 * Postgres as text, so refusing strings outright would refuse most real sums.
 * But only a plain decimal — no hex, no exponent, no whitespace-only, no
 * booleans, no dates, nothing whose numeric reading is a convention rather than
 * a value.
 */
const DECIMAL = /^-?\d+(\.\d+)?$/;

export function numeric(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;

  if (typeof value === 'string') {
    const trimmed = value.trim();
    return DECIMAL.test(trimmed) ? Number(trimmed) : null;
  }

  return null;
}

const absent = (value: unknown) => value === null || value === undefined || value === '';

/**
 * Merge one field of one entity.
 *
 * ── An absent reading is not a disagreement ────────────────────────────────
 *
 * A system that holds no value for a field is not arguing about it. Counting
 * absence as a third opinion would make almost every field disputed, because
 * partial population is the normal state of an estate — and it would hide the
 * disagreements that are real behind a wall of ones that are not.
 *
 * ── An authority that holds nothing does not fall back ─────────────────────
 *
 * If somebody has said Netsuite decides `total` and Netsuite has no total for
 * this invoice, the answer is not Sage's. That would be the heuristic this file
 * exists to refuse, wearing a declaration as cover. It reports no value and
 * says the authority held nothing, which is a fact somebody can act on — either
 * the record is missing there, or the authority is on the wrong system.
 */
export function mergeField(input: {
  fieldPath: string;
  readings: readonly Reading[];
  authority?: Authority;
  /**
   * What a reading's value is read as, where the answer found it is one thing
   * written two ways. Used to compare and for the value given; the reading
   * itself is left as its system wrote it.
   */
  readAs?: (reading: Reading) => unknown;
}): Merged {
  const readings = [...input.readings].sort((a, b) =>
    a.connectionId < b.connectionId ? -1 : a.connectionId > b.connectionId ? 1 : 0,
  );

  const held = readings.filter((reading) => !absent(reading.value));

  if (input.authority) {
    const decided = held.find(
      (reading) => reading.connectionId === input.authority!.connectionId,
    );

    if (decided) {
      return {
        fieldPath: input.fieldPath,
        value: decided.value,
        basis: 'declared',
        readings,
        ...(decided.certainty ? { certainty: decided.certainty } : {}),
      };
    }

    return {
      fieldPath: input.fieldPath,
      basis: 'declared',
      readings,
      authorityHeldNothing: true,
    };
  }

  if (held.length === 0) {
    /* Nobody holds it. Not disputed — there is nothing to dispute. */
    return { fieldPath: input.fieldPath, value: null, basis: 'only', readings };
  }

  if (held.length === 1) {
    const certainty = held[0]!.certainty;
    return { fieldPath: input.fieldPath, value: held[0]!.value, basis: 'only', readings, ...(certainty ? { certainty } : {}) };
  }

  const first = held[0]!.value;
  if (held.every((reading) => same(reading.value, first))) {
    const certainty = agreedCertainty(held);
    return { fieldPath: input.fieldPath, value: first, basis: 'agreed', readings, ...(certainty ? { certainty } : {}) };
  }

  /* Not the same as written — but perhaps one thing written two ways, which the caller worked out over the whole answer. */
  if (input.readAs) {
    const read = input.readAs(held[0]!);
    if (held.every((reading) => same(input.readAs!(reading), read))) {
      const certainty = agreedCertainty(held);
      return { fieldPath: input.fieldPath, value: read, basis: 'agreed', readings, written: true, ...(certainty ? { certainty } : {}) };
    }
  }

  /* THE REFUSAL. They differ and nobody has said who is right. */
  return { fieldPath: input.fieldPath, basis: 'disputed', readings };
}

/**
 * Merge every field of one entity.
 *
 * ORDERED BY FIELD NAME, so two entities read the same way and a diff between
 * two answers is a difference in the data rather than in the iteration.
 */
export function mergeEntity(input: {
  fields: ReadonlyArray<{ fieldPath: string; readings: readonly Reading[] }>;
  authorities: readonly Authority[];
  /** Per field, what a reading is read as where it is one thing written two ways. */
  readAs?: (fieldPath: string, reading: Reading) => unknown;
}): Merged[] {
  const byField = new Map(input.authorities.map((one) => [one.fieldPath, one]));

  return [...input.fields]
    .sort((a, b) => (a.fieldPath < b.fieldPath ? -1 : a.fieldPath > b.fieldPath ? 1 : 0))
    .map((field) =>
      mergeField({
        fieldPath: field.fieldPath,
        readings: field.readings,
        authority: byField.get(field.fieldPath),
        ...(input.readAs ? { readAs: (reading: Reading) => input.readAs!(field.fieldPath, reading) } : {}),
      }),
    );
}

/**
 * What a set of merged fields can and cannot be counted.
 *
 * ── Why an aggregate has to ask this before it runs ────────────────────────
 *
 * A `SUM` over a field that is disputed on ninety of two thousand six hundred
 * entities is not a total. It is a total of the two thousand five hundred and
 * ten that happened to agree, presented as though it were the answer — wrong in
 * the most dangerous direction, because it looks authoritative and is short by
 * an amount nobody can see.
 *
 * So every aggregate carries this, and a caller that ignores it is making a
 * visible choice rather than an accidental one.
 */
export type Coverage = {
  /** Entities whose value for this field was decided. */
  counted: number;
  /** Entities where the systems disagree and nobody has said who is right. */
  disputed: number;
  /** Entities where the declared authority held no value. */
  authorityHeldNothing: number;
  /** Entities holding no value anywhere, which is absence rather than conflict. */
  empty: number;
  /**
   * §2.6 — entities whose OTHER SIDE could not be looked at.
   *
   * ── WHY THIS LIVES BESIDE THE FIGURE ──────────────────────────────────────
   *
   * A filter can hide a disagreement: a system whose row falls the other side
   * of the threshold never answers, so a dispute comes back as a decided value.
   * That is re-checked by asking again by identity — except where a source
   * cannot take an `in` list and cannot be asked at all.
   *
   * Reporting that only at the top of the answer was not enough. `coverage` is
   * the field whose documented job is to say what the figures beside it could
   * not account for, and it went on saying `disputed: 0` — actively
   * contradicting the caveat, next to a sum computed as though nothing were
   * missing. A figure has to carry its own doubt.
   *
   * SET BY THE CALLER, NOT COUNTED HERE. Whether a source could be asked is a
   * fact about connectors, which this file knows nothing about and should not.
   */
  unverified?: number;
  /**
   * Import §5 — of the entities counted, how many hold a value read from a
   * document rather than from a system, and how. Present only when any do.
   *
   * "A total made from forty certain values and one inferred value is an
   * uncertain total, and its flag states how many of its inputs were inferred.
   * Without this, extraction uncertainty vanishes at exactly the point it
   * matters most."
   */
  uncertain?: { near: number; inferred: number };
};

function withUncertainty(coverage: Coverage, fields: readonly Merged[]): Coverage {
  const near = fields.filter((field) => field.certainty === 'near').length;
  const inferred = fields.filter((field) => field.certainty === 'inferred').length;
  return near + inferred > 0 ? { ...coverage, uncertain: { near, inferred } } : coverage;
}

export function coverageOf(merged: readonly Merged[]): Coverage {
  const coverage: Coverage = { counted: 0, disputed: 0, authorityHeldNothing: 0, empty: 0 };
  const counted: Merged[] = [];

  for (const field of merged) {
    if (field.basis === 'disputed') coverage.disputed += 1;
    else if (field.authorityHeldNothing) coverage.authorityHeldNothing += 1;
    else if (absent(field.value)) coverage.empty += 1;
    else {
      coverage.counted += 1;
      counted.push(field);
    }
  }

  return withUncertainty(coverage, counted);
}

/* ── Aggregates ──────────────────────────────────────────────────────────── */

/**
 * §7 — counting and totalling over entities rather than rows.
 *
 * ── Why this cannot live in the fan-out ────────────────────────────────────
 *
 * A `SUM` across two systems double-counts every customer that exists in both,
 * and a `COUNT` reports how many ROWS an estate holds rather than how many
 * things it describes. Neither error is visible in the answer: a number comes
 * back, it looks like the number, and it is roughly twice the truth.
 *
 * So an aggregate is only correct DOWNSTREAM of resolution, over entities whose
 * identity somebody has established — which is the one thing this product can
 * do that a federated query tool cannot, and the reason aggregation was never
 * added to the raw query path.
 *
 * ── And why it refuses more often than a database would ────────────────────
 *
 * Each entity's value for the field has to have been DECIDED. Where two systems
 * disagree and nobody has said who is right, `mergeField` returns no value —
 * so there is no number to add. Adding the ones that happen to agree and
 * reporting that as the total is the failure this whole layer is arranged
 * against: it is short by an amount nobody can see, and it looks authoritative.
 *
 * EVERY AGGREGATE CARRIES ITS COVERAGE for that reason. "£4.2M over 2,510
 * invoices, 90 disputed" is an answer somebody can act on. "£4.2M" alone is
 * not, and the difference is the ninety.
 */

export type Aggregate = 'count' | 'sum' | 'average' | 'minimum' | 'maximum';

export type Aggregated = {
  operation: Aggregate;
  fieldPath: string;
  /**
   * Null where nothing could be counted — an empty answer, or a field decided
   * for no entity at all. Not zero: a sum of nothing is not nought, and
   * reporting it as nought would be a figure somebody could act on.
   */
  value: number | null;
  /** What the figure was computed over, and what it could not include. */
  coverage: Coverage;
  /**
   * Import §5 — the figure's own flag: `inferred` if any value added into it
   * was, `near` if any was read from a document's layout. How many is in
   * `coverage.uncertain`.
   */
  certainty?: Certainty;
  /**
   * The arithmetic ran and the result will not fit in a double.
   *
   * DIFFERENT FROM `value: null`, which means nothing was countable. Without
   * this the two are indistinguishable, and an estate whose total overflows
   * reads as an estate with no totals at all.
   */
  overflowed?: true;
};

/**
 * Aggregate one merged field across a set of entities.
 *
 * NON-NUMERIC VALUES ARE NOT COUNTED, and are reported as uncounted rather than
 * coerced. `Number('open')` is NaN and `Number('')` is nought, and both would
 * quietly become part of a total.
 */
export function aggregate(input: {
  operation: Aggregate;
  fieldPath: string;
  /** One merged field per entity, all for the same `fieldPath`. */
  fields: readonly Merged[];
}): Aggregated {
  const coverage = coverageOf(input.fields);

  /*
   * COUNT IS ENTITIES, NOT VALUES, and it is the one operation that does not
   * need the field decided: "how many invoices" is answerable even where their
   * totals disagree. It counts what resolution produced.
   */
  if (input.operation === 'count') {
    return {
      operation: 'count',
      fieldPath: input.fieldPath,
      value: input.fields.length,
      coverage,
    };
  }

  const numbers: number[] = [];
  const added: Merged[] = [];
  let uncountable = 0;

  for (const field of input.fields) {
    if (field.basis === 'disputed' || field.authorityHeldNothing) continue;
    if (absent(field.value)) continue;

    const value = numeric(field.value);

    /* Decided, present, and not a number. Reported rather than coerced. */
    if (value === null) {
      uncountable += 1;
      continue;
    }

    numbers.push(value);
    added.push(field);
  }

  /*
   * THE SAME CORRECTION ON BOTH PATHS. The early return used to hand back the
   * uncorrected coverage, so five entities all holding `'open'` reported
   * `counted: 5, empty: 0` beside `value: null` — while the same set plus one
   * number reported `counted: 1, empty: 4`. The figure's denominator changed
   * shape according to whether anything was countable at all.
   */
  const { uncertain: _everyValue, ...rest } = coverage;
  const counted: Coverage = withUncertainty(
    { ...rest, counted: numbers.length, empty: coverage.empty + uncountable },
    added,
  );
  const certainty: Certainty | undefined = counted.uncertain
    ? counted.uncertain.inferred > 0
      ? 'inferred'
      : 'near'
    : undefined;
  const flagged = certainty ? { certainty } : {};

  if (numbers.length === 0) {
    return { operation: input.operation, fieldPath: input.fieldPath, value: null, coverage: counted };
  }

  const total = numbers.reduce((sum, one) => sum + one, 0);

  const value =
    input.operation === 'sum'
      ? total
      : input.operation === 'average'
        ? total / numbers.length
        : input.operation === 'minimum'
          ? /*
             * REDUCED, NOT SPREAD. `Math.min(...numbers)` passes every entity
             * as an ARGUMENT, and above roughly 125,000 of them that overflows
             * the call stack — a RangeError, not a refusal, on a question that
             * `sum` and `count` answer perfectly well over the same population.
             * `maxRows` is 50,000 PER SOURCE, so a concept spanning three
             * systems reaches it.
             */
            numbers.reduce((low, one) => (one < low ? one : low), Infinity)
          : numbers.reduce((high, one) => (one > high ? one : high), -Infinity);

  /*
   * ── AN OVERFLOW IS NOT "NOTHING TO COUNT" ────────────────────────────────
   *
   * Two sums of 1e308 come to Infinity, and the first version returned
   * `value: null` beside `counted: 2` — null being the shape this type
   * documents as nothing having been countable. A reader cannot tell an estate
   * with no decided totals from one whose total will not fit in a double.
   */
  if (!Number.isFinite(value)) {
    return {
      operation: input.operation,
      fieldPath: input.fieldPath,
      value: null,
      overflowed: true,
      coverage: counted,
      ...flagged,
    };
  }

  return { operation: input.operation, fieldPath: input.fieldPath, value, coverage: counted, ...flagged };
}

/**
 * §7 — put the answer in the order that was asked for.
 *
 * ── Why this cannot be left to the sources ─────────────────────────────────
 *
 * `planConceptQuery` pushes the sort down and every source honours it, so the
 * rows arrive ordered. THEN RESOLUTION THROWS IT AWAY: `resolveEntities` has to
 * group rows into entities, and it orders the result by match key so the
 * grouping is deterministic. Nothing put the asked-for order back, and the
 * limit then cut the first N off a list ordered by invoice number.
 *
 * "The three largest invoices" came back as two of the three SMALLEST. Not an
 * arbitrary three — a systematically wrong three, and the answer said nothing.
 *
 * ── It has to happen on the merged value, not on a row ─────────────────────
 *
 * Two systems can disagree about `total`, and the number a person sorts by is
 * the one they are shown: the declared authority's reading, not whichever
 * source happened to sort first. So ordering belongs after `mergeEntity` and
 * before the limit, which is the only point where the figure exists.
 *
 * ── An undecided value is not a small one ──────────────────────────────────
 *
 * A disputed field has NO value. Treating that as zero would rank it bottom of
 * "largest" and top of "smallest" — a confident position derived from an
 * absence. Undecided entities go last under either direction and the count
 * comes back, so the caller can say how many could not be placed.
 */
/**
 * A value reduced to something that can be put in order, and what kind it is.
 *
 * A DATE IS A MOMENT, NOT ITS OWN SPELLING. `String(new Date(...))` begins with
 * the WEEKDAY NAME, so ordering dates as text sorted them Fri, Mon, Sat, Sun,
 * Thu, Tue, Wed — and "the most recent" returned whichever happened to fall on
 * a Wednesday. ISO strings happen to sort correctly as text and `Date` objects
 * emphatically do not, which is why this cannot be left to `String`.
 */
function comparable(value: unknown): { kind: 'number' | 'string'; at: number | string } | null {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : { kind: 'number', at: value.getTime() };
  }

  const asNumber = numeric(value);
  if (asNumber !== null) return { kind: 'number', at: asNumber };

  if (typeof value === 'string') return { kind: 'string', at: value };

  /* A boolean or an object cannot be put in order against anything, and
     inventing a position for it is how a confident wrong answer starts. */
  return null;
}

export function orderEntities<T extends { fields: Merged[] }>(
  entities: readonly T[],
  sort: ReadonlyArray<{ field: string; direction: 'asc' | 'desc' }>,
): { ordered: T[]; unplaceable: number } {
  if (sort.length === 0) return { ordered: [...entities], unplaceable: 0 };

  const valueOf = (entity: T, fieldPath: string): unknown => {
    const field = entity.fields.find((one) => one.fieldPath === fieldPath);
    /* `disputed` carries no `value` at all, which is the point rather than an
       omission — see `Merged`. */
    if (!field || field.basis === 'disputed') return undefined;
    return field.value ?? undefined;
  };

  /*
   * PLACEABLE ON THE FIRST KEY ONLY. A secondary key that is undecided is a
   * tie-break nobody can make, not a reason to banish the entity from an
   * ordering its primary value placed perfectly well.
   */
  const lead = sort[0]!.field;
  const placeable = (entity: T) => comparable(valueOf(entity, lead)) !== null;

  const compare = (a: T, b: T): number => {
    for (const { field, direction } of sort) {
      const left = valueOf(a, field);
      const right = valueOf(b, field);

      if (left === undefined && right === undefined) continue;
      /* Undecided last, whichever way round the question was asked. */
      if (left === undefined) return 1;
      if (right === undefined) return -1;

      const first = comparable(left);
      const second = comparable(right);

      if (first === null && second === null) continue;
      if (first === null) return 1;
      if (second === null) return -1;

      /*
       * ── KIND BEFORE VALUE, SO THE COMPARATOR IS A TOTAL ORDER ────────────
       *
       * A field holding 1000, 300 and "$2,500.00" used to be compared
       * pairwise as numbers OR as text depending which pair was being looked
       * at, which is not transitive — so the result depended on the order the
       * population happened to arrive in, and two identical questions could
       * answer differently.
       *
       * Numbers and dates sort together and before text. A money-formatted
       * string is not a number to `numeric`, deliberately — it refuses
       * coercion because a sum that coerced would be silently wrong — so it
       * lands with the text, in a defined place rather than a random one.
       */
      const order =
        first.kind !== second.kind
          ? first.kind === 'number'
            ? -1
            : 1
          : first.kind === 'number'
            ? (first.at as number) - (second.at as number)
            : /* NOT `localeCompare`, WHICH IS LOCALE-DEPENDENT and would order
                 the same estate differently on two machines. */
              (first.at as string) < (second.at as string)
                ? -1
                : (first.at as string) > (second.at as string)
                  ? 1
                  : 0;

      if (order !== 0) return direction === 'desc' ? -order : order;
    }

    return 0;
  };

  const ordered = [...entities].sort((a, b) => {
    const left = placeable(a);
    const right = placeable(b);
    if (left !== right) return left ? -1 : 1;
    return compare(a, b);
  });

  return { ordered, unplaceable: entities.filter((one) => !placeable(one)).length };
}
