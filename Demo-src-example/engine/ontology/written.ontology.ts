/**
 * §2.6 — one thing written two ways.
 *
 * ── WHAT THIS IS FOR ───────────────────────────────────────────────────────
 *
 * A CRM records a country as `UK` and a ledger as `United Kingdom`. Read
 * strictly those disagree, on every customer, and a disputed field carries no
 * value — so an answer about where customers are shows forty disagreements
 * and no countries, about a fact both systems hold and agree on.
 *
 * ── BY HOW IT IS WRITTEN, NEVER BY WHAT IT MEANS ───────────────────────────
 *
 * Nothing here knows what a country is. Two texts are taken for one only when
 * one can be had from the other by how people shorten and punctuate things:
 *
 *   `same`   they differ in case, accents, punctuation or spacing alone;
 *   `short`  one is the other shortened — its initials (`UK`), or each of its
 *            words cut short (`N`, `North`; `Jan`, `January`).
 *
 * `DE` and `Germany` are not that. Neither are `paid` and `overdue`. Those are
 * left as the disagreements they may well be: reading two different facts as
 * one would hide exactly what this product exists to show, and whether two
 * codes mean the same thing is a question about meaning, which is put to the
 * model that writes the answer up and to the reader, not decided here.
 *
 * ── AND ONLY WHERE THE RECORDS DO IT CONSISTENTLY ──────────────────────────
 *
 * A shortening is only believed when the same pair turns up on more than one
 * record and each side keeps to its partner. `CA` beside `Canada` on one
 * record and `California` on the next is not a way of writing anything.
 *
 * NOTHING IS REMEMBERED. It is worked out from each answer's own readings and
 * gone when the answer is: Silo keeps no value from anybody's systems to do it.
 */

/** Case, accents, punctuation and spacing folded away. */
function folded(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

const wordsOf = (text: string) => text.split(/[^\p{L}\p{N}]+/u).filter(Boolean);

/** Whether `short` is `long` shortened: its initials, or each of its words cut short. */
function shortens(short: string, long: string): boolean {
  const few = wordsOf(short);
  const many = wordsOf(long);
  if (few.length === 0 || many.length === 0) return false;

  /* Initials: one run of letters against several words — of every word, or of the capitalised ones ("United States of America"). */
  if (few.length === 1 && many.length >= 2 && few[0]!.length >= 2) {
    const letters = few[0]!.toLowerCase();
    const every = many.map((word) => word[0]!.toLowerCase()).join('');
    const capitalised = many.filter((word) => word[0] !== word[0]!.toLowerCase()).map((word) => word[0]!.toLowerCase()).join('');
    if (letters === every || (capitalised.length >= 2 && letters === capitalised)) return true;
  }

  /* Each word cut short, in order: the same number of words, every one a beginning of its partner, at least one shorter. */
  if (few.length === many.length) {
    const cut = few.map((word, index) => [folded(word), folded(many[index]!)] as const);
    if (cut.every(([a, b]) => a !== '' && b.startsWith(a)) && cut.some(([a, b]) => a.length < b.length)) return true;
  }

  return false;
}

/**
 * Whether two texts are one thing written two ways.
 *
 * `same` needs no second opinion. `short` is a claim about how somebody
 * abbreviates, and callers that can should ask the records to bear it out
 * (`writtenTwoWays`).
 */
export function writtenAlike(a: unknown, b: unknown): 'same' | 'short' | null {
  if (typeof a === 'number' && typeof b === 'number') return a === b ? 'same' : null;
  if ((typeof a !== 'string' && typeof a !== 'number') || (typeof b !== 'string' && typeof b !== 'number')) return null;

  const left = String(a).trim();
  const right = String(b).trim();
  if (left === '' || right === '') return null;

  if (folded(left) === folded(right)) return folded(left) === '' ? null : 'same';
  if (left.length < right.length ? shortens(left, right) : shortens(right, left)) return 'short';
  return null;
}

export type WrittenTwoWays = {
  a: { connectionId: string; value: string };
  b: { connectionId: string; value: string };
  /** How many records hold the one where the other system holds the other. */
  records: number;
  /** The fuller of the two, which both are read as. */
  readsAs: string;
  /** Whether they are one thing by how they are written — and so read as one — or only a pair that keeps turning up. */
  alike: boolean;
};

/* A shortening is believed once the same pair turns up this often… */
const REPEATS = 2;
/* …and each side keeps to its partner this much of the time it disagrees at all. */
const KEEPS_TO = 0.8;

/**
 * The pairs of values two systems keep giving for one field of the same
 * records.
 *
 * ── TWO KINDS OF PAIR, AND ONLY ONE IS READ AS AGREEMENT ──────────────────
 *
 * `alike: true` — one thing written two ways, by the rules above. Read as one.
 *
 * `alike: false` — a pair that is just as consistent and is NOT a way of
 * writing anything: `DE` where the other says `Germany`, or `paid` where the
 * other says `overdue`. It stays a disagreement on every record. It is
 * reported because forty records disagreeing in the same one way is a
 * different thing to be told than forty disagreements, and because whether it
 * is a code or a fault is something a reader, or the model writing the answer
 * up, can say and this cannot.
 */
export function writtenTwoWays(
  entities: ReadonlyArray<ReadonlyArray<{ connectionId: string; value: unknown }>>,
): WrittenTwoWays[] {
  type Seen = { a: string; b: string; connectionA: string; connectionB: string; records: number };
  const pairs = new Map<string, Seen>();
  /* Per system pair, how often each value disagrees with anything at all. */
  const disagrees = new Map<string, number>();

  for (const readings of entities) {
    const held = readings
      .filter((reading) => (typeof reading.value === 'string' && reading.value.trim() !== '') || typeof reading.value === 'number')
      .map((reading) => ({ connectionId: reading.connectionId, value: String(reading.value).trim() }))
      .sort((x, y) => (x.connectionId < y.connectionId ? -1 : x.connectionId > y.connectionId ? 1 : 0));

    for (let i = 0; i < held.length; i += 1) {
      for (let j = i + 1; j < held.length; j += 1) {
        const [a, b] = [held[i]!, held[j]!];
        if (a.connectionId === b.connectionId || a.value.toLowerCase() === b.value.toLowerCase()) continue;

        const between = `${a.connectionId}\u0000${b.connectionId}`;
        const id = `${between}\u0000${a.value}\u0000${b.value}`;
        const seen = pairs.get(id) ?? { a: a.value, b: b.value, connectionA: a.connectionId, connectionB: b.connectionId, records: 0 };
        seen.records += 1;
        pairs.set(id, seen);

        for (const side of [`${between}\u0000a\u0000${a.value}`, `${between}\u0000b\u0000${b.value}`]) {
          disagrees.set(side, (disagrees.get(side) ?? 0) + 1);
        }
      }
    }
  }

  const found: WrittenTwoWays[] = [];

  for (const seen of pairs.values()) {
    const kind = writtenAlike(seen.a, seen.b);
    const between = `${seen.connectionA}\u0000${seen.connectionB}`;
    const keeps =
      seen.records / (disagrees.get(`${between}\u0000a\u0000${seen.a}`) ?? seen.records) >= KEEPS_TO &&
      seen.records / (disagrees.get(`${between}\u0000b\u0000${seen.b}`) ?? seen.records) >= KEEPS_TO;

    /* Punctuation and accents need no pattern behind them; anything else has to keep turning up, and keep to its partner. */
    const consistent = seen.records >= REPEATS && keeps;
    if (kind !== 'same' && !consistent) continue;

    found.push({
      a: { connectionId: seen.connectionA, value: seen.a },
      b: { connectionId: seen.connectionB, value: seen.b },
      records: seen.records,
      readsAs: seen.a.length > seen.b.length || (seen.a.length === seen.b.length && seen.a < seen.b) ? seen.a : seen.b,
      alike: kind !== null,
    });
  }

  return found.sort((x, y) => y.records - x.records || (x.a.value < y.a.value ? -1 : x.a.value > y.a.value ? 1 : 0));
}
