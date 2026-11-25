import { z } from 'zod';
import { env } from '../config/env.config';
import { childLogger } from '../config/logger.config';
import { withTransaction } from '../infra/db.infra';
import { classifyRecords, readAnswer, ModelBusy, ModelUnavailable } from '../infra/model.infra';
import { ANSWER_MODEL_DISCLOSURE } from '../models/storageDisclosure.model';
import * as consentRepo from '../repos/answerReading.repo';
import * as webRepo from '../repos/webContext.repo';
import * as conceptRepo from '../repos/concept.repo';
import * as connectorRepo from '../repos/connector.repo';
import * as fieldAliasRepo from '../repos/fieldAlias.repo';
import * as objectKindRepo from '../repos/objectKind.repo';
import type { ObjectKind } from '../repos/objectKind.repo';
import { createHash } from 'node:crypto';
import { couldBeLookedUp, coverageOf, digestOf, judgedOf, recommendationsOf, sameFieldsOf, subjectsOf, unverifiedFigures, visualOf, type Coverage, type Judged, type Recommendation, type ReadingOutside, type ReadingPart, type SameFields, type Visual } from '../engine/render/reading.render';
import { withLearned } from '../engine/ontology/derive.ontology';
import { agreementOn } from '../engine/ontology/corroborate.ontology';
import { connectionCapabilities } from '../engine/read/capabilities.read';
import { joinIfPending, sharedRecords } from './concept.service';
import type { ContributingObject } from '../models/concept.model';
import { runWithTenant } from '../utils/tenantContext.util';
import { invalid, isAppError, refusal } from '../utils/error.util';
import { log as writeAudit } from './audit.service';
import { assertCan, assertCleared, authorityOf, can, type Authority } from './authorisation.service';
import { readableIds } from './connector.service';
import { hiddenFields, visibleObjects } from './fieldPolicy.service';
import * as tokens from './tokens.service';
import { numberedAfter, outsideFor } from './outside.service';
import type { Source } from '../utils/citations.util';
import type { Actor } from './scope.service';

const log = childLogger('answer-reading');

/**
 * 129 — answers written up by a model.
 *
 * ── ON FOR EVERYBODY, UNLESS A SUPER ADMIN SAYS OTHERWISE ─────────────────
 *
 * A written-up answer is what the Console is for, so it is the default. It is
 * still an exception to business data never reaching a model, so it is said in
 * words on the organisation's settings and the public security page, a super
 * admin can switch it off for the whole organisation, and — whatever anybody
 * chose — nothing is sent until the deployment has confirmed zero retention.
 * Until then, and wherever it is off, the Console describes an answer in the
 * fixed sentences it always had.
 *
 * ── THE MODEL WRITES; IT DOES NOT DECIDE A FIGURE ─────────────────────────
 *
 * What it is shown, how what it writes is checked, and why it never draws are
 * `reading.render`'s. This file is the gate and the bill.
 */

export type ReadOutcome =
  | {
      outcome: 'read';
      paragraphs: string[];
      /** Figures the model wrote that are not among those Silo read, as written. */
      unverified: string[];
      /** The chart it chose, checked against the answer — or none, and then there is no View. */
      visual: Visual | null;
      /** Sources this write-up or follow-up found on the web, numbered on from those already cited. */
      found: Source[];
      /** The direct answer, and what else is worth knowing — each said once. Absent on a follow-up. */
      answer?: string;
      insights?: string[];
      /** Per record: whether it meets what the question picked by, and where that was decided. Checked, not trusted. */
      judged: Judged[];
      /** How much of each judged answer came from the records, from the web, or could not be decided — counted here. */
      coverage: Coverage[];
      /** Values worth recording in fields the system holds, for records that were read — each an offer to write. */
      recommendations: Recommendation[];
      /** What was sent to the web about this answer's records: organisation names, and their websites. */
      checkedOnWeb: string[];
      /** Fields of different systems this write-up found to be one thing, and Silo will read as one from now on. */
      learned: Learned[];
      /** Systems found to hold the same records while this was being written, and joined: asked again, they are read together. */
      joined: Array<{ name: string; systems: string[] }>;
    }
  /** The model answered with something that was not a write-up. Nothing charged; the fixed sentences stand. */
  | { outcome: 'unread'; reason: string };

/**
 * §2.3 (131) — fields of different systems found to hold the same thing.
 *
 * NAMES AND COUNTS. Which system calls it what, the name they are read by from
 * now on, and how many of the answer's records bore it out.
 */
export type Learned = {
  /** Counted from zero. */
  part: number;
  as: string;
  /** Each system's own name for it. `id` is what taking the match back removes; the system whose name was kept has none. */
  fields: Array<{ system: string; field: string; id?: string }>;
  /** Read from the systems themselves: how many shared records held both fields, and how many agreed. */
  compared: number;
  agreed: number;
  /** Whether this asker may take it back. Anybody's question can teach; undoing is a decision about a system's fields. */
  mayUndo: boolean;
};

const written = z
  .object({
    answer: z.string().min(1).max(2000).optional(),
    insights: z.array(z.string().min(1).max(2000)).max(8).optional(),
    paragraphs: z.array(z.string().min(1).max(6000)).min(1).max(12).optional(),
    judged: z.unknown().optional(),
    recommendations: z.unknown().optional(),
    same: z.unknown().optional(),
    visual: z.unknown().optional(),
  })
  .passthrough()
  .refine((body) => Boolean(body.answer || body.paragraphs?.length), 'A write-up says something');

type Db = Parameters<Parameters<typeof withTransaction>[0]>[0];

const tenant = <T>(actor: Actor, run: (db: Db) => Promise<T>) =>
  runWithTenant({ organisationId: actor.organisationId, membershipId: actor.membershipId }, () => withTransaction(run));

/** Whether answers are written up here, who switched it off if anybody did, and what it means. */
export async function setting(actor: Actor): Promise<{
  enabled: boolean;
  switchedOffAt: Date | null;
  retentionConfirmed: boolean;
  disclosure: { paragraphs: readonly string[] };
}> {
  return tenant(actor, async (db) => {
    const off = await consentRepo.find(db);
    return {
      enabled: off === null,
      switchedOffAt: off?.switchedOffAt ?? null,
      retentionConfirmed: env.VERTEX_ZERO_RETENTION_CONFIRMED,
      disclosure: { paragraphs: ANSWER_MODEL_DISCLOSURE },
    };
  });
}

/**
 * Switch answers written up by a model off for the organisation, or back on.
 *
 * `silo.enable`, BECAUSE IT IS THE SAME KIND OF DECISION: super admin only and
 * never delegable, since it decides what leaves the deployment. Both acts are
 * audited — who stopped records reaching a model, and who let them again.
 */
export async function set(actor: Actor, input: { enabled: boolean }): Promise<void> {
  await tenant(actor, async (db) => {
    assertCan(await authorityOf(db, actor.membershipId, actor.organisationId), 'silo.enable');

    const changed = input.enabled
      ? await consentRepo.switchOn(db)
      : await consentRepo.switchOff(db, { organisationId: actor.organisationId, membershipId: actor.membershipId });

    if (changed) {
      await writeAudit(db, {
        event: input.enabled ? 'answer_reading_switched_on' : 'answer_reading_switched_off',
        organisationId: actor.organisationId,
        membershipId: actor.membershipId,
        userId: null,
        detail: {},
      });
    }
  });
}

/** Whether context from the web is allowed in this organisation (130), and since when it was not. */
export async function webSetting(actor: Actor): Promise<{ enabled: boolean; switchedOffAt: Date | null }> {
  return tenant(actor, async (db) => {
    const off = await webRepo.switchedOff(db);
    return { enabled: off === null, switchedOffAt: off?.at ?? null };
  });
}

/**
 * Switch context from the web off for the whole organisation, or back on.
 * `silo.enable` for the same reason as write-ups: it decides what leaves.
 */
export async function setWeb(actor: Actor, input: { enabled: boolean }): Promise<void> {
  await tenant(actor, async (db) => {
    assertCan(await authorityOf(db, actor.membershipId, actor.organisationId), 'silo.enable');
    const changed = input.enabled
      ? await webRepo.switchOn(db)
      : await webRepo.switchOff(db, { organisationId: actor.organisationId, membershipId: actor.membershipId });
    if (changed) {
      await writeAudit(db, {
        event: input.enabled ? 'web_context_switched_on' : 'web_context_switched_off',
        organisationId: actor.organisationId,
        membershipId: actor.membershipId,
        userId: null,
        detail: {},
      });
    }
  });
}

/**
 * Write up an answer the asker was just given, or answer a question about it.
 *
 * REFUSED BEFORE ANYTHING IS SENT where a super admin has switched it off, or
 * the deployment has not confirmed retention — with a code the Console reads to
 * fall back to the fixed sentences and say why.
 *
 * CHARGED ONLY FOR A WRITE-UP THAT CAME BACK. A model that returned something
 * else produced nothing anybody reads.
 */
export async function read(
  actor: Actor,
  input: {
    question: string;
    history?: Array<{ role: 'user' | 'model'; text: string }>;
    /** `conceptId` says which concept a part is an answer about, so what is learned about its fields can be kept. */
    parts: Array<ReadingPart & { conceptId?: string }>;
    outside?: ReadingOutside;
    discussion?: Array<{ role: 'user' | 'model'; text: string }>;
    /** The asker let the Console look outside the systems: what the records lack is looked for. */
    web?: boolean;
  },
): Promise<ReadOutcome> {
  const preflight = await tenant(actor, async (db) => {
    const authority = await authorityOf(db, actor.membershipId, actor.organisationId);
    assertCan(authority, 'query.run');
    if (await consentRepo.find(db)) {
      throw refusal({
        message: 'A super admin has switched off written-up answers for this organisation.',
        code: 'refusal.answer_reading_off',
      });
    }
    /* The organisation's switch wins over the asker's. */
    if (input.web && (await webRepo.switchedOff(db))) input = { ...input, web: false };

    return {
      /* A follow-up talks about an answer; it is the write-up that reads one. */
      teachable: input.discussion?.length ? [] : await heldApart(db, actor, authority, input.parts),
      /* What the parts' records are about, where the web is on and a name might leave (134). */
      described: input.web ? await describedParts(db, actor, authority, input.parts) : [],
    };
  });
  const { teachable } = preflight;

  /*
   * WHAT THE MODEL IS SHOWN IS SILO'S, NOT THE REQUEST'S. `apart` — which
   * fields are held in which systems — is worked out from the concept above,
   * and anything a request put there is dropped: it decides what may be
   * learned, and a caller must not be able to write it.
   */
  const kinds = await kindsOf(actor, input.parts, preflight.described);

  input = {
    ...input,
    parts: input.parts.map((part, index) => {
      const { apart: _sent, kind: _claimed, ...rest } = part;
      const taught = teachable.find((one) => one.part === index);
      const kind = kinds.get(index);
      return { ...rest, ...(taught ? { apart: taught.apart } : {}), ...(kind ? { kind } : {}) };
    }),
  };

  if (!env.VERTEX_ZERO_RETENTION_CONFIRMED) {
    throw refusal({
      message: 'This deployment has not confirmed zero data retention with the model, so no answer is sent to it.',
      code: 'refusal.answer_reading_retention_unconfirmed',
    });
  }

  if (input.discussion?.length && input.discussion.at(-1)!.role !== 'user') {
    throw invalid({ message: 'A conversation about an answer ends with the question being asked.', code: 'invalid.discussion_unasked' });
  }

  await tokens.afford(actor, 'answer_reading');

  /*
   * ── WITH THE WEB ON, WHAT THE RECORDS LACK IS LOOKED FOR ─────────────────
   *
   * The question's own web context was found before the answer existed, from
   * the words alone. Now the answer does exist, so the organisations it names
   * are looked up — what they do, how big they are, where they are — so the
   * write-up can say what the records are missing and what is publicly known
   * instead. A follow-up looks again, for what it asks.
   *
   * WHAT LEAVES IS DECIDED BY RULES, NOT BY THE MODEL THAT READ THE RECORDS:
   * the questions typed, and organisation names from `subjectsOf` — never a
   * person, a figure or an identifier. The write-up itself never searches.
   */
  const following = Boolean(input.discussion?.length);
  const typed = [
    ...(input.history ?? []).filter((turn) => turn.role === 'user').map((turn) => turn.text),
    input.question,
    ...(input.discussion ?? []).filter((turn) => turn.role === 'user').map((turn) => turn.text),
  ];
  const subjects = input.web ? subjectsOf(input.parts) : [];
  const criteria = [...new Set(input.parts.flatMap((part) => (part.judge ? [part.judge] : [])))];
  const looked =
    input.web && (following || subjects.length > 0)
      ? await outsideFor(typed.at(-1)!, typed.slice(0, -1), subjects, criteria)
      : null;
  const found = looked ? numberedAfter(looked, input.outside?.sources ?? []) : null;

  const outside: ReadingOutside | null =
    input.outside || found
      ? {
          paragraphs: [...(input.outside?.paragraphs ?? []), ...(found?.paragraphs ?? [])],
          sources: [...(input.outside?.sources ?? []), ...(found?.sources ?? [])],
        }
      : null;
  const digest = digestOf(input.parts, outside);

  /*
   * ── AND, BESIDE THE MODEL CALL, WHAT A NEW SYSTEM HOLDS IN COMMON (133) ───
   *
   * A connection confirmed since anybody last looked is waiting to be compared
   * with the others. That takes as long as the slowest system, which is why it
   * is not part of confirming one; here there is a model to wait for anyway,
   * so it costs this answer nothing. It returns at once when nothing is
   * waiting, and whatever it finds is for the NEXT question — this answer has
   * already been read.
   *
   * NEVER ABLE TO FAIL THE WRITE-UP. Somebody asked for an answer in words.
   */
  const joining = following
    ? Promise.resolve([])
    : joinIfPending(actor).catch((error: unknown) => {
        log.warn({ err: error }, 'Could not look for the same records across systems while writing an answer up');
        return [];
      });

  let result: Awaited<ReturnType<typeof readAnswer>>;
  try {
    result = await readAnswer({ digest, question: input.question, history: input.history, discussion: input.discussion });
  } catch (error) {
    if (error instanceof ModelUnavailable) {
      throw refusal({ message: 'The model cannot be reached right now, so this answer is described without it.', code: 'refusal.model_unavailable' });
    }
    if (error instanceof ModelBusy) {
      throw refusal({ message: 'The model is busy. Try again in a moment.', code: 'refusal.model_busy' });
    }
    throw error;
  }

  let parsed: z.infer<typeof written> | null = null;
  try {
    const checked = written.safeParse(JSON.parse(result.raw ?? ''));
    parsed = checked.success ? checked.data : null;
  } catch {
    parsed = null;
  }

  if (!result.ok || !parsed) {
    log.info({ ok: result.ok, outputTokens: result.outputTokens }, 'The model did not return a write-up');
    return { outcome: 'unread', reason: 'The model did not write this answer up, so it is described in fixed sentences.' };
  }

  const clean = (text: string) => text.replace(/\*\*|__/g, '').trim();
  const answer = parsed.answer ? clean(parsed.answer) : undefined;
  const insights = (parsed.insights ?? []).map(clean).filter(Boolean);
  /* The write-up as paragraphs too: what a follow-up is told was said, and what an older page shows. */
  const paragraphs = answer ? [answer, ...insights] : (parsed.paragraphs ?? []).map(clean).filter(Boolean);

  const cited = new Set((outside?.sources ?? []).map((source) => source.n));
  const judged = following ? [] : judgedOf(parsed.judged, input.parts, cited);
  const recommendations = recommendationsOf(parsed.recommendations, input.parts, cited);

  /*
   * ── WHAT THIS ANSWER TAUGHT ABOUT THE SYSTEMS ────────────────────────────
   *
   * The model said which fields of different systems hold the same thing;
   * `sameFieldsOf` kept the ones the records bear out. They are recorded so the
   * next question reads them as one field — names and counts, never a value.
   *
   * A FAILURE TO LEARN IS NOT A FAILURE TO ANSWER. The asker wanted a write-up
   * and has one; losing this costs a match that the next answer will find
   * again.
   */
  let learned: Learned[] = [];
  if (!following && teachable.length > 0) {
    try {
      learned = await keep(actor, sameFieldsOf(parsed.same, input.parts), teachable);
    } catch (error) {
      log.warn({ err: error }, 'What the write-up learned about field names was not kept');
    }
  }

  /*
   * WHAT THE MODEL MAY QUOTE: the digest it was shown, and the web context it
   * was given. A figure found in neither is its own arithmetic, and is handed
   * back marked as that.
   */
  const unverified = unverifiedFigures(
    [...paragraphs, ...recommendations.flatMap((one) => one.records.map((record) => record.value))],
    [digest, ...typed, ...(outside?.paragraphs ?? [])],
  );

  await tokens.spend(actor, 'answer_reading');
  if (found) await tokens.spend(actor, 'outside_context');

  return {
    outcome: 'read',
    paragraphs,
    unverified,
    /* A follow-up answers in words; the chart is the write-up's to choose. */
    visual: following ? null : visualOf(parsed.visual, input.parts),
    found: found?.sources ?? [],
    ...(answer ? { answer, insights } : {}),
    judged,
    coverage: following ? [] : coverageOf(judged, input.parts),
    recommendations,
    checkedOnWeb: found ? subjects : [],
    learned,
    joined: (await joining).map((one) => ({ name: one.name, systems: one.systems })),
  };
}

/* ── What a part's records are about (134) ────────────────────────────── */

type Described = {
  part: number;
  objects: Array<{ connectionId: string; objectName: string; fields: string[]; hash: string; known: ObjectKind | null }>;
};

const hashOf = (fields: readonly string[]) => createHash('sha256').update([...fields].sort().join('\u0000')).digest('hex');

/**
 * For each part that names its concept: the objects it reads, their field
 * names, and what those names were last read as.
 *
 * THE SAME GATES A QUESTION PASSES — the concept exists, the asker is cleared
 * for it and reaches its systems. A part that fails one is simply not
 * described, and then nothing from it is looked up that the older rules would
 * not already allow.
 */
async function describedParts(
  db: Db,
  actor: Actor,
  authority: Authority,
  parts: ReadonlyArray<ReadingPart & { conceptId?: string }>,
): Promise<Described[]> {
  const described: Described[] = [];

  for (const [part, sent] of parts.entries()) {
    if (!sent.conceptId) continue;

    const stored = await conceptRepo.read(db, sent.conceptId);
    if (!stored || stored.retiredAt) continue;

    try {
      await assertCleared(db, authority, { type: 'concept', id: stored.id, conceptIds: [stored.id] });
    } catch (error) {
      if (isAppError(error)) continue;
      throw error;
    }

    const connectionIds = [...new Set(stored.objects.map((object) => object.connectionId))];
    const readable = await readableIds(db, actor, connectionIds);
    if (connectionIds.some((id) => !readable.has(id))) continue;

    const loaded = await connectorRepo.load(db, connectionIds);
    const known = await objectKindRepo.forConnections(db, connectionIds);

    described.push({
      part,
      objects: stored.objects.flatMap((object) => {
        const fields = loaded
          .find((one) => one.connectionId === object.connectionId)
          ?.manifest.objects.find((one) => one.name === object.objectName)
          ?.fields.map((field) => field.name);
        if (!fields || fields.length === 0) return [];

        const hash = hashOf(fields);
        const held = known.find((one) => one.connectionId === object.connectionId && one.objectName === object.objectName);
        /* Read from an older set of field names: out of date, and read again. */
        return [{ connectionId: object.connectionId, objectName: object.objectName, fields, hash, known: held?.fieldsHash === hash ? held.kind : null }];
      }),
    });
  }

  return described;
}

/* How many objects one write-up will have read. Each is one small call, made once per object. */
const READINGS_MOST = 4;

/**
 * What each part's records are about, asking a model where nobody has yet.
 *
 * ── ASKED ONLY WHERE A NAME MIGHT LEAVE ───────────────────────────────────
 *
 * A reading is worth having only for a part the rules would otherwise look up
 * (`couldBeLookedUp`). It is made from the object's name and field names —
 * never a record — kept (134), and not asked for again until the fields change.
 *
 * ── THE STRICTEST ACROSS A CONCEPT'S SYSTEMS ──────────────────────────────
 *
 * One system's records being people is enough to stop the whole part. All of
 * them being organisations is what lets records the English words do not
 * recognise be looked up. Anything not read — the model unavailable, an
 * answer that was not one of the three words — is no reading at all, which
 * leaves the part to the rules it always had.
 */
async function kindsOf(
  actor: Actor,
  parts: ReadonlyArray<ReadingPart>,
  described: readonly Described[],
): Promise<Map<number, ObjectKind>> {
  const kinds = new Map<number, ObjectKind>();
  const fresh: Array<{ connectionId: string; objectName: string; kind: ObjectKind; hash: string }> = [];
  let asked = 0;

  for (const one of described) {
    const part = parts[one.part];
    if (!part || one.objects.length === 0) continue;

    const read: Array<ObjectKind | null> = [];

    for (const object of one.objects) {
      let kind = object.known ?? fresh.find((made) => made.connectionId === object.connectionId && made.objectName === object.objectName)?.kind ?? null;

      if (kind === null && couldBeLookedUp(part) && asked < READINGS_MOST) {
        asked += 1;
        try {
          const result = await classifyRecords({ object: object.objectName, fields: object.fields });
          const said = result.ok ? (JSON.parse(result.raw ?? '{}') as { kind?: unknown }).kind : null;
          if (said === 'organisation' || said === 'person' || said === 'other') {
            kind = said;
            fresh.push({ connectionId: object.connectionId, objectName: object.objectName, kind, hash: object.hash });
          }
        } catch (error) {
          log.info({ err: error }, 'An object’s field names could not be read for what its records are about');
        }
      }

      read.push(kind);
    }

    if (read.includes('person')) kinds.set(one.part, 'person');
    else if (read.every((kind) => kind === 'organisation')) kinds.set(one.part, 'organisation');
    else if (read.every((kind) => kind !== null)) kinds.set(one.part, 'other');
  }

  if (fresh.length > 0) {
    try {
      await tenant(actor, async (db) => {
        for (const made of fresh) {
          await objectKindRepo.record(db, {
            organisationId: actor.organisationId,
            connectionId: made.connectionId,
            objectName: made.objectName,
            kind: made.kind,
            fieldsHash: made.hash,
          });
        }
      });
    } catch (error) {
      /* Asked again next time; this answer already has what it was told. */
      log.warn({ err: error }, 'A reading of what an object’s records are about was not kept');
    }
  }

  return kinds;
}

/* ── Fields that hold the same thing (131) ────────────────────────────── */

type Teachable = {
  part: number;
  conceptId: string;
  /** The concept as a question reads it now: learned matches applied, and nothing this reader may not see. */
  objects: ContributingObject[];
  systemOf: Map<string, string>;
  /** What each system declares it can filter by, for asking it about the records another holds. */
  capabilityOf: Map<string, { filters: readonly string[]; maxFilterValues: number }>;
  apart: Array<{ field: string; systems: string[] }>;
  mayUndo: boolean;
};

/**
 * The parts whose fields a write-up may teach Silo about, and for each the
 * fields its systems hold apart.
 *
 * ── ANYBODY'S QUESTION MAY TEACH, BECAUSE THE RECORDS DECIDE ──────────────
 *
 * A learned match changes how everybody's later questions are read, and it
 * used to be taken only from somebody who could have declared it by hand —
 * because it rested on rows the request itself supplied. It no longer does:
 * `keep` reads the systems again, as this asker, and the match is kept only if
 * THEIR records bear it out. What an answer teaches is then a fact about the
 * systems, whoever asked, and the map improves with every question rather than
 * only with an administrator's.
 *
 * Taking one back is a different act — a decision about a system's fields —
 * and still needs `concept.confirm`; `mayUndo` says whether this asker has it.
 *
 * EVERY GATE A QUESTION PASSES STILL APPLIES: the concept exists, the asker is cleared
 * for it and reaches every system it spans, and a field hidden from them is
 * not among those it may be told about. A part that fails any of these is not
 * an error — it is a part nothing is learned from.
 */
async function heldApart(
  db: Db,
  actor: Actor,
  authority: Authority,
  parts: ReadonlyArray<ReadingPart & { conceptId?: string }>,
): Promise<Teachable[]> {
  const mayUndo = can(authority, 'concept.confirm');
  const teachable: Teachable[] = [];

  for (const [part, sent] of parts.entries()) {
    if (!sent.conceptId) continue;

    const stored = await conceptRepo.read(db, sent.conceptId);
    if (!stored || stored.retiredAt) continue;

    const connectionIds = [...new Set(stored.objects.map((object) => object.connectionId))];
    /* One system has nothing to be brought together with. */
    if (connectionIds.length < 2) continue;

    try {
      await assertCleared(db, authority, { type: 'concept', id: stored.id, conceptIds: [stored.id] });
    } catch (error) {
      if (isAppError(error)) continue;
      throw error;
    }

    const readable = await readableIds(db, actor, connectionIds);
    if (connectionIds.some((id) => !readable.has(id))) continue;

    const read = withLearned({ objects: stored.objects, learned: await fieldAliasRepo.learnedFor(db, connectionIds) });
    const objects = visibleObjects(read.objects, await hiddenFields(db, actor, connectionIds));

    const loaded = await connectorRepo.load(db, connectionIds);
    const systemOf = new Map(loaded.map((one) => [one.connectionId, one.name]));
    const capabilityOf = new Map(loaded.map((one) => [one.connectionId, connectionCapabilities(one.manifest)]));

    /* Only fields the answer holds values for: there is nothing to check the rest against. */
    const answered = new Set(sent.profile.map((field) => field.fieldPath));
    const fields = [...new Set(objects.flatMap((object) => Object.keys(object.fieldMap)))]
      .filter((field) => answered.has(field) && !(field in read.superseded))
      .sort();

    const apart = fields
      .map((field) => ({ field, holders: objects.filter((object) => field in object.fieldMap) }))
      .filter((one) => one.holders.length < objects.length)
      .map((one) => ({
        field: one.field,
        systems: [...new Set(one.holders.map((object) => systemOf.get(object.connectionId) ?? object.connectionId))],
      }));

    if (apart.length > 0) teachable.push({ part, conceptId: stored.id, objects, systemOf, capabilityOf, apart, mayUndo });
  }

  return teachable;
}

/**
 * Keep what the write-up found, per connection, and say what was kept.
 *
 * ── THE SYSTEMS ARE READ AGAIN, AND IT IS THEIR WORD THAT COUNTS ──────────
 *
 * `sameFieldsOf` checked the model's claim against the rows the request listed
 * — a cheap first look, and all it could be, since those rows came from the
 * asker. Before anything is kept, the two systems are asked for the records
 * they share (`sharedRecords`), and the two columns have to agree THERE. The
 * counts stored beside the match are those, not the request's.
 *
 * EVERY SYSTEM THAT HOLDS THE OLD NAME GAINS THE SHARED ONE, each on its own
 * evidence — a third system holding `town` is checked against the system whose
 * name was kept, like the first.
 *
 * NEVER OVER A PERSON'S WORD, AND NEVER TWO COLUMNS OF ONE SYSTEM. Where
 * somebody declared what that column is called, `learn` records nothing; where
 * a system already holds the shared name as a column of its own, the two are
 * two things there and are left so.
 */
async function keep(actor: Actor, same: readonly SameFields[], teachable: readonly Teachable[]): Promise<Learned[]> {
  if (same.length === 0) return [];

  /* Outside any transaction: these are requests to other people's systems. */
  const borne: Array<{
    found: SameFields;
    taught: Teachable;
    kept: Array<{ object: ContributingObject; field: string; column: string; compared: number; agreed: number }>;
  }> = [];

  for (const found of same) {
    const taught = teachable.find((one) => one.part === found.part);
    if (!taught) continue;

    const anchors = taught.objects.filter((object) => found.as in object.fieldMap && object.matchKeys.length > 0);
    const kept: (typeof borne)[number]['kept'] = [];

    for (const field of found.fields.filter((one) => one !== found.as)) {
      for (const object of taught.objects) {
        const column = object.fieldMap[field];
        if (column === undefined || found.as in object.fieldMap) continue;

        /* Checked against a system that already reads its column by the shared name. */
        const anchor = anchors.find((one) => one.connectionId !== object.connectionId && one.matchKeys.length === object.matchKeys.length);
        if (!anchor) continue;

        try {
          const { first, second } = await sharedRecords(actor, object, anchor, taught.capabilityOf.get(anchor.connectionId));
          const check = agreementOn({
            a: { rows: first, keys: object.matchKeys, column },
            b: { rows: second, keys: anchor.matchKeys, column: anchor.fieldMap[found.as]! },
          });
          if (check.borneOut) kept.push({ object, field, column, compared: check.compared, agreed: check.agreed });
        } catch (error) {
          log.info({ conceptId: taught.conceptId, err: error }, 'Could not read the records a field match rests on; nothing was learned from it');
        }
      }
    }

    if (kept.length > 0) borne.push({ found, taught, kept });
  }

  if (borne.length === 0) return [];

  return tenant(actor, async (db) => {
    const learned: Learned[] = [];

    for (const { found, taught, kept } of borne) {
      const fields: Learned['fields'] = taught.objects
        .filter((object) => found.as in object.fieldMap)
        .map((object) => ({ system: taught.systemOf.get(object.connectionId) ?? object.connectionId, field: found.as }));
      let recorded: { compared: number; agreed: number } | null = null;

      for (const one of kept) {
        const alias = await fieldAliasRepo.learn(db, {
          organisationId: actor.organisationId,
          connectionId: one.object.connectionId,
          objectName: one.object.objectName,
          sourceField: one.column,
          canonicalField: found.as,
          learnedFrom: actor.membershipId,
          compared: one.compared,
          agreed: one.agreed,
        });
        if (!alias) continue;

        recorded ??= { compared: one.compared, agreed: one.agreed };
        fields.unshift({ system: taught.systemOf.get(one.object.connectionId) ?? one.object.connectionId, field: one.field, id: alias.id });

        await writeAudit(db, {
          event: 'field_alias_learned',
          organisationId: actor.organisationId,
          membershipId: actor.membershipId,
          userId: null,
          detail: {
            conceptId: taught.conceptId,
            connectionId: one.object.connectionId,
            objectName: one.object.objectName,
            sourceField: one.column,
            canonicalField: found.as,
            compared: one.compared,
            agreed: one.agreed,
          },
        });
      }

      if (recorded) {
        learned.push({ part: found.part, as: found.as, fields, compared: recorded.compared, agreed: recorded.agreed, mayUndo: taught.mayUndo });
      }
    }

    if (learned.length > 0) log.info({ matches: learned.length }, 'Field names learned from a write-up');
    return learned;
  });
}
