import type { ManifestObject } from '../../schemas/manifest.schema';

/**
 * §2.2 — derivation. Proposing what the customer's data MEANS by reading the
 * schemas they already have.
 *
 * NOTHING PREDEFINED, AND NOTHING GUESSED FROM A DOMAIN. §2.1 — there is no
 * list of known concepts in this file and there must never be one. What is here
 * is a comparison: two objects in two different systems, and the arithmetic of
 * how much they look like the same thing. "Invoice" is never a word this file
 * knows; it is a name two schemas happen to agree on, which is a fact about the
 * customer rather than about the product.
 *
 * IT PROPOSES; IT NEVER CREATES. §2.4 — everything returned here is a filled-in
 * form. `concept.service.confirm` is the only thing that makes a concept, it
 * requires a person, and `concepts.confirmed_by` is NOT NULL so the database
 * agrees.
 *
 * ── The four inputs §2.2 names ──────────────────────────────────────────────
 *
 * Schema introspection, field overlap, value matching, structural position.
 * They are weighted below rather than combined into one similarity number, and
 * every one of them is reported separately in the evidence — because the
 * confirmation screen has to answer "why do you think these are the same?" with
 * something a person can check, not with 0.82.
 *
 * FOREIGN KEYS ARE THE HIGHEST-VALUE INPUT, which §2.2 says outright and the
 * manifest schema repeats over `relationships`. A field called `customer_id` is
 * a naming convention. A declared foreign key from `invoices` to `customers` is
 * the customer's own data model, written down by whoever built the system, and
 * it is the reason catalogue introspection is worth more than reading names.
 *
 * ── Values are compared and never kept ─────────────────────────────────────
 *
 * `samples` is a function argument. It exists for the length of the call, the
 * ratio survives it, and the values do not — which is what makes value matching
 * possible without a place to store data. `concept_proposals.evidence` gets
 * "412 of 500 sampled identifiers appear on both sides"; it never gets one of
 * them. The absence of a column is the guarantee; this comment is only the
 * reason for it.
 */

/* One definition, in the model. This file had a structurally identical copy. */
import type { ContributingObject } from '../../models/concept.model';
export type { ContributingObject };

export type PairEvidence = {
  a: { connectionId: string; objectName: string };
  b: { connectionId: string; objectName: string };
  /** Canonical names, so the reader sees what was actually compared. */
  sharedFields: string[];
  fieldOverlap: number;
  sharedIdentity: string[];
  /** Objects both sides point at, and objects that point at both sides. */
  sharedReferences: string[];
  sharedReferrers: string[];
  nameAgreement: number;
  /**
   * The best measured pairing, as a ratio somebody can check.
   *
   * `field` NAMES BOTH SIDES WHEN THEY DIFFER, because a cross-named match is
   * the interesting case and "412 of 500 matched on customer_ref" hides which
   * column on the other system it matched against.
   *
   * Null when nothing was profiled, which caps confidence — see `coverage`.
   */
  valueOverlap: { field: string; sampled: number; matched: number } | null;
  /**
   * Every signal that could be measured, by name.
   *
   * REPORTED SEPARATELY RATHER THAN ROLLED UP, which is §2.2's own requirement:
   * the confirmation screen has to answer "why do you think these are the same"
   * with something a person can check, not with 0.82.
   */
  signals: Partial<Record<Signal, number>>;
  /**
   * How much of the available evidence was actually available.
   *
   * A pair judged on half the signals cannot score as high as one judged on all
   * of them — the honest ceiling the old "0.85 without samples" rule drew,
   * generalised from values to every signal.
   */
  coverage: number;
  /**
   * The admitted field pairings, best first.
   *
   * ORDERED, AND POSITIONAL. `keyOf` joins match keys in order, so slot zero on
   * one side is compared against slot zero on the other — which is what lets a
   * concept resolve `acct_no` against `customer_ref` at all.
   */
  keys: Array<{ a: string; b: string }>;
  score: number;
};

export type Proposal = {
  proposedName: string;
  contributing: ContributingObject[];
  evidence: { pairs: PairEvidence[]; sampled: boolean };
  confidence: number;
};

export type ConnectionSchema = {
  connectionId: string;
  objects: ManifestObject[];
  /**
   * Object name → field name → identifier values read from the source.
   *
   * OPTIONAL, AND ITS ABSENCE IS VISIBLE RATHER THAN SILENT. A derivation run
   * with no samples cannot reach full confidence and says so in the evidence,
   * because "these schemas look alike" and "these schemas look alike and the
   * same identifiers appear in both" are different claims.
   */
  profiles?: Record<string, ObjectProfile>;
  /**
   * What the same fields measured on a PREVIOUS run, for stability.
   *
   * COUNTS ONLY, AND THAT IS THE WHOLE POINT. A sketch of the distinct values —
   * a minhash, a bloom filter — would answer the same question and would be a
   * one-way function OF CUSTOMER VALUES sitting in our database. Stability is
   * whether a field's shape holds still, and a shape is three ratios.
   */
  priors?: Record<string, Record<string, PriorProfile>>;
};

/** One field, read once, described. The values are arguments; they do not survive. */
export type FieldProfile = {
  /** Rows the page returned, including those whose value was absent. */
  rows: number;
  /** The page came back full, so the population is larger than `rows`. */
  saturated: boolean;
  /** Rows where the field held nothing. */
  absent: number;
  /**
   * Non-absent values from that page, as the source spelled them.
   *
   * AN ARGUMENT, NEVER A FIELD ON ANYTHING STORED. The ratios survive this
   * call; the values do not, which is what makes value matching possible in a
   * product that claims to keep nothing.
   */
  values: string[];
};

export type ObjectProfile = Record<string, FieldProfile>;

/** The same field, last time it was looked at. Three numbers and nothing else. */
export type PriorProfile = {
  distinctRatio: number;
  absentRatio: number;
  rows: number;
};

/**
 * WHAT EACH INPUT IS WORTH.
 *
 * FIELD OVERLAP LEADS BUT DOES NOT DECIDE, because two tables of addresses
 * overlap almost perfectly and are not the same concept. Identity and structure
 * are what separate them: the same identifiers, and the same position in the
 * schema graph.
 *
 * THE OBJECT'S OWN NAME IS WORTH ALMOST NOTHING, deliberately. It is the input a
 * person would reach for first and the one most often wrong — `tbl_cust_m` and
 * `Account` are routinely the same thing, and `orders` in two systems routinely
 * are not. It breaks ties and nothing more.
 *
 * THE WEIGHTS SUM TO ONE ONLY WHEN VALUES WERE SAMPLED. Without them the best
 * achievable score is 0.85, which is the honest ceiling for a proposal made
 * without looking at a single identifier.
 */
const WEIGHTS = {
  /*
   * VALUES LEAD, AND NOTHING ELSE COMES CLOSE. Two columns sharing hundreds of
   * identifiers are the same field whatever they are called; two sharing none
   * are unrelated however alike the names. The previous arrangement had this
   * exactly inverted — names chose which fields were compared, and values only
   * ever confirmed the choice.
   */
  valueOverlap: 0.34,
  /* Does each side behave like a key at all. A `status` column overlaps
     perfectly between two systems and identifies nothing. */
  distinctness: 0.13,
  /* Same position in the schema graph: pointing at the same things, and being
     pointed at by the same things. */
  structure: 0.12,
  /* How heavily each object is referenced. Separates a core entity from a join
     table that happens to carry the same keys. */
  referenceDensity: 0.1,
  /* Field names agreeing. Corroboration now, never selection. */
  fieldOverlap: 0.11,
  /* Comparable population sizes, where both were actually counted. */
  cardinality: 0.07,
  /* Whether the field's shape held still since the last run. */
  stability: 0.08,
  /* Declared identifiers agreeing. */
  identity: 0.04,
  /* THE OBJECT'S OWN NAME IS WORTH ALMOST NOTHING, deliberately, and now the
     arithmetic says so as loudly as the comment always did. */
  name: 0.01,
} as const;

type Signal = keyof typeof WEIGHTS;

/**
 * How much a shared value is worth, by how rare it is.
 *
 * ── The problem this exists for ────────────────────────────────────────────
 *
 * Two unrelated tables both keyed 1..1000 share every value. Distinctness does
 * not separate them — both are perfectly distinct. Cardinality does not — both
 * are a thousand. A value-first comparison without this merges half an estate
 * on its first run, and does it confidently.
 *
 * ── The standard answer, and it is standard ────────────────────────────────
 *
 * Record linkage has weighted agreement by rarity since Fellegi and Sunter in
 * 1969, and every serious implementation since does the same thing — Splink
 * calls it term frequency adjustment, for exactly this reason: agreeing on a
 * common surname is not the evidence that agreeing on a rare one is.
 *
 * PER VALUE, NOT PER FIELD. A single entropy figure for a column averages away
 * the normal case, which is a field where most values are rare and a handful
 * are common. `1` and a UUID can sit in the same column and they are not worth
 * the same.
 *
 * ── What the corpus is ─────────────────────────────────────────────────────
 *
 * Every profiled field in the run. A value in forty of them is a serial number
 * the whole estate uses; a value in exactly two is an identifier those two
 * systems share. That is computable from what was already fetched, and it
 * needs no reference data and no knowledge of any domain.
 */
export type Rarity = (value: string) => number;

export function rarityOf(profiles: Iterable<FieldProfile>): Rarity {
  let fields = 0;
  const seenIn = new Map<string, number>();

  for (const profile of profiles) {
    fields += 1;
    for (const value of new Set(profile.values.map(normalise))) {
      seenIn.set(value, (seenIn.get(value) ?? 0) + 1);
    }
  }

  /*
   * TWO FIELDS ARE NO CORPUS. A value shared by the only two fields there are
   * cannot be told apart from a value shared by two fields out of forty, and
   * pretending otherwise would punish every small estate. Saying so is better.
   */
  if (fields <= 2) return () => 1;

  /*
   * SCALED AGAINST THE RAREST A SHARED VALUE CAN POSSIBLY BE, which is two: it
   * takes two fields to share anything. So appearing in exactly two scores 1,
   * and appearing in every profiled field in the estate scores 0 — a value
   * everything holds distinguishes nothing.
   */
  const span = Math.log(fields / 2);

  return (value: string) => {
    const seen = Math.min(fields, Math.max(2, seenIn.get(value) ?? 2));
    return span === 0 ? 1 : Math.min(1, Math.max(0, Math.log(fields / seen) / span));
  };
}

/** The resolver's normalisation, so a ratio here means what a match means later. */
const normalise = (value: string) => value.trim().toLowerCase();

/**
 * Below this, it is not offered.
 *
 * A THRESHOLD, NOT A FILTER ON A RANKED LIST. Showing the best ten proposals
 * regardless of quality trains people to confirm whatever is at the top; a
 * screen that is empty when nothing resembles anything else is telling the
 * truth about two unrelated systems.
 */
const PROPOSE_AT = 0.45;

/**
 * Field names that a schema uses to mean "this identifies the record".
 *
 * A CONVENTION LIST, USED ONLY TO PROPOSE. It never decides anything: it widens
 * what may become a match key beyond the manifest's declared identifier, and a
 * person confirms the result. Resolution afterwards is exact against the agreed
 * keys (§2.6) and this list plays no part in it.
 */
const IDENTITY_SUFFIXES = [
  'id',
  'code',
  'ref',
  'reference',
  'number',
  'no',
  'key',
  'email',
  'sku',
  'isbn',
  'vat',
  'uuid',
  'guid',
];

/* ── Names ───────────────────────────────────────────────────────────────── */

function tokens(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((token) => token.toLowerCase());
}

/**
 * CRUDE, AND IT ONLY HAS TO BE WRONG THE SAME WAY ON BOTH SIDES. `status`
 * becomes `statu` here, which is not English and does not matter: the point is
 * that `invoices` and `invoice` land on the same string, and a rule applied
 * identically to both sides of a comparison cannot make two things match that
 * would not have matched anyway.
 */
function singular(word: string): string {
  if (word.length > 4 && word.endsWith('ies')) return `${word.slice(0, -3)}y`;
  if (word.length > 4 && /(s|x|z|ch|sh)es$/.test(word)) return word.slice(0, -2);
  /*
   * `status` IS NOT THE PLURAL OF `statu`. This is also the name a person is
   * shown and a model is offered, so the commonest words that merely end in an
   * s — status, bonus, basis, analysis — are left as they are.
   */
  if (word.length > 3 && word.endsWith('s') && !word.endsWith('ss') && !/(us|is)$/.test(word)) return word.slice(0, -1);
  return word;
}

function canonicalObject(name: string): string {
  return tokens(name).map(singular).join('_');
}

/**
 * A field name with its own object's name taken out of it.
 *
 * `invoices.invoice_number` AND `billing_docs.number` ARE THE SAME FIELD, and
 * an overlap measure that cannot see that reports two ERPs as unrelated. The
 * prefix is a convention of the table it lives in and carries no information
 * once you already know which table you are looking at.
 *
 * A field that is ONLY the object's name keeps it, because dropping it would
 * leave nothing to compare.
 */
function canonicalField(field: string, objectName: string): string {
  const own = new Set(tokens(objectName).map(singular));
  const parts = tokens(field).map(singular);
  const kept = parts.filter((part) => !own.has(part));
  return (kept.length > 0 ? kept : parts).join('_');
}

function looksLikeIdentity(canonical: string): boolean {
  const parts = canonical.split('_');
  const last = parts[parts.length - 1] ?? '';
  return IDENTITY_SUFFIXES.includes(last) || IDENTITY_SUFFIXES.includes(canonical);
}

/* ── Comparison ──────────────────────────────────────────────────────────── */

type Described = {
  connectionId: string;
  object: ManifestObject;
  canonicalName: string;
  /** Canonical field name → the field's real name on this object. */
  fields: Map<string, string>;
  /** Canonical names of the fields that identify a record here. */
  identity: Set<string>;
  /** Canonical names of objects this one points at. */
  references: Set<string>;
  /** Canonical names of objects that point at this one. */
  referrers: Set<string>;
  /** Canonical field name -> the declared type, for pruning pairings. */
  types: Map<string, string>;
  profile: ObjectProfile;
  priors: Record<string, PriorProfile>;
};

function describe(connection: ConnectionSchema): Described[] {
  const referrers = new Map<string, Set<string>>();

  for (const object of connection.objects) {
    for (const link of object.relationships) {
      const target = canonicalObject(link.targetObject);
      const into = referrers.get(target) ?? new Set<string>();
      into.add(canonicalObject(object.name));
      referrers.set(target, into);
    }
  }

  return connection.objects.map((object) => {
    const fields = new Map<string, string>();
    const types = new Map<string, string>();
    for (const field of object.fields) {
      const canonical = canonicalField(field.name, object.name);
      /* First declaration wins, so the order of a manifest's fields decides
         rather than whichever collision happened to be written last. */
      if (!fields.has(canonical)) {
        fields.set(canonical, field.name);
        types.set(canonical, field.type);
      }
    }

    const identity = new Set(
      object.identifier.map((field) => canonicalField(field, object.name)),
    );

    const canonicalName = canonicalObject(object.name);

    return {
      connectionId: connection.connectionId,
      object,
      canonicalName,
      fields,
      identity,
      references: new Set(object.relationships.map((link) => canonicalObject(link.targetObject))),
      referrers: referrers.get(canonicalName) ?? new Set<string>(),
      types,
      profile: connection.profiles?.[object.name] ?? {},
      priors: connection.priors?.[object.name] ?? {},
    };
  });
}

function overlap(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  const shared = [...a].filter((value) => b.has(value)).length;
  return shared / new Set([...a, ...b]).size;
}

function shared(a: Iterable<string>, b: Set<string>): string[] {
  return [...new Set([...a].filter((value) => b.has(value)))].sort();
}

/**
 * WHICH FIELD PAIRINGS COULD RESOLVE THESE TWO AGAINST EACH OTHER.
 *
 * ── Names no longer select anything ────────────────────────────────────────
 *
 * This used to require a shared canonical field name, which meant
 * `customers.acct_no` and `clients.customer_ref` were never even compared —
 * whatever their values said. A pairing is now any two fields that could carry
 * the same identifier, and the values decide which one does.
 *
 * ── Pruned before any value is looked at, because the cross product is real ─
 *
 * Thirty fields against thirty is nine hundred comparisons per object pair, and
 * that multiplies across every pair of objects in the estate. Two filters cost
 * nothing and remove nearly all of it:
 *
 * TYPE, because a number and a date cannot be the same identifier.
 *
 * DISTINCTNESS, because a field that repeats cannot carry identity whatever it
 * overlaps with. A `status` column matching perfectly between two systems is
 * five values agreeing with five values, and joining on it would resolve every
 * open invoice to every other. `keyOf` will not tolerate it downstream and
 * neither should this.
 *
 * A field NOBODY PROFILED is admitted on name agreement alone, which is the old
 * behaviour kept for the case where sampling was refused or the source was
 * down — reported as unmeasured rather than passed off as agreement.
 */
type Pairing = {
  /** Canonical names, for the reader. */
  a: string;
  b: string;
  /** Containment weighted by how rare the agreement was. Scores the pair. */
  overlap: number | null;
  /** Plain containment, unweighted. Decides the veto, and only the veto. */
  raw: number | null;
  /** How many distinct values actually appeared on both sides. */
  matched: number;
  /**
   * Both pages came back full, so each side is a WINDOW rather than a
   * population — and two windows of a five-million-row table can share nothing
   * while the tables match perfectly.
   */
  windowed: boolean;
  /** Distinct/present, per side, where profiled. */
  distinctness: number | null;
  /** How much was actually offered — what makes a zero meaningful or not. */
  offered: number;
};

/** Below this a field repeats too much to be anybody's identifier. */
const KEY_DISTINCTNESS = 0.95;

/** A zero is only evidence of disagreement once this many values were compared. */
const COMPETENT_SAMPLE = 200;

/**
 * What a pair can reach on no evidence at all.
 *
 * A PROPOSAL FROM STRUCTURE ALONE IS A REAL PROPOSAL AND A WEAK ONE. It is also
 * how the service decides which objects are worth the cost of profiling, so it
 * cannot be scored to nothing.
 */
const UNMEASURED_CEILING = 0.62;

const present = (profile: FieldProfile) => Math.max(0, profile.rows - profile.absent);

const distinctnessOf = (profile: FieldProfile): number | null => {
  const seen = present(profile);
  if (seen === 0) return null;
  return new Set(profile.values.map(normalise)).size / seen;
};

/**
 * Weighted containment: how much of A's identity appears in B, by rarity.
 *
 * THE DENOMINATOR IS THE SIDE THAT WAS COUNTED, as it always was. Dividing by
 * the smaller side overstates agreement whenever the two differ in size.
 */
function containment(
  a: FieldProfile,
  b: FieldProfile,
  rarity: Rarity,
): { raw: number; weighted: number; matched: number } {
  const mine = new Set(a.values.map(normalise));
  const theirs = new Set(b.values.map(normalise));
  if (mine.size === 0 || theirs.size === 0) return { raw: 0, weighted: 0, matched: 0 };

  let matched = 0;
  let worth = 0;
  for (const value of mine) {
    if (!theirs.has(value)) continue;
    matched += 1;
    worth += rarity(value);
  }

  /*
   * ── Two numbers, because they answer two different questions ──────────────
   *
   * RAW is "did these two share anything at all", and it is what the veto
   * reads. Rarity must not reach that decision: a pair agreeing on worthless
   * values has not DISAGREED, and refusing it would be refusing a pair for the
   * shape of its key space rather than for the evidence.
   *
   * WEIGHTED is what the score reads, and it is containment multiplied by how
   * much the agreement was worth. A ratio alone cannot carry the discount —
   * weighting numerator and denominator alike simply cancels, which is the trap
   * this shape exists to avoid: 400 of 400 sequential integers and 400 of 400
   * unique references both come to 1.
   */
  /*
   * ── SYMMETRIC, BECAUSE WHICH SIDE IS "A" IS AN ACCIDENT ──────────────────
   *
   * Dividing by A's count alone made the score depend on which connection the
   * database returned first: the same estate scored 0.86 or 0.78 according to
   * `ORDER BY c.name`, and those straddle the threshold a proposal is offered
   * at. Two runs over unchanged data disagreed about whether a concept exists.
   *
   * Over the SMALLER side, so a small system whose every record appears in a
   * large one reads as the strong match it is. The overstatement the original
   * comment warned about — three values against a hundred reporting perfection
   * — is held off by `COMPETENT_SAMPLE` and the distinctness gate rather than
   * by an asymmetric denominator that also broke determinism.
   */
  const raw = matched / Math.min(mine.size, theirs.size);
  const meanWorth = matched === 0 ? 0 : worth / matched;

  return { raw, weighted: raw * meanWorth, matched };
}

function pairings(a: Described, b: Described, rarity: Rarity): Pairing[] {
  const found: Pairing[] = [];

  for (const [canonA, nameA] of a.fields) {
    for (const [canonB, nameB] of b.fields) {
      const sameName = canonA === canonB;

      /* A type mismatch is not a near miss; it is a different kind of thing. */
      const typeA = a.types.get(canonA);
      const typeB = b.types.get(canonB);
      if (typeA && typeB && typeA !== typeB) continue;

      const profileA = a.profile[nameA];
      const profileB = b.profile[nameB];

      if (!profileA || !profileB) {
        /* Unmeasured. Admitted only where the names already agree and one side
           treats it as identity — the old rule, kept for the unsampled case. */
        if (!sameName) continue;
        if (!a.identity.has(canonA) && !b.identity.has(canonB) && !looksLikeIdentity(canonA)) {
          continue;
        }
        found.push({
          a: canonA,
          b: canonB,
          overlap: null,
          raw: null,
          matched: 0,
          windowed: false,
          distinctness: null,
          offered: 0,
        });
        continue;
      }

      const dA = distinctnessOf(profileA);
      const dB = distinctnessOf(profileB);
      if (dA === null || dB === null) continue;

      /* A REPEATING FIELD IS NOT A KEY, whatever it overlaps with. */
      if (dA < KEY_DISTINCTNESS || dB < KEY_DISTINCTNESS) continue;

      const agreement = containment(profileA, profileB, rarity);

      found.push({
        a: canonA,
        b: canonB,
        overlap: agreement.weighted,
        raw: agreement.raw,
        matched: agreement.matched,
        windowed: profileA.saturated && profileB.saturated,
        distinctness: Math.min(dA, dB),
        offered: Math.min(
          new Set(profileA.values.map(normalise)).size,
          new Set(profileB.values.map(normalise)).size,
        ),
      });
    }
  }

  /*
   * BEST FIRST, AND DETERMINISTIC. Overlap decides; a declared identifier wins
   * a tie, then name agreement, then the names themselves so a re-run cannot
   * reorder. §2.5 orders match keys because the first that matches decides.
   */
  const rank = (p: Pairing) =>
    (a.identity.has(p.a) || b.identity.has(p.b) ? 2 : 0) + (p.a === p.b ? 1 : 0);

  return found.sort(
    (x, y) =>
      (y.overlap ?? -1) - (x.overlap ?? -1) ||
      rank(y) - rank(x) ||
      x.a.localeCompare(y.a) ||
      x.b.localeCompare(y.b),
  );
}

/**
 * Was the measurement CAPABLE of finding an overlap it did not find?
 *
 * ── The guard that keeps the veto honest ───────────────────────────────────
 *
 * Zero overlap between two systems holding the same concept is a real and
 * ordinary situation: one holds the UK book and the other the US book, and
 * neither sample contains a single one of the other's identifiers. That is a
 * genuine concept with no measured agreement, and vetoing it would refuse the
 * customer a concept that exists.
 *
 * So a zero only counts against a pair when enough was compared for the
 * absence to mean something — and when the two sides are comparable at all.
 * Short of that the pair is DOWNGRADED HARD rather than refused: the evidence
 * says nothing was found, and nothing found is not the same as nothing there.
 */
const competent = (pairing: Pairing) =>
  pairing.overlap !== null &&
  pairing.offered >= COMPETENT_SAMPLE &&
  /*
   * AND AT LEAST ONE SIDE WAS SEEN WHOLE. If both pages came back full, each is
   * a window onto a larger table — and two windows of a five-million-row
   * invoice table, ordered by different keys or simply starting in different
   * places, can share nothing at all while the tables match perfectly. A zero
   * there is a fact about the sampling, not about the data, and vetoing on it
   * refused real concepts outright.
   */
  !pairing.windowed;

/**
 * Which pairings become the concept's match keys.
 *
 * ── One field per side, and that is not a detail ───────────────────────────
 *
 * `keyOf` joins match keys IN ORDER, so slot zero on one side is compared
 * against slot zero on the other. The first version of this exported the whole
 * admitted cross-product and let `assemble` build a `Map` from it — and a Map
 * keyed on a relation that is not a function silently keeps the LAST entry,
 * which, since the list is sorted best-first, was the WORST pairing.
 *
 * Executed, that produced `['invoice_number', 'order_ref']` against
 * `['OrderRef', 'OrderRef']` for the same concept: slot zero matched an invoice
 * number against an order reference, the same field filled two slots on one
 * side, and `assertResolvable` confirmed it because it only checks length.
 * Every row resolved to nothing, for a concept offered at 0.89.
 *
 * ── A pairing that agreed on nothing is not a key ──────────────────────────
 *
 * `pairings` admits any type-compatible pair of near-unique fields, because it
 * has to look at them before it can know. A key is a stricter thing: `keyOf`
 * requires EVERY slot to match, so one junk slot means nothing resolves at all.
 * A measured pairing that shared no value is exactly that junk.
 */
function keysFrom(admitted: readonly Pairing[]): Array<{ a: string; b: string }> {
  const takenA = new Set<string>();
  const takenB = new Set<string>();
  const chosen: Array<{ a: string; b: string }> = [];

  /* `admitted` arrives best-first, so first-wins is best-wins. */
  for (const pairing of admitted) {
    if (takenA.has(pairing.a) || takenB.has(pairing.b)) continue;

    /*
     * A ZERO ONLY DISQUALIFIES A KEY WHERE IT MEANS SOMETHING — the same guard
     * the veto uses, and for the same reason. Enough was compared and nothing
     * agreed: that field pair can only make resolution stricter and never make
     * it succeed. Twelve values against twelve from the other side of a
     * disjoint estate is not evidence of anything, and dropping the key there
     * would refuse a real concept by leaving it nothing to match on.
     */
    if (competent(pairing) && pairing.raw === 0) continue;

    chosen.push({ a: pairing.a, b: pairing.b });
    takenA.add(pairing.a);
    takenB.add(pairing.b);

    /*
     * THREE IS ENOUGH AND MORE IS WORSE. Every extra slot is another field that
     * must agree for two rows to resolve, so a long compound key does not match
     * more carefully — it matches less often, and the rows it drops are silent.
     */
    if (chosen.length === 3) break;
  }

  return chosen;
}

function comparePair(a: Described, b: Described, rarity: Rarity): PairEvidence | null {
  const admitted = pairings(a, b, rarity);

  /*
   * NO WAY TO RESOLVE THEM, NO PROPOSAL, WHATEVER ELSE AGREES. A concept whose
   * objects cannot be matched against each other is a name with nothing behind
   * it — `concept_objects.match_keys` refuses an empty array and
   * `assertResolvable` refuses it again, so offering one would be offering a
   * form that cannot be submitted.
   */
  if (admitted.length === 0) return null;

  const measured = admitted.filter((pairing) => pairing.overlap !== null);
  const best = measured[0] ?? null;

  /*
   * ── THE VETO, AND ITS GUARD ───────────────────────────────────────────────
   *
   * Two objects that share not one identifier out of hundreds compared are not
   * the same thing, however alike their names, their fields and their shape.
   * That is the whole instruction and it is refused outright.
   *
   * But only where the measurement could have found something. Two systems
   * holding disjoint slices of one concept — the UK book and the US book —
   * genuinely share no identifiers, and refusing that pair would deny a
   * customer a concept that exists. So the veto needs EVERY measured pairing to
   * have been competent and to have found nothing.
   */
  if (measured.length > 0 && measured.every((p) => competent(p) && p.raw === 0)) return null;

  const signals = new Map<Signal, number>();

  if (best) signals.set('valueOverlap', best.overlap!);
  if (best?.distinctness != null) signals.set('distinctness', best.distinctness);

  signals.set('fieldOverlap', overlap(new Set(a.fields.keys()), new Set(b.fields.keys())));

  const sharedIdentity = shared(a.identity, b.identity);
  if (a.identity.size > 0 && b.identity.size > 0) {
    signals.set(
      'identity',
      sharedIdentity.length / Math.max(a.identity.size, b.identity.size),
    );
  }

  /*
   * STRUCTURE IS BOTH DIRECTIONS. Two objects pointing at the same things are
   * alike; two pointed at by the same things are alike in a way that survives
   * one system denormalising where the other did not.
   */
  const anyStructure =
    a.references.size + a.referrers.size + b.references.size + b.referrers.size > 0;
  if (anyStructure) {
    signals.set(
      'structure',
      Math.max(overlap(a.references, b.references), overlap(a.referrers, b.referrers)),
    );

    /*
     * REFERENCE DENSITY IS POSITION BY SHAPE rather than by neighbour. An
     * object six things point at and one nothing points at occupy different
     * places in a model even when their columns match — which is how a core
     * entity is told from the join table that carries its keys.
     */
    const density = (x: Described, y: Described, pick: (d: Described) => Set<string>) =>
      (1 + Math.min(pick(x).size, pick(y).size)) / (1 + Math.max(pick(x).size, pick(y).size));

    signals.set(
      'referenceDensity',
      (density(a, b, (d) => d.references) + density(a, b, (d) => d.referrers)) / 2,
    );
  }

  /*
   * CARDINALITY ONLY WHERE BOTH WERE ACTUALLY COUNTED. A page that came back
   * full says "at least this many", and a ratio between a number and a lower
   * bound is not a ratio.
   */
  const countA = best ? a.profile[a.fields.get(best.a)!] : undefined;
  const countB = best ? b.profile[b.fields.get(best.b)!] : undefined;
  if (countA && countB && !countA.saturated && !countB.saturated) {
    const [low, high] = [present(countA), present(countB)].sort((x, y) => x - y);
    if (high! > 0) signals.set('cardinality', low! / high!);
  }

  /*
   * STABILITY IS DRIFT, AND IT NEEDS TWO OBSERVATIONS. On a first run there is
   * nothing to compare against, so it is ABSENT and renormalises away rather
   * than handing every pair a free score for having been looked at once.
   */
  const drift = stabilityOf(a, b, best);
  if (drift !== null) signals.set('stability', drift);

  const nameAgreement = a.canonicalName === b.canonicalName ? 1 : 0;
  signals.set('name', nameAgreement);

  /*
   * A WEIGHTED MEAN OVER THE SIGNALS THAT EXIST, renormalised across exactly
   * those. Dividing by the full weight instead would put every pair measured
   * with a missing signal below every pair without one — ranking proposals by
   * how much the system happened to be able to look at.
   *
   * THE CEILING IS THE COVERAGE. A pair judged on half the signals cannot reach
   * the score of one judged on all of them: `coverage` multiplies the result,
   * which is the same honest ceiling the old 0.85-without-samples rule drew,
   * generalised to every signal rather than just to values.
   */
  let weighted = 0;
  let held = 0;
  for (const [signal, value] of signals) {
    weighted += WEIGHTS[signal] * value;
    held += WEIGHTS[signal];
  }

  /*
   * COVERAGE IS A CEILING RATHER THAN A MULTIPLIER. Multiplying would make a
   * structure-only pass score almost nothing — and that pass is not a
   * degenerate case, it is how the service decides what is worth profiling in
   * the first place. What it must not do is reach the confidence of a pair that
   * was actually measured.
   *
   * This is the old "0.85 without samples" rule, generalised from values to
   * every signal: floor plus the share of the evidence that existed.
   */
  const coverage = held;
  const ceiling = UNMEASURED_CEILING + (1 - UNMEASURED_CEILING) * coverage;
  const score = held === 0 ? 0 : Math.min(weighted / held, ceiling);

  return {
    a: { connectionId: a.connectionId, objectName: a.object.name },
    b: { connectionId: b.connectionId, objectName: b.object.name },
    sharedFields: shared(a.fields.keys(), new Set(b.fields.keys())),
    fieldOverlap: round(signals.get('fieldOverlap') ?? 0),
    sharedIdentity,
    sharedReferences: shared(a.references, b.references),
    sharedReferrers: shared(a.referrers, b.referrers),
    nameAgreement,
    /*
     * THE COUNTS A PERSON CHECKS, NOT THE SCORE RESTATED. This used to multiply
     * the RARITY-WEIGHTED ratio by the offered count, so a pairing where all
     * three hundred values matched could be shown as "0 of 300" whenever those
     * values were common across the estate — the confirmation screen
     * contradicting the proposal it was attached to.
     */
    valueOverlap: best
      ? {
          field: best.a === best.b ? best.a : `${best.a} = ${best.b}`,
          sampled: best.offered,
          matched: best.matched,
        }
      : null,
    signals: Object.fromEntries(
      [...signals].map(([signal, value]) => [signal, round(value)]),
    ) as Partial<Record<Signal, number>>,
    coverage: round(coverage),
    keys: keysFrom(admitted),
    score: round(score),
  };
}

/**
 * How much the two fields' shapes have moved since they were last looked at.
 *
 * ── Three ratios, and deliberately nothing else ────────────────────────────
 *
 * A sketch of the distinct values — a minhash, a bloom filter — would answer a
 * richer question and would be a one-way function OF CUSTOMER VALUES living in
 * our database. This product's claim is that it stores no data, and a hashed
 * identifier is an identifier that has been hashed. Distinctness, absence and
 * size are counts; they are as arguable as a row count, which is to say not at
 * all.
 *
 * A FIELD THAT HOLDS ITS SHAPE IS BEHAVING LIKE A KEY. One whose distinctness
 * collapsed between runs was repurposed, or is being written by something new,
 * and either way the agreement measured last time is not evidence about now.
 */
function stabilityOf(a: Described, b: Described, best: Pairing | null): number | null {
  if (!best) return null;

  const sides: number[] = [];

  for (const [side, canonical] of [
    [a, best.a],
    [b, best.b],
  ] as const) {
    const name = side.fields.get(canonical);
    if (!name) continue;

    const now = side.profile[name];
    const then = side.priors[name];
    if (!now || !then) continue;

    const seen = present(now);
    if (seen === 0) continue;

    const distinctNow = new Set(now.values.map(normalise)).size / seen;
    const absentNow = now.rows === 0 ? 0 : now.absent / now.rows;

    /* A quarter is the tolerance: shapes wobble between samples of different
       pages, and a signal that punished ordinary wobble would only ever
       measure sampling noise. */
    const moved =
      (Math.abs(distinctNow - then.distinctRatio) + Math.abs(absentNow - then.absentRatio)) / 2;

    sides.push(Math.max(0, 1 - Math.min(1, moved / 0.25)));
  }

  if (sides.length === 0) return null;
  return sides.reduce((total, one) => total + one, 0) / sides.length;
}

const round = (value: number) => Math.round(value * 100) / 100;

/* ── Grouping ────────────────────────────────────────────────────────────── */

/**
 * Turn the pairs that scored into concepts.
 *
 * ONE OBJECT PER CONNECTION, which `concept_objects_one_per_connection`
 * enforces and which is right for a better reason than the constraint: an
 * "invoice" that is both `invoices` and `credit_notes` in one system is two
 * concepts wearing one name, and every disagreement it ever reports will be
 * between those two rather than between two systems.
 *
 * GREEDY FROM THE STRONGEST PAIR, NOT TRANSITIVE CLOSURE. Closure chains A–B
 * and B–C into one group even when A and C have nothing in common, which is how
 * a single weak link merges two unrelated concepts. Growing from the best pair
 * and requiring each newcomer to hold up against everything already in the
 * group costs nothing at these sizes and cannot do that.
 */
function group(
  pairs: PairEvidence[],
  described: Map<string, Described>,
  threshold: number,
): Proposal[] {
  const key = (side: { connectionId: string; objectName: string }) =>
    `${side.connectionId}:${side.objectName}`;

  /* Ties broken on the pair's own names, so a re-run orders them identically
     however the connections came back from the database. */
  const name = (pair: PairEvidence) => `${key(pair.a)}|${key(pair.b)}`;
  const ordered = [...pairs].sort((x, y) => y.score - x.score || name(x).localeCompare(name(y)));

  const scores = new Map<string, PairEvidence>();
  for (const pair of ordered) {
    scores.set(`${key(pair.a)}|${key(pair.b)}`, pair);
    scores.set(`${key(pair.b)}|${key(pair.a)}`, pair);
  }

  const taken = new Set<string>();
  const proposals: Proposal[] = [];

  for (const seed of ordered) {
    if (taken.has(key(seed.a)) || taken.has(key(seed.b))) continue;

    const members = [key(seed.a), key(seed.b)];
    const held = new Set([seed.a.connectionId, seed.b.connectionId]);
    const kept: PairEvidence[] = [seed];

    for (const candidate of ordered) {
      for (const side of [candidate.a, candidate.b]) {
        const id = key(side);
        if (members.includes(id) || taken.has(id) || held.has(side.connectionId)) continue;

        /* It has to hold up against EVERY member, not against the one that
           happened to introduce it. */
        const against = members.map((member) => scores.get(`${member}|${id}`));
        if (against.some((pair) => !pair || pair.score < threshold)) continue;

        members.push(id);
        held.add(side.connectionId);
        for (const pair of against) if (pair) kept.push(pair);
      }
    }

    for (const member of members) taken.add(member);

    const objects = members.map((member) => described.get(member)!);
    proposals.push(assemble(objects, kept));
  }

  return proposals;
}

/**
 * THE NAME IS A CONVENIENCE AND THE RENAME IS THE INTERESTING EVENT. Whichever
 * canonical name the members agree on most often, alphabetical on a tie. When
 * somebody types something better, `concepts.origin` records `corrected`, and
 * the rate of that is how anyone tells whether derivation is working.
 */
export function nameFor(
  objects: Array<{ canonicalName: string; fields: Map<string, string> }>,
  templates: readonly ConceptTemplate[] = [],
): string {
  /*
   * ── §2.8 — A RECURRING SHAPE MAY LEND ITS NAME, AND NOTHING ELSE ─────────
   *
   * A proposal carrying an email, a name and a company is better called
   * "person" than `contact_v2`. §2.3 is explicit that this is a naming hint for
   * readability at confirmation — it is not a schema, it constrains nothing,
   * and it has NO EFFECT ON MATCHING. The concept still only exists once
   * somebody confirms it, and renaming is still the interesting event.
   *
   * THE TEMPLATE HOLDS FIELD NAMES AND A NAME. Nothing derived from any
   * customer's records reaches this, which is what keeps §6.5 intact: a shape
   * is not data.
   */
  /* Canonical names, which is what `describe` already normalised them to. */
  const fields = new Set(objects.flatMap((object) => [...object.fields.keys()].map(lower)));

  const matched = templates
    .filter((one) => one.fieldNames.length > 0)
    .map((one) => ({
      name: one.name,
      /* Every field the template names has to be present. A partial match is a
         different shape wearing a borrowed name. */
      covers: one.fieldNames.every((field) => fields.has(lower(field))),
      size: one.fieldNames.length,
    }))
    .filter((one) => one.covers)
    /* The most specific shape wins: `person` over `record`. */
    .sort((a, b) => b.size - a.size || a.name.localeCompare(b.name));

  if (matched[0]) return matched[0].name;

  const counts = new Map<string, number>();
  for (const object of objects) {
    counts.set(object.canonicalName, (counts.get(object.canonicalName) ?? 0) + 1);
  }

  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]![0];
}

const lower = (value: string) => value.trim().toLowerCase();

/**
 * §2.8 — a shape that recurs, kept so a first proposal is not a cold start.
 *
 * A NAME AND FIELD NAMES. Never a schema, never values, never anything derived
 * from a customer's records — which is what makes it the only cross-tenant
 * mechanism §6.5 permits.
 */
export interface ConceptTemplate {
  name: string;
  fieldNames: string[];
}

function assemble(objects: Described[], pairs: PairEvidence[]): Proposal {
  const unique = [...new Map(pairs.map((pair) => [JSON.stringify([pair.a, pair.b]), pair])).values()];

  /*
   * ── MATCH KEYS ARE SLOTS, NOT NAMES ────────────────────────────────────────
   *
   * `keyOf` joins each object's match keys IN ORDER, so slot zero on one side
   * is compared against slot zero on the other. That is what allows a concept
   * to resolve `customers.acct_no` against `clients.customer_ref` at all — and
   * it is why this builds an ordered list of slots rather than an intersection
   * of shared names, which is what used to make cross-named keys impossible.
   *
   * THE FIRST MEMBER ANCHORS THE SLOTS. Every other member has to offer a
   * pairing against the anchor for a slot to survive: a key one sibling cannot
   * fill would resolve that sibling to nothing, which is worse than having one
   * fewer key.
   */
  const anchor = objects[0]!;
  const side = (member: Described) =>
    `${member.connectionId}:${member.object.name}`;

  const pairingFor = (member: Described): Map<string, string> | null => {
    if (member === anchor) return null;

    const evidence = unique.find(
      (pair) =>
        (`${pair.a.connectionId}:${pair.a.objectName}` === side(anchor) &&
          `${pair.b.connectionId}:${pair.b.objectName}` === side(member)) ||
        (`${pair.b.connectionId}:${pair.b.objectName}` === side(anchor) &&
          `${pair.a.connectionId}:${pair.a.objectName}` === side(member)),
    );
    if (!evidence) return new Map();

    const anchorIsA = `${evidence.a.connectionId}:${evidence.a.objectName}` === side(anchor);

    /*
     * Anchor's canonical name -> this member's canonical name.
     *
     * FIRST WINS, EXPLICITLY. `keysFrom` makes the relation injective so there
     * is nothing to collide — and building a Map from a relation that is not a
     * function is what produced the corrupted match keys this guards against,
     * so it is written out rather than left to `new Map`'s last-wins.
     */
    const mapping = new Map<string, string>();
    for (const key of evidence.keys) {
      const [from, to] = anchorIsA ? [key.a, key.b] : [key.b, key.a];
      if (!mapping.has(from)) mapping.set(from, to);
    }
    return mapping;
  };

  const byMember = new Map(objects.map((member) => [side(member), pairingFor(member)]));

  const anchorPairing = unique.find(
    (pair) =>
      `${pair.a.connectionId}:${pair.a.objectName}` === side(anchor) ||
      `${pair.b.connectionId}:${pair.b.objectName}` === side(anchor),
  );

  const anchorSlots = (() => {
    if (!anchorPairing) return [...anchor.identity];
    const anchorIsA =
      `${anchorPairing.a.connectionId}:${anchorPairing.a.objectName}` === side(anchor);
    return anchorPairing.keys.map((key) => (anchorIsA ? key.a : key.b));
  })();

  /* Slots every member can fill, in the anchor's own order. */
  const slots = [...new Set(anchorSlots)].filter((slot) =>
    objects.every((member) => {
      if (member === anchor) return anchor.fields.has(slot);
      const mapping = byMember.get(side(member));
      const theirs = mapping?.get(slot);
      return Boolean(theirs && member.fields.has(theirs));
    }),
  );

  const contributing: ContributingObject[] = objects.map((member) => {
    const mapping = byMember.get(side(member));

    const matchKeys = slots
      .map((slot) => {
        const canonical = member === anchor ? slot : mapping?.get(slot);
        return canonical ? member.fields.get(canonical) : undefined;
      })
      .filter((field): field is string => Boolean(field));

    return {
      connectionId: member.connectionId,
      objectName: member.object.name,
      identifierField: member.object.identifier[0]!,
      matchKeys,
      /*
       * ── EVERY FIELD, NOT JUST THE KEYS ────────────────────────────────────
       *
       * This was computed and thrown away: the comparison holds canonical-to-
       * real for every field of every object it looked at, used it to emit the
       * match keys in each system's own spelling, and discarded the rest. A
       * question phrased in the concept's words had nothing to translate
       * through, so the ontology was reachable only through detectors, which
       * are handed their field names one at a time.
       */
      fieldMap: Object.fromEntries(member.fields),
    };
  });

  const sampled = unique.some((pair) => pair.valueOverlap !== null);

  /*
   * THE WEAKEST LINK IS THE CONFIDENCE. A group is only as good as its least
   * convincing pair, and averaging would let one excellent match carry a third
   * object nobody should have been offered.
   */
  const confidence = round(Math.min(...unique.map((pair) => pair.score)));

  return {
    proposedName: nameFor(objects),
    contributing,
    evidence: { pairs: unique, sampled },
    confidence,
  };
}

/* ── Entry point ─────────────────────────────────────────────────────────── */

/**
 * Propose concepts across a set of connected systems.
 *
 * DETERMINISTIC. The same schemas produce the same proposals in the same order,
 * for the same reason §3.3 requires it of detectors: a derivation that reshuffles
 * between runs cannot be reviewed, because nobody can tell a new proposal from a
 * reordered one.
 *
 * TWO CONNECTIONS IS THE FLOOR, and it is §2.7's floor rather than an
 * implementation limit — one system has nothing to resolve against, so a
 * concept over it could never do anything.
 */
export function derive(
  connections: ConnectionSchema[],
  options: { proposeAt?: number } = {},
): Proposal[] {
  if (connections.length < 2) return [];

  const threshold = options.proposeAt ?? PROPOSE_AT;

  const described = connections.flatMap(describe);

  /*
   * THE CORPUS IS EVERY PROFILED FIELD IN THE RUN, and it has to be built
   * before any pair is compared — a value's rarity is a fact about the estate
   * rather than about the two objects in hand. `1` appearing in forty fields is
   * what makes agreeing on it worth almost nothing.
   */
  const rarity = rarityOf(
    described.flatMap((object) => Object.values(object.profile)),
  );

  const byKey = new Map(
    described.map((object) => [`${object.connectionId}:${object.object.name}`, object]),
  );

  const pairs: PairEvidence[] = [];
  for (let i = 0; i < described.length; i += 1) {
    for (let j = i + 1; j < described.length; j += 1) {
      const a = described[i]!;
      const b = described[j]!;

      /* Two objects in ONE system are not two systems agreeing about anything,
         and a concept cannot hold both of them anyway. */
      if (a.connectionId === b.connectionId) continue;

      const pair = comparePair(a, b, rarity);
      if (pair && pair.score >= threshold) pairs.push(pair);
    }
  }

  return group(pairs, byKey, threshold)
    /*
     * A MEMBER WITH NO MATCH KEY CANNOT BE PART OF ANYTHING. Slot survival is
     * per group, so a third object admitted on structure alone can leave the
     * group with no slot every member fills — and `concept_objects.match_keys`
     * refuses an empty array, so the proposal would appear on screen, read
     * plausibly, and fail the moment somebody pressed confirm.
     */
    .filter((proposal) => proposal.contributing.every((one) => one.matchKeys.length > 0))
    .sort(
    (a, b) => b.confidence - a.confidence || a.proposedName.localeCompare(b.proposedName),
  );
}

/* ── What is worth profiling ─────────────────────────────────────────────── */

/**
 * The fields of one object that could plausibly carry identity.
 *
 * ── Why the engine decides this and not the service ────────────────────────
 *
 * It is the same canonicalisation the comparison uses — `invoice_number` on
 * `invoices` is the field `number` — and a service that re-derived it would be
 * a second implementation of a rule, waiting to disagree with this one about
 * which column to fetch.
 *
 * PROPOSED BY CONVENTION, NEVER DECIDED BY IT. The declared identifier always
 * qualifies; the suffix list widens the shortlist and nothing more. Which of
 * these actually becomes a match key is decided by the profile that comes back,
 * and a name that got a field fetched has no further say.
 *
 * BOUNDED, because this is one column each in a query against somebody's
 * production system, and because the cross product of every field against every
 * other is the cost this whole design has to keep down.
 */
export function fieldsWorthProfiling(object: ManifestObject, limit = 6): string[] {
  const declared = new Set(object.identifier);

  const conventional = object.fields
    .map((field) => field.name)
    .filter((name) => !declared.has(name))
    .filter((name) => looksLikeIdentity(canonicalField(name, object.name)));

  /* Declared first: it is the system's own answer, and §2.5 orders match keys
     because the first that matches decides. */
  return [...object.identifier, ...conventional].slice(0, limit);
}

/* ── Corrections ─────────────────────────────────────────────────────────── */

/**
 * Apply an organisation's corrections to a derived field map.
 *
 * ── What a correction is, and what it is not ───────────────────────────────
 *
 * Canonicalisation is mechanical and right most of the time: `Invoice.TotalAmt`
 * becomes `total` by taking the object's own name out of the field's. It is not
 * right always — a column called `amt_gross` canonicalises to `amt_gross`, and
 * somebody has to say that it is this organisation's `total`.
 *
 * THAT STATEMENT BELONGS TO THE CONNECTION AND NOT TO THE CONCEPT. It is a fact
 * about a vendor's schema, so it holds for every concept over that system —
 * an invoice concept, a credit note concept and a payments concept should not
 * each be told separately. Storing it per concept is how somebody ends up
 * saying the same thing three times and disagreeing with themselves once.
 *
 * AND NOT TO THE CONNECTOR, which is the tempting mistake: a connector is
 * shared between customers, and a correction is one customer's judgement about
 * their own estate. §2.1's rule that nothing is predefined is precisely the
 * rule against letting that judgement shape somebody else's derivation.
 *
 * ── A correction wins, because that is what it is for ──────────────────────
 *
 * The derived name is a guess from a naming convention; the correction is a
 * person. Where both name the same source field, the person decides — and the
 * derived entry is dropped rather than kept alongside, so one column never
 * appears under two names in one map.
 */
export function withCorrections(input: {
  /** Canonical name -> this system's field name, as derived. */
  fieldMap: Record<string, string>;
  /** This system's field name -> what the organisation calls it. */
  corrections: ReadonlyArray<{ sourceField: string; canonicalField: string }>;
}): Record<string, string> {
  const corrected = new Map<string, string>();

  for (const [canonical, sourceField] of Object.entries(input.fieldMap)) {
    corrected.set(canonical, sourceField);
  }

  for (const correction of input.corrections) {
    /*
     * ONLY A COLUMN THIS OBJECT ACTUALLY HAS. An alias belongs to the whole
     * CONNECTION, so most of them are about some other table — and adding one
     * regardless would put `total -> amt` into an invoices map when `amt` is a
     * column on payments. A question naming `total` would then ask invoices for
     * a field it does not have, and the source would refuse a question the
     * ontology said was answerable.
     *
     * The derived map holds every field of the object, so a source field absent
     * from its values is absent from the object.
     */
    const has = [...corrected].some(([, field]) => field === correction.sourceField);
    if (!has) continue;

    /* Drop whatever name the derivation gave this column before adding the
       corrected one, so it cannot appear twice under two names. */
    for (const [canonical, sourceField] of [...corrected]) {
      if (sourceField === correction.sourceField) corrected.delete(canonical);
    }

    corrected.set(correction.canonicalField, correction.sourceField);
  }

  /* Sorted, so a stored map is byte-identical between two runs over unchanged
     schemas and a diff of two concepts is a real difference. */
  return Object.fromEntries([...corrected].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/**
 * §2.3 — a concept's objects as a QUESTION reads them: with what answers have
 * taught about its systems' field names applied.
 *
 * ── What it is for ─────────────────────────────────────────────────────────
 *
 * One system's `town` and another's `city` are two fields by their names and
 * one by what they hold. The model that writes an answer up says so, Silo
 * checks it against the records, and the match is kept per connection (131).
 * This is where it takes effect: both columns are read under one name, so a
 * question about it reaches both systems and their values are compared.
 *
 * ── APPLIED WHEN A QUESTION IS READ, NEVER WRITTEN INTO THE CONCEPT ────────
 *
 * A concept's stored map is what a person confirmed, and every finding about
 * it was computed from that. So this returns a reading of the concept and
 * changes nothing: take a learned match away and the next question sees
 * exactly what was confirmed.
 *
 * ── ADDED, NOT RENAMED ─────────────────────────────────────────────────────
 *
 * The column keeps the name it had and gains the shared one. A saved view, a
 * dashboard or an automation that names `town` was written before anybody knew
 * it was a `city`, and goes on meaning what it meant; `withCorrections` renames
 * because a person correcting a name is replacing it, and this is not that.
 *
 * `superseded` IS WHAT STOPS IT SHOWING TWICE: the old names every system now
 * also reads under another. They still answer when named and are left out of
 * "every field", so nobody is shown one column of one system under two names.
 *
 * ── ONLY ACROSS SYSTEMS ────────────────────────────────────────────────────
 *
 * A match says two systems mean one thing. A concept one system holds has
 * nothing to bring together, and is left in that system's own words.
 */
export function withLearned(input: {
  objects: readonly ContributingObject[];
  learned: ReadonlyArray<{
    connectionId: string;
    objectName: string;
    sourceField: string;
    canonicalField: string;
  }>;
  /**
   * False for a CHANGE, which wants one name per column.
   *
   * A question keeps the old name beside the shared one so that what was saved
   * against it still means what it meant. A change is not saved against a
   * name: it is previewed, approved and written, and a column under two names
   * would be read twice as prior state and could be set twice in one write. So
   * the column is read by the shared name alone, and a change naming the old
   * one is refused as naming a field the concept does not have.
   */
  keepOldNames?: boolean;
}): {
  objects: ContributingObject[];
  superseded: Record<string, string>;
  /** The matches that took effect in this reading, so each can be checked again against what it read. */
  applied: Array<{ connectionId: string; objectName: string; sourceField: string; canonicalField: string }>;
} {
  const unchanged = { objects: [...input.objects], superseded: {}, applied: [] };

  if (new Set(input.objects.map((object) => object.connectionId)).size < 2) return unchanged;
  if (input.learned.length === 0) return unchanged;

  /* Old name -> the name its column gained, per object that gained one. */
  const gained: Array<{ from: string; to: string; column: string }> = [];
  const applied: Array<{ connectionId: string; objectName: string; sourceField: string; canonicalField: string }> = [];

  const objects = input.objects.map((object) => {
    const added: Record<string, string> = {};

    for (const one of input.learned) {
      if (one.connectionId !== object.connectionId || one.objectName !== object.objectName) continue;

      const [from] = Object.entries(object.fieldMap).find(([, column]) => column === one.sourceField) ?? [];
      /* A column this object does not map, or one already read under that name. */
      if (from === undefined || from === one.canonicalField) continue;

      /*
       * NEVER OVER A FIELD THE OBJECT ALREADY HAS. Two columns of one system
       * are two things there, and taking the name from one of them would
       * silently stop it being read.
       */
      if (one.canonicalField in object.fieldMap || one.canonicalField in added) continue;

      added[one.canonicalField] = one.sourceField;
      gained.push({ from, to: one.canonicalField, column: one.sourceField });
      applied.push({ connectionId: object.connectionId, objectName: object.objectName, sourceField: one.sourceField, canonicalField: one.canonicalField });
    }

    if (Object.keys(added).length === 0) return object;

    const renamed = new Set(Object.values(added));
    const kept =
      input.keepOldNames === false
        ? Object.fromEntries(Object.entries(object.fieldMap).filter(([, column]) => !renamed.has(column)))
        : object.fieldMap;

    /* Sorted, as every stored map is, so two readings of one concept are identical. */
    return {
      ...object,
      fieldMap: Object.fromEntries(
        Object.entries({ ...kept, ...added }).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
      ),
    };
  });

  const superseded: Record<string, string> = {};

  for (const { from, to } of gained) {
    /* Superseded only when EVERY system holding the old name reads that column under the new one too. */
    const everywhere = objects
      .filter((object) => from in object.fieldMap)
      .every((object) => object.fieldMap[to] === object.fieldMap[from]);

    if (everywhere) superseded[from] = to;
  }

  return { objects, superseded, applied };
}

/* A match is looked at again once this many records hold both fields. */
const REVIEW_NEEDS = 5;
/* Learned at six in ten; dropped below four. The gap is so a match hovering near the line is not learned and dropped by turns. */
const REVIEW_KEEPS = 0.4;

/**
 * §2.3 (131) — whether a learned field match still holds, from an answer that
 * just read both fields.
 *
 * ── LEARNED ONCE IS NOT TRUE FOR EVER ─────────────────────────────────────
 *
 * A match was kept because two systems' records agreed on the day somebody
 * asked. Systems change: a column is repurposed, an integration starts writing
 * something else into it. Every unfiltered answer that reads the field has both
 * systems' readings for every record in front of it, which is the same evidence
 * the match was learned from, at no cost — so it is looked at again.
 *
 * `drop` WHEN MOST OF THEM NO LONGER AGREE. Reading two different things as
 * one field shows every record as a disagreement and hides both values; the
 * fields go back to being two, which is what they have become.
 *
 * `refresh` OTHERWISE, where the counts have moved, so the evidence shown
 * beside a match is today's.
 */
export function reviewLearned(input: {
  /** What an unfiltered answer just saw: records holding both fields, and how many held the same thing. */
  seen: { compared: number; agreed: number };
  /** What is kept beside the match. */
  kept: { compared: number | null; agreed: number | null };
}): 'drop' | 'refresh' | 'leave' {
  if (input.seen.compared < REVIEW_NEEDS) return 'leave';
  if (input.seen.agreed / input.seen.compared < REVIEW_KEEPS) return 'drop';
  return input.seen.compared === input.kept.compared && input.seen.agreed === input.kept.agreed ? 'leave' : 'refresh';
}

/**
 * The field map for one object, from its manifest alone.
 *
 * ── Why this is exported rather than only computed during a comparison ─────
 *
 * `derive` produces a field map as a by-product of comparing two systems, which
 * is fine for a proposal and useless for a concept somebody assembles by hand.
 * Confirmation through the API had no proposal to take one from, so every
 * concept created that way stored an empty map — and a question naming any
 * field was refused as unknown. The whole query layer was reachable from tests
 * and from nothing else.
 *
 * THE CALLER DOES NOT SUPPLY IT. It is `canonicalField` over the manifest, the
 * same rule the comparison uses, so a hand-made concept and a derived one map
 * the same system the same way — and nobody types a column list.
 */
export function fieldMapFor(object: ManifestObject): Record<string, string> {
  const map = new Map<string, string>();

  for (const field of object.fields) {
    const canonical = canonicalField(field.name, object.name);
    /* First declaration wins, as everywhere else, so a manifest's own order
       decides rather than whichever collision was written last. */
    if (!map.has(canonical)) map.set(canonical, field.name);
  }

  return Object.fromEntries([...map].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}
