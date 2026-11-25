import type { Executor } from '../infra/db.infra';
import { generateId } from '../utils/tokens.util';
import type { Archetype, OverrideRate, RenderSelection } from '../models/render.model';

/**
 * Which archetype a result was drawn as, and whether somebody argued with it.
 *
 * NOTHING READS THIS TO PICK AN ARCHETYPE, and nothing should. §7.3's value is
 * that selection is deterministic — a result that drew as a ranking yesterday
 * draws as a ranking today — and a learned override would make the drawing
 * depend on who had been looking at it. This records; the precedence decides.
 *
 * THE COUNTS FROM `count(*)` ARRIVE AS STRINGS, like every bigint from pg, and
 * are coerced in the map below rather than at the call site.
 */

const COLUMNS = `
  id, organisation_id, result_ref, chosen, alternatives, overridden_to,
  membership_id, selected_at, overridden_at
`;

interface Row {
  id: string;
  organisation_id: string;
  result_ref: string;
  chosen: Archetype;
  alternatives: Archetype[];
  overridden_to: Archetype | null;
  membership_id: string;
  selected_at: Date;
  overridden_at: Date | null;
}

function map(row: Row): RenderSelection {
  return {
    id: row.id,
    organisationId: row.organisation_id,
    resultRef: row.result_ref,
    chosen: row.chosen,
    alternatives: row.alternatives,
    overriddenTo: row.overridden_to,
    membershipId: row.membership_id,
    selectedAt: row.selected_at,
    overriddenAt: row.overridden_at,
  };
}

/**
 * Record what was drawn.
 *
 * `DO NOTHING` ON CONFLICT — RE-DRAWING THE SAME RESULT IS NOT A NEW SELECTION.
 * A person switching tabs and coming back would otherwise look like the
 * precedence agreeing with itself twice, and inflate the denominator the
 * override rate is measured against.
 *
 * THE ID COMES BACK EVEN WHEN NOTHING WAS WRITTEN, which is what the caller had
 * before this moved and is preserved rather than corrected here: on a conflict
 * the returned id is the one generated for the attempt, not the id of the
 * selection that already stood.
 */
export async function record(
  db: Executor,
  input: {
    organisationId: string;
    resultRef: string;
    chosen: Archetype;
    alternatives: Archetype[];
    /* §11 — the structure the choice was made from, kept so an override can
       carry it later, when the result itself is long gone. */
    signals: unknown;
    membershipId: string;
  },
): Promise<string> {
  const id = generateId();

  /*
   * A NO-OP UPDATE RATHER THAN "DO NOTHING", so the existing row is RETURNED.
   * With DO NOTHING a conflict returns no rows and this handed back the id it
   * had just generated — an id that is not in the table. Every caller
   * re-recording a result got a handle to nothing, and the override path keyed
   * on it would never find the row.
   *
   * It writes "chosen" back to ITS OWN value, not to EXCLUDED's: re-drawing the
   * same result is not a new selection, and §7.3's override rate is measured
   * against what was chosen first.
   */
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO render_selections
       (id, organisation_id, result_ref, chosen, alternatives, signals, membership_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (membership_id, result_ref)
     DO UPDATE SET chosen = render_selections.chosen
     RETURNING id`,
    [
      id,
      input.organisationId,
      input.resultRef,
      input.chosen,
      input.alternatives,
      JSON.stringify(input.signals),
      input.membershipId,
    ],
  );

  /* The insert either created the row or returned the one that stands; there
     is no third case, so an absent row would be a lie rather than a default. */
  return rows[0]!.id;
}

/**
 * What this person was shown for that result.
 *
 * KEYED ON THE MEMBERSHIP BECAUSE THE ROW IS. §6.2 — which drawing suits a
 * question depends on what somebody is looking for, so two people reading the
 * same result have two selections, and `render_selections_one_per_result` is
 * unique on the pair.
 */
export async function signalsOf(db: Executor, id: string): Promise<unknown> {
  const { rows } = await db.query<{ signals: unknown }>(
    `SELECT signals FROM render_selections WHERE id = $1`,
    [id],
  );
  return rows[0]?.signals ?? {};
}

export async function forResult(
  db: Executor,
  input: { membershipId: string; resultRef: string },
): Promise<RenderSelection | null> {
  const { rows } = await db.query<Row>(
    `SELECT ${COLUMNS} FROM render_selections
      WHERE membership_id = $1 AND result_ref = $2`,
    [input.membershipId, input.resultRef],
  );

  const row = rows[0];
  return row ? map(row) : null;
}

/** Somebody chose something else. */
export async function markOverridden(
  db: Executor,
  input: { id: string; to: Archetype },
): Promise<void> {
  await db.query(
    `UPDATE render_selections
        SET overridden_to = $2, overridden_at = now()
      WHERE id = $1`,
    [input.id, input.to],
  );
}

/**
 * How often each archetype is being argued with.
 *
 * `mode() WITHIN GROUP` OVER A COLUMN THAT IS MOSTLY NULL gives the most common
 * archetype people switched TO, ignoring the rows nobody overrode — which is
 * the half of the answer that says what the precedence should have picked.
 */
export async function overrideRates(db: Executor): Promise<OverrideRate[]> {
  const { rows } = await db.query<{
    chosen: string;
    drawn: string;
    overridden: string;
    mostly_to: string | null;
  }>(
    `SELECT chosen,
            count(*) AS drawn,
            count(*) FILTER (WHERE overridden_to IS NOT NULL) AS overridden,
            mode() WITHIN GROUP (ORDER BY overridden_to) AS mostly_to
       FROM render_selections
      GROUP BY chosen
      ORDER BY count(*) FILTER (WHERE overridden_to IS NOT NULL) DESC`,
  );

  return rows.map((row) => ({
    chosen: row.chosen,
    drawn: Number(row.drawn),
    overridden: Number(row.overridden),
    mostlyTo: row.mostly_to,
  }));
}

/* ── §10: `view_preferences` ─────────────────────────────────────────────── */

export type Representation = 'prose' | 'view' | 'data';

/**
 * §2 — "The user's choice persists per view, not globally."
 *
 * AN UPSERT, BECAUSE THERE IS ONE ROW AND IT MOVES. A preference is not an
 * event: keeping a history of what somebody used to prefer is a table that
 * grows with every tab switch, and nothing reads it.
 */
export async function preferRepresentation(
  db: Executor,
  input: {
    organisationId: string;
    viewId: string;
    membershipId: string;
    representation: Representation;
  },
): Promise<void> {
  await db.query(
    `INSERT INTO view_preferences (organisation_id, view_id, membership_id, representation)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (view_id, membership_id)
     DO UPDATE SET representation = EXCLUDED.representation, chosen_at = now()`,
    [input.organisationId, input.viewId, input.membershipId, input.representation],
  );
}

/**
 * What this person last chose for this view, or nothing.
 *
 * NULL IS NOT `prose`. §2 makes prose the default for everything, and the
 * caller applies that — a repo that returned a default would make "never chose"
 * and "chose prose" the same answer, and the first thing anybody would want to
 * know is how many people actually switch.
 */
export async function preferenceFor(
  db: Executor,
  input: { viewId: string; membershipId: string },
): Promise<Representation | null> {
  const { rows } = await db.query<{ representation: Representation }>(
    `SELECT representation FROM view_preferences WHERE view_id = $1 AND membership_id = $2`,
    [input.viewId, input.membershipId],
  );
  return rows[0]?.representation ?? null;
}
