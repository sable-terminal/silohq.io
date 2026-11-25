/**
 * Rendering §6 — the three things a rendered element may carry.
 *
 * "Three things a rendered element may carry, and ALL THREE MUST BE VISIBLE IN
 * EVERY REPRESENTATION."
 *
 * ── NONE OF THIS IS DECIDED HERE ──────────────────────────────────────────
 *
 * §1 — "The render layer decides nothing about what is true." Every flag below
 * is read off a result that already carries it: `basis: 'disputed'` is the merge
 * layer saying two systems disagreed and it took neither, `certainty` is the
 * import layer saying a value came off a document's layout rather than a
 * column, and `coverage` is the count of what a figure could not include.
 *
 * What this file does is make them one shape, so §6's "visible in every
 * representation" is a property of the data rather than a thing each renderer
 * remembers separately. A flag the table shows and the prose does not is the
 * failure mode, and it is invisible.
 *
 * ── AND §6'S LAST PARAGRAPH IS THE ONE THAT MATTERS ───────────────────────
 *
 * "Uncertainty propagates through aggregation. A total made from forty certain
 * values and one inferred value is an uncertain total, and its flag states how
 * many of its inputs were inferred. WITHOUT THIS, UNCERTAINTY VANISHES EXACTLY
 * WHERE IT MATTERS MOST."
 *
 * The merge layer already does the propagating — `Aggregated.certainty` is set
 * when any value added into a total was uncertain, and `coverage.uncertain` is
 * how many. This carries both onto the total's own flag, because a reader
 * looking at one number is the person §6 is written for.
 */

export type FlagKind = 'disagreement' | 'extraction' | 'incompleteness';

export interface Flag {
  kind: FlagKind;
  /** What the flag is on: a field path, an aggregate, or the answer itself. */
  subject: string;
  /** One line a reader sees without opening anything. */
  summary: string;
  /**
   * What opening it reveals. §6 — the extraction flag "opens the extraction
   * method, the source document and location, the raw text it was read from,
   * and the model's confidence"; the disagreement flag opens both values "with
   * which system said what".
   *
   * REFERENCES AND COUNTS ONLY AT THIS LAYER. The detail a flag opens lives
   * with the value it belongs to — a `Merged` carries every reading, an
   * extraction carries its own position — so this names where to look rather
   * than copying it and letting the two drift.
   */
  detail: Record<string, unknown>;
}

/** The part of a merged field a flag is read from. */
export interface FlaggableField {
  fieldPath: string;
  basis: string;
  certainty?: 'near' | 'inferred';
  readings: Array<{ connectionId: string; value: unknown; certainty?: 'near' | 'inferred' }>;
}

export interface FlaggableAggregate {
  operation: string;
  fieldPath: string;
  certainty?: 'near' | 'inferred';
  /*
   * §6 — "its flag states HOW MANY of its inputs were inferred".
   *
   * The merge layer splits the two kinds, and this keeps them split: a value
   * read from a document's layout and a value a model guessed are different
   * claims, and collapsing them to one number would make the flag say less
   * than the data does.
   */
  coverage: { counted: number; uncertain?: { near: number; inferred: number } | undefined };
}

export interface FlaggableResult {
  entities: Array<{ fields: FlaggableField[] }>;
  aggregates: readonly FlaggableAggregate[];
  coverage: Record<
    string,
    { counted: number; disputed: number; empty: number; unverified?: number | undefined }
  >;
  /** §2.6 — systems that could not be asked about a counterpart. */
  unverified?: { connectionIds: string[]; entities: number };
  /** §7 — fields the question filtered on, and the systems that do not hold them. */
  unheld?: Array<{ fieldPath: string; connectionIds: string[]; unchecked?: number }>;
  /**
   * Siloes (135) — the systems this was read from a kept copy of, and when
   * each copy was made. With `freshAt` (137), the records that system marks
   * as changed since were read live then and laid over the copy.
   */
  asOf?: Array<{ connectionId: string; syncedAt: string; freshAt?: string; changed?: number; by?: string }>;
  /** Siloes (136) — the past moment the question asked about, where it asked about one. */
  asAt?: string;
  /** §2.3 — learned field matches this answer found no longer hold. */
  unlearned?: Array<{ fieldPath: string; connectionId: string; sourceField: string; compared: number; agreed: number }>;
  /** Sources that answered with an error, and what it was. */
  unreachable?: Array<{ connectionId: string; because: string }>;
  /** A traversal that stopped at its bound, named. */
  bounded?: Array<{ at: string; because: string }>;
}

const HOW_READ: Record<string, string> = {
  near: 'read from where it sat on the page rather than from a column',
  inferred: 'inferred by a model rather than read directly',
};

/**
 * §6 — every flag this result carries, in one list.
 *
 * ORDERED BY HOW MUCH THEY CHANGE THE ANSWER: a disagreement means the figure
 * is not settled, an extraction means it may be wrong, an incompleteness means
 * something is missing from it. A renderer showing only the first still shows
 * the one that matters most.
 */
export function flagsOf(result: FlaggableResult): Flag[] {
  const flags: Flag[] = [];

  /*
   * EVERY PART OF THE RESULT IS OPTIONAL HERE, and that is §4.4's spirit
   * applied to flags: the floor renders any result rather than failing, and a
   * render layer that threw because an answer arrived without a coverage map
   * would take down the export of a perfectly good result. Absent means
   * nothing to flag, which is also what it means.
   */
  const entities = result.entities ?? [];
  const aggregates = result.aggregates ?? [];
  const coverage = result.coverage ?? {};

  /* ── Disagreement ─────────────────────────────────────────────────────── */

  const disputed = new Map<string, Map<string, unknown>>();

  for (const entity of entities) {
    for (const field of entity.fields ?? []) {
      if (field.basis !== 'disputed') continue;
      const held = disputed.get(field.fieldPath) ?? new Map<string, unknown>();
      /* §6 — "with which system said what". Keyed by connection so the same
         two systems disagreeing about a hundred rows is one flag naming both,
         not a hundred flags naming the same pair. */
      for (const reading of field.readings) held.set(reading.connectionId, reading.value);
      disputed.set(field.fieldPath, held);
    }
  }

  for (const [fieldPath, systems] of disputed) {
    const count = coverage[fieldPath]?.disputed ?? 0;
    flags.push({
      kind: 'disagreement',
      subject: fieldPath,
      summary:
        `${count} ${count === 1 ? 'record' : 'records'} where systems hold different values for ` +
        `${fieldPath}. Both are kept; neither was taken.`,
      /* §6 — "Both shown, NEVER AVERAGED". There is no mean here to show,
         which is the point: a reader gets the systems and their values. */
      detail: { connections: [...systems.keys()], records: count },
    });
  }

  /* ── Extraction uncertainty ───────────────────────────────────────────── */

  const uncertainFields = new Map<string, 'near' | 'inferred'>();

  for (const entity of entities) {
    for (const field of entity.fields ?? []) {
      if (!field.certainty) continue;
      /* `inferred` outranks `near`: a model's guess is a weaker claim than a
         value read off a layout, and a field with both should read as the
         weaker one. */
      const held = uncertainFields.get(field.fieldPath);
      if (held !== 'inferred') uncertainFields.set(field.fieldPath, field.certainty);
    }
  }

  for (const [fieldPath, certainty] of uncertainFields) {
    flags.push({
      kind: 'extraction',
      subject: fieldPath,
      summary: `Some values for ${fieldPath} were ${HOW_READ[certainty]}.`,
      /*
       * §6 — the flag "opens the extraction method, the source document and
       * location, the raw text it was read from, and the model's confidence".
       * All four live on the extraction record for the value in question, which
       * is reached from the entity rather than copied here: this layer stores
       * and carries no values.
       */
      detail: { certainty, opensVia: 'extraction' },
    });
  }

  /* §6's last paragraph — a total is only as certain as what went into it. */
  for (const aggregate of aggregates) {
    if (!aggregate.certainty) continue;

    const { near = 0, inferred = 0 } = aggregate.coverage.uncertain ?? {};
    const total = near + inferred;

    /* Named separately, weakest first, because that is what the reader is
       deciding on: one inferred value in a total is a different worry from
       forty read off a page. */
    const parts = [
      inferred > 0 ? `${inferred} inferred by a model` : null,
      near > 0 ? `${near} read from a document's layout` : null,
    ].filter((part): part is string => part !== null);

    flags.push({
      kind: 'extraction',
      subject: `${aggregate.operation}(${aggregate.fieldPath})`,
      summary:
        `This total is made from ${aggregate.coverage.counted} ` +
        `${aggregate.coverage.counted === 1 ? 'value' : 'values'}, of which ` +
        `${parts.join(' and ')}.`,
      detail: {
        certainty: aggregate.certainty,
        uncertainInputs: total,
        inferredInputs: inferred,
        nearInputs: near,
        countedInputs: aggregate.coverage.counted,
      },
    });
  }

  /* ── Incompleteness ───────────────────────────────────────────────────── */

  for (const source of result.unreachable ?? []) {
    flags.push({
      kind: 'incompleteness',
      subject: source.connectionId,
      /* §6 — "Named, with the reason." Not "a source was unavailable". */
      summary: `A system could not be reached: ${source.because}.`,
      detail: { connectionId: source.connectionId, because: source.because },
    });
  }

  for (const stop of result.bounded ?? []) {
    flags.push({
      kind: 'incompleteness',
      subject: stop.at,
      summary: `This stopped at ${stop.at}: ${stop.because}.`,
      detail: { at: stop.at, because: stop.because },
    });
  }

  if (result.unverified && result.unverified.entities > 0) {
    flags.push({
      kind: 'incompleteness',
      subject: 'counterparts',
      summary:
        `${result.unverified.entities} ${result.unverified.entities === 1 ? 'record' : 'records'} ` +
        `could not be checked against every system, so a disagreement may be hidden.`,
      detail: {
        connections: result.unverified.connectionIds,
        entities: result.unverified.entities,
      },
    });
  }

  /*
   * READ FROM A COPY, AND WHEN IT WAS MADE. Every other answer is the systems
   * as they are; this one is the systems as they were, and a record changed
   * since is not in it. The oldest copy is the time that holds for all of it.
   */
  if (result.asOf && result.asOf.length > 0) {
    const oldest = [...result.asOf].sort((a, b) => (a.syncedAt < b.syncedAt ? -1 : 1))[0]!.syncedAt;
    /* Caught up only where every system was: the earliest of their reads is the time that holds for all of it. */
    const caughtUp = result.asOf.every((one) => one.freshAt)
      ? {
          at: result.asOf.map((one) => one.freshAt!).sort()[0]!,
          changed: result.asOf.reduce((sum, one) => sum + (one.changed ?? 0), 0),
        }
      : null;
    flags.push({
      kind: 'incompleteness',
      subject: 'copy',
      /*
       * ASKED ABOUT THE PAST, THE COPY IS THE ANSWER AND NOT A CAVEAT ON IT —
       * but it was made near the moment asked about, not at it, and which copy
       * it was is what a reader checking the figure needs.
       */
      summary: result.asAt
        ? `As your systems stood at ${oldest.slice(0, 16).replace('T', ' ')} UTC: the copy kept in your Silo made nearest the date asked about. This is not how they stand now.`
        : caughtUp
          ? /*
             * CAUGHT UP, AND BY WHAT. The claim is no wider than the evidence:
             * the records each system itself marks as changed. One deleted
             * since the copy carries no mark, and is still counted.
             */
            `Read from the copy kept in your Silo made at ${oldest.slice(0, 16).replace('T', ' ')} UTC, and caught up at ${caughtUp.at.slice(0, 16).replace('T', ' ')} UTC: ` +
            `${caughtUp.changed === 0 ? 'your systems mark no record as added or changed since' : `the ${caughtUp.changed.toLocaleString('en-GB')} ${caughtUp.changed === 1 ? 'record your systems mark' : 'records your systems mark'} as added or changed since ${caughtUp.changed === 1 ? 'was' : 'were'} read live`}. ` +
            'A record deleted since the copy is still counted.'
          : `Read from the copy kept in your Silo, as your systems stood at ${oldest.slice(0, 16).replace('T', ' ')} UTC. Anything changed since is not in it.`,
      detail: {
        copied: result.asOf.map((one) => one.connectionId),
        asOf: oldest,
        ...(result.asAt ? { asAt: result.asAt } : {}),
        ...(caughtUp ? { freshAt: caughtUp.at, changed: caughtUp.changed } : {}),
      },
    });
  }

  /*
   * TWO FIELDS SILO HAD LEARNED WERE ONE, AND ARE NOT ANY MORE. Every record
   * disagreeing on a field is alarming until it is explained: the systems did
   * not fall out, Silo was reading two things together and has stopped.
   */
  for (const gone of result.unlearned ?? []) {
    flags.push({
      kind: 'disagreement',
      subject: gone.fieldPath,
      summary:
        `${gone.sourceField} was being read as ${gone.fieldPath}, and they now agree on only ${gone.agreed} of ` +
        `${gone.compared} records. From the next question they are separate fields again.`,
      detail: { connections: [gone.connectionId], records: gone.compared - gone.agreed },
    });
  }

  /*
   * A FILTER SOME SYSTEM COULD NOT APPLY. The answer is whole for the systems
   * that hold the field and says nothing about a record held only in one that
   * does not — which is incompleteness, of the kind a reader can weigh, and
   * used to be a refusal that gave them nothing to weigh at all.
   */
  for (const gap of result.unheld ?? []) {
    /*
     * COUNTED AND NOUGHT IS NOT A FLAG. Every record those systems hold is also
     * held somewhere that could be asked, so nothing was left out and there is
     * nothing for a reader to weigh.
     */
    if (gap.unchecked === 0) continue;

    const systems = gap.connectionIds.length;
    const where = systems === 1 ? 'a system that does' : `${systems} systems that do`;
    flags.push({
      kind: 'incompleteness',
      subject: gap.fieldPath,
      summary:
        gap.unchecked === undefined
          ? `${systems} ${systems === 1 ? 'system does' : 'systems do'} not hold ${gap.fieldPath}, ` +
            `so ${systems === 1 ? 'a record held only there was' : 'records held only there were'} not checked.`
          : `${gap.unchecked} ${gap.unchecked === 1 ? 'record is' : 'records are'} held only in ${where} not hold ` +
            `${gap.fieldPath}, and ${gap.unchecked === 1 ? 'was' : 'were'} not checked.`,
      /* Its own key, because `connections` on an incompleteness means systems
         a record could not be COMPARED against — a different thing to be told. */
      detail: { unheldIn: gap.connectionIds, ...(gap.unchecked === undefined ? {} : { unchecked: gap.unchecked }) },
    });
  }

  for (const [fieldPath, held] of Object.entries(coverage)) {
    if (!held || held.empty === 0) continue;
    flags.push({
      kind: 'incompleteness',
      subject: fieldPath,
      summary:
        `${held.empty} ${held.empty === 1 ? 'record holds' : 'records hold'} no value ` +
        `for ${fieldPath} in any system.`,
      /* Absence rather than conflict, which the merge layer counts separately
         for exactly this reason. */
      detail: { missing: held.empty, counted: held.counted },
    });
  }

  return flags;
}
