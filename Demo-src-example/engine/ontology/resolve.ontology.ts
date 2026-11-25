import { at, keyOf, type Row } from '../detectors/shared.detector';
import type { ContributingObject } from '../../models/concept.model';

/**
 * §2.5 and §2.6 — deciding which rows, in which systems, are the same entity.
 *
 * THIS IS THE FUNCTION THE WHOLE ONTOLOGY EXISTS TO PRODUCE. A concept is a
 * name, a set of contributing objects and the fields they match on; none of
 * that does anything until something resolves rows against it. Before this file
 * the matching lived inside the disagreement detector, which meant identity was
 * decided by one detector and unavailable to the other nine — and that a
 * concept could be confirmed, stored, marked and never used.
 *
 * ── Exact, never fuzzy ──────────────────────────────────────────────────────
 *
 * §2.6. Two rows are the same entity when their match keys are equal, string
 * for string after trimming and case — or when a PERSON confirmed that they
 * are. Nothing here computes a similarity score, and there is no threshold to
 * tune. A wrong merge does not fail loudly: it produces a confident finding
 * about an entity that does not exist, and every figure downstream is quietly
 * wrong.
 *
 * ── Where inference is allowed to touch identity ───────────────────────────
 *
 * Nowhere in this file. The model may PROPOSE that two unmatched rows are the
 * same entity; a person confirms; the confirmation arrives here as an alias and
 * is applied as arithmetic. That is the whole of §2.6's promise that resolution
 * is deterministic after the decision.
 */

/** A pair somebody confirmed: these two references are one entity. */
export type Alias = {
  connectionA: string;
  valueRefA: string;
  connectionB: string;
  valueRefB: string;
};

export type SourceRows = {
  connectionId: string;
  object: ContributingObject;
  rows: Row[];
};

export type Member = {
  connectionId: string;
  /** How its own system identifies it. Never its contents. */
  ref: string;
  row: Row;
};

export type ResolvedEntity = {
  /**
   * A stable handle for the entity within this resolution.
   *
   * THE MATCH KEY WHERE THERE IS ONE, AND THE FIRST MEMBER'S REF WHERE THERE IS
   * NOT. An entity that exists only because somebody confirmed an alias has no
   * shared key by definition — that is what made it unresolved in the first
   * place — so it is named after the member that sorts first, which keeps the
   * name stable across runs.
   */
  key: string;
  members: Member[];
};

export type Unmatched = {
  connectionId: string;
  ref: string;
  /** The connection that holds no counterpart for it. */
  missingIn: string;
};

export type Resolution = {
  entities: ResolvedEntity[];
  /**
   * §2.6 — rows with no counterpart, which is a QUESTION and not a finding.
   * Either the record is genuinely missing there, or it is spelled differently
   * and nobody has said so yet. This function cannot tell those apart and does
   * not try.
   */
  unmatched: Unmatched[];
  /** How many rows carried a usable key, per connection. */
  keyed: Record<string, number>;
  /** Rows whose match keys were incomplete, so identity could not be read. */
  unkeyed: Record<string, number>;
};

/* ── Union-find over (connection, ref) ───────────────────────────────────── */

/**
 * TRANSITIVITY IS WHY THIS IS A UNION-FIND AND NOT A MAP.
 *
 * Netsuite and Sage agree on `INV-001`. Somebody separately confirms that
 * Sage's `INV-001` is Xero's `INV0001`. All three are one entity, and a
 * pairwise index would produce two overlapping pairs that disagree about how
 * many invoices exist. The count is the thing customers check first.
 */
class Groups {
  private parent = new Map<string, string>();

  find(id: string): string {
    const seen = this.parent.get(id);
    if (seen === undefined) {
      this.parent.set(id, id);
      return id;
    }
    if (seen === id) return id;

    const root = this.find(seen);
    /* Path compression, so a long confirmed chain does not make every later
       lookup walk it again. */
    this.parent.set(id, root);
    return root;
  }

  union(a: string, b: string): void {
    const rootA = this.find(a);
    const rootB = this.find(b);
    if (rootA === rootB) return;

    /*
     * THE SMALLER ID BECOMES THE ROOT, rather than whichever was seen first.
     * Union order depends on row order; a deterministic root means the same
     * inputs produce the same groups whatever order the sources came back in,
     * which §3.3 requires of everything downstream.
     */
    const [keep, drop] = rootA < rootB ? [rootA, rootB] : [rootB, rootA];
    this.parent.set(drop, keep);
  }
}

/*
 * A SEPARATOR NO IDENTIFIER CARRIES. A space would let connection `a` with ref
 * `b c` collide with connection `a b` and ref `c` — unlikely, and the kind of
 * collision that merges two entities silently, which §2.6 spends a paragraph
 * saying is worse than failing to merge.
 */
/** The one character that cannot appear in an identifier, so cannot collide. */
const SEPARATOR = '\u0000';

const handle = (connectionId: string, ref: string) => `${connectionId}${SEPARATOR}${ref}`;

/* ── Resolution ──────────────────────────────────────────────────────────── */

/**
 * Resolve rows from several systems into entities.
 *
 * DETERMINISTIC, AND THE ORDERING IS PART OF THAT. Sources are processed in the
 * order given and every output is sorted, so two runs over the same rows
 * produce byte-identical results — which is what lets a finding be re-detected
 * as the same finding rather than a second one.
 */
export function resolveEntities(input: {
  sources: SourceRows[];
  /** Pairs a person confirmed. §2.6 — applied as fact, never re-inferred. */
  aliases?: Alias[];
}): Resolution {
  const byHandle = new Map<string, Member>();
  const byKey = new Map<string, string[]>();
  /** Handles that carried a complete match key, so were eligible to match. */
  const eligible = new Set<string>();
  const groups = new Groups();

  const keyed: Record<string, number> = {};
  const unkeyed: Record<string, number> = {};

  for (const source of input.sources) {
    keyed[source.connectionId] = 0;
    unkeyed[source.connectionId] = 0;

    for (const row of source.rows) {
      const ref = String(at(row, source.object.identifierField) ?? '').trim();
      /*
       * A ROW THAT CANNOT NAME ITSELF CANNOT BE AN ENTITY. Every finding refers
       * to an instance by identifier; one without an identifier could only be
       * referred to by its contents, which is the line §3.2 draws.
       */
      if (ref === '') {
        unkeyed[source.connectionId] = (unkeyed[source.connectionId] ?? 0) + 1;
        continue;
      }

      const id = handle(source.connectionId, ref);
      /* First occurrence wins: a duplicate ref within one system is that
         system's duplication finding, not two entities here. */
      if (!byHandle.has(id)) byHandle.set(id, { connectionId: source.connectionId, ref, row });
      groups.find(id);

      const key = keyOf(row, source.object.matchKeys);
      if (key === null) {
        /* §2.6 — a partial key is not a key. Matching on it would merge every
           row that happens to be missing the same field. */
        unkeyed[source.connectionId] = (unkeyed[source.connectionId] ?? 0) + 1;
        continue;
      }

      keyed[source.connectionId] = (keyed[source.connectionId] ?? 0) + 1;
      eligible.add(id);
      byKey.set(key, [...(byKey.get(key) ?? []), id]);
    }
  }

  /* Equal keys are the same entity. This is the whole of the exact rule. */
  for (const members of byKey.values()) {
    for (let i = 1; i < members.length; i += 1) groups.union(members[0]!, members[i]!);
  }

  /*
   * Then the confirmed aliases, which may join groups that share no key. An
   * alias naming a reference nobody fetched is ignored rather than invented:
   * the row may be outside the page, or in a system this query did not reach.
   *
   * ── MATCHED THE WAY EVERY OTHER SURFACE MATCHES ──────────────────────────
   *
   * This used to look the alias up by its RAW stored value while the handles
   * were built from trimmed refs — and `detectDisagreement` trims AND folds
   * case. So one confirmation could apply in the detector and not here, for the
   * same two records, with no way to tell from either screen which had happened.
   *
   * The index is normalised; the HANDLES ARE NOT. An entity is still named by
   * the reference its system states, because that is what is displayed and what
   * a finding refers to — only the lookup is lenient.
   */
  const normalisedHandles = new Map<string, string[]>();
  for (const id of byHandle.keys()) {
    const at = id.indexOf(SEPARATOR);
    const lenient = `${id.slice(0, at)}${SEPARATOR}${id.slice(at + 1).trim().toLowerCase()}`;
    normalisedHandles.set(lenient, [...(normalisedHandles.get(lenient) ?? []), id]);
  }

  const findHandle = (connectionId: string, ref: string): string | null => {
    const exact = handle(connectionId, ref);
    if (byHandle.has(exact)) return exact;

    const found = normalisedHandles.get(
      `${connectionId}${SEPARATOR}${ref.trim().toLowerCase()}`,
    );

    /*
     * AMBIGUOUS IS THE SAME AS ABSENT. Two rows whose identifiers differ only
     * in case or spacing are a duplication finding in that system; picking one
     * of them to honour a confirmation would attach it to whichever happened to
     * be indexed, and be wrong half the time silently.
     */
    return found?.length === 1 ? found[0]! : null;
  };

  for (const alias of input.aliases ?? []) {
    const a = findHandle(alias.connectionA, alias.valueRefA);
    const b = findHandle(alias.connectionB, alias.valueRefB);
    if (!a || !b) continue;
    groups.union(a, b);
  }

  /*
   * ROOT TO KEY, BUILT ONCE. Looking the key up per entity by scanning every
   * key's member list is quadratic, and an estate with ten thousand entities is
   * an ordinary size. The SMALLEST key wins where a group ended up holding
   * several — union order depends on row order, and the name of an entity must
   * not.
   */
  const rootKey = new Map<string, string>();
  for (const [key, ids] of byKey) {
    for (const id of ids) {
      const root = groups.find(id);
      const held = rootKey.get(root);
      if (held === undefined || key < held) rootKey.set(root, key);
    }
  }

  const grouped = new Map<string, Member[]>();
  for (const [id, member] of byHandle) {
    const root = groups.find(id);
    grouped.set(root, [...(grouped.get(root) ?? []), member]);
  }

  const entities: ResolvedEntity[] = [];
  for (const [root, members] of grouped) {
    const ordered = [...members].sort(
      (x, y) => x.connectionId.localeCompare(y.connectionId) || x.ref.localeCompare(y.ref),
    );

    entities.push({
      /* No shared key: the group exists because somebody confirmed it, so it is
         named after the member that sorts first and stays named that. */
      key: rootKey.get(root) ?? `${ordered[0]!.connectionId}:${ordered[0]!.ref}`,
      members: ordered,
    });
  }

  entities.sort((a, b) => a.key.localeCompare(b.key));

  /*
   * §2.6 — WHAT DID NOT MATCH, PER PAIR OF SYSTEMS, and only for rows that had a
   * key to match on. A row whose key was incomplete did not FAIL to match; it
   * was never eligible, and reporting it as an unresolved pair sends somebody to
   * decide a question about a record that is simply missing a field.
   */
  const unmatched: Unmatched[] = [];

  for (const entity of entities) {
    const holders = new Set(entity.members.map((member) => member.connectionId));

    for (const source of input.sources) {
      if (holders.has(source.connectionId)) continue;

      for (const member of entity.members) {
        if (!eligible.has(handle(member.connectionId, member.ref))) continue;
        unmatched.push({
          connectionId: member.connectionId,
          ref: member.ref,
          missingIn: source.connectionId,
        });
      }
    }
  }

  unmatched.sort(
    (a, b) =>
      a.connectionId.localeCompare(b.connectionId) ||
      a.ref.localeCompare(b.ref) ||
      a.missingIn.localeCompare(b.missingIn),
  );

  return { entities, unmatched, keyed, unkeyed };
}

/**
 * The entities present in every contributing system.
 *
 * FOR THE DETECTORS THAT COMPARE, because comparing a figure across systems
 * needs the entity to exist in both. §3's disagreement detector reads this;
 * absence reads `unmatched` instead, and the two are different findings about
 * the same rows.
 */
export function complete(resolution: Resolution, connectionIds: readonly string[]): ResolvedEntity[] {
  return resolution.entities.filter((entity) => {
    const held = new Set(entity.members.map((member) => member.connectionId));
    return connectionIds.every((id) => held.has(id));
  });
}

/**
 * Which reached identifiers are the same entity, from confirmed pairs alone.
 *
 * ── Why this exists beside `resolveEntities` ───────────────────────────────
 *
 * `resolveEntities` reads rows: it computes match keys and discovers identity.
 * A walk has no rows — it carried identifiers hop to hop and deliberately
 * fetched nothing else — so the only thing that can be said about identity at
 * the end of one is what a person has already CONFIRMED. That is a narrower
 * statement and it is the honest one: this system says `ACME-001` in Netsuite
 * and `Acme Ltd` in Sage are one supplier because somebody said so, not because
 * a walk inferred it.
 *
 * ── And why it is applied here rather than during the walk ─────────────────
 *
 * A resolution corrected in September has to repair a walk recorded in March.
 * It can, because the walk stored the keys the sources stated and this runs
 * over them afresh every time it is asked. A walk that resolved as it went
 * would have stored the answer, and the answer would stay wrong.
 */
export function identify(input: {
  aliases: readonly Alias[];
  refs: ReadonlyArray<{ connectionId: string; ref: string }>;
}): Array<{
  connectionId: string;
  ref: string;
  entity: string;
  /** Every other member of the group. Empty where nobody has confirmed a pair. */
  alsoKnownAs: Array<{ connectionId: string; ref: string }>;
}> {
  const groups = new Groups();
  const everyone = new Set<string>();

  /* Deterministic: aliases are unioned in a fixed order, and the union itself
     keeps the smaller handle as the root. */
  const ordered = [...input.aliases].sort((a, b) =>
    handle(a.connectionA, a.valueRefA) < handle(b.connectionA, b.valueRefA) ? -1 : 1,
  );

  for (const alias of ordered) {
    const a = handle(alias.connectionA, alias.valueRefA);
    const b = handle(alias.connectionB, alias.valueRefB);
    everyone.add(a);
    everyone.add(b);
    groups.union(a, b);
  }

  const members = new Map<string, string[]>();
  for (const id of [...everyone].sort()) {
    const root = groups.find(id);
    members.set(root, [...(members.get(root) ?? []), id]);
  }

  return input.refs.map((reached) => {
    const mine = handle(reached.connectionId, reached.ref);
    const root = groups.find(mine);

    /*
     * THE REF THE GROUP IS NAMED AFTER, not the handle. A handle carries the
     * connection id, which is an internal identifier and not what a reader is
     * being shown; the entity is named by the member that sorts first, which is
     * the same rule `resolveEntities` uses for an entity with no match key.
     *
     * THAT NAME IS A CONVENTION AND CARRIES NO INFORMATION, which is why the
     * members come back beside it. "This supplier is also Sage's `ACME`" is the
     * fact somebody confirmed; which of the two spellings ends up naming the
     * group is an ordering detail nobody should have to reason about.
     */
    return {
      connectionId: reached.connectionId,
      ref: reached.ref,
      entity: refOf(root),
      alsoKnownAs: (members.get(root) ?? [])
        .filter((id) => id !== mine)
        .map((id) => ({ connectionId: id.slice(0, id.indexOf(SEPARATOR)), ref: refOf(id) })),
    };
  });
}

/** The ref half of a handle. The separator is the one `handle` writes. */
const refOf = (id: string) => id.slice(id.indexOf(SEPARATOR) + 1);
