import { z } from 'zod';
import { CANONICAL_PRESETS, expandPreset, FILTER_STYLES, filterTemplates, PAGE_PRESETS, RECORDS_PRESETS, type FilterStyle, type Preset } from '../engine/compat/presets.compat';
import { withTransaction } from '../infra/db.infra';
import * as drafts from '../repos/connectorDraft.repo';
import * as lifecycle from '../repos/connectorVerify.repo';
import { manifest as manifestSchema, type Manifest } from '../schemas/manifest.schema';
import { CURRENT_SCHEMA_VERSION, loadManifest } from '../engine/compat/load.compat';
import { normalisationIssues } from '../engine/read/normalisation.read';
import { manifest as manifestV1Schema } from '../engine/compat/manifestV1.compat';
import { generateId } from '../utils/tokens.util';
import { invalid, notFound } from '../utils/error.util';
import { log as writeAudit } from './audit.service';
import type { Actor } from '../services/scope.service';

/**
 * Route 3 — the visual builder.
 *
 * NOBODY TYPES A MANIFEST. The screen is forms and dropdowns whose options come
 * from `vocabulary()` below, and this service is what stands behind them: it
 * holds the half-finished document, says what is wrong with it in terms a form
 * can attach to individual inputs, and turns it into a manifest when it is
 * complete.
 *
 * ALSO THE ESCAPE HATCH. §5 — a half-built AI connector opens here rather than
 * being discarded, which is the single behaviour that stops the AI route being a
 * dead end when it fails, and it will. That is why a draft is stored unvalidated
 * and why `validate` reports every problem at once instead of stopping at the
 * first: somebody recovering a failed build needs the whole list, not a tour.
 */

/* ── Saying what is wrong, in a form's terms ────────────────────────────── */

export interface FieldError {
  /** Dotted path into the document, e.g. `auth.0.endpoints.tokenUrl`. */
  path: string;
  message: string;
  /** The field is present but wrong, versus absent and required. */
  kind: 'missing' | 'invalid' | 'unexpected';
}

export interface Validation {
  valid: boolean;
  errors: FieldError[];
  /**
   * Fields that would come out in more than one spelling (MANIFEST-V2 §3.6).
   * They do not stop a publish — a customer's own connector is theirs to
   * judge — but they are said before it happens.
   */
  warnings: Array<{ path: string; message: string }>;
}

const pathOf = (segments: readonly (string | number | symbol)[]): string =>
  segments.map(String).join('.');

/**
 * Zod issues, flattened into something a form can render beside an input.
 *
 * THE PATH IS THE WHOLE VALUE HERE. "Invalid input" at the top of a page tells
 * somebody filling in twenty fields nothing; the same message under the one
 * field it refers to needs no explanation at all.
 *
 * AN UNRECOGNISED KEY IS REPORTED AGAINST THE KEY, not its parent. Zod puts the
 * issue on the object, which would light up the whole section — and the useful
 * thing to say is "there is no such field as this", pointing at it.
 */
/**
 * The value the document actually holds at an issue's path, or undefined.
 *
 * ASKED OF THE DOCUMENT RATHER THAN OF THE ISSUE. Zod 4 does not report what it
 * received, so "is this field blank or is it wrong" cannot be read off the
 * issue — and guessing from the message text would break the first time a
 * locale or a Zod release changed the wording.
 */
function valueAt(document: unknown, path: readonly (string | number | symbol)[]): unknown {
  let cursor: unknown = document;
  for (const segment of path) {
    if (cursor === null || typeof cursor !== 'object') return undefined;
    cursor = (cursor as Record<string, unknown>)[String(segment)];
  }
  return cursor;
}

function fieldErrors(error: z.ZodError, document: unknown): FieldError[] {
  const out: FieldError[] = [];

  for (const issue of error.issues) {
    if (issue.code === 'unrecognized_keys') {
      for (const key of issue.keys) {
        out.push({
          path: pathOf([...issue.path, key]),
          message: 'There is no such setting here.',
          kind: 'unexpected',
        });
      }
      continue;
    }

    /*
     * ABSENT AND WRONG ARE DIFFERENT THINGS TO A FORM. One is a field still to
     * fill in, and the other is a field filled in wrongly — showing an error on
     * every blank field of a half-finished draft makes the builder look broken
     * the moment it opens.
     */
    const missing = issue.code === 'invalid_type' && valueAt(document, issue.path) === undefined;

    out.push({
      path: pathOf(issue.path),
      message: issue.message,
      kind: missing ? 'missing' : 'invalid',
    });
  }

  return out;
}

/**
 * Whether a draft is a connector the engine can run.
 *
 * EITHER DOCUMENT VERSION. A version 1 draft is checked against the version 1
 * form it was written in — so its errors point at the fields the person can
 * see — and then compiled, because a v1 document the compile refuses is not
 * one the engine will run.
 */
export function validate(document: unknown): Validation {
  const version = (document as { schemaVersion?: unknown } | null)?.schemaVersion;
  if (version === 1) {
    const legacy = manifestV1Schema.safeParse(document);
    if (!legacy.success) return { valid: false, errors: fieldErrors(legacy.error, document), warnings: [] };
    const compiled = loadManifest(document, 1);
    return compiled.ok
      ? { valid: true, errors: [], warnings: warningsOf(compiled.manifest) }
      : { valid: false, errors: compiled.issues.map((message) => ({ path: '', message, kind: 'invalid' as const })), warnings: [] };
  }
  const result = manifestSchema.safeParse(document);
  return result.success
    ? { valid: true, errors: [], warnings: warningsOf(result.data) }
    : { valid: false, errors: fieldErrors(result.error, document), warnings: [] };
}

const warningsOf = (manifest: Manifest): Validation['warnings'] => [
  /* Allowed — a connection can be made first and Silo left to find what it holds — but never silent. */
  ...(manifest.objects.length === 0 ? [{ path: 'objects', message: 'It reads nothing yet: add what it should read, or connect it and let Silo find what the system holds.' }] : []),
  ...normalisationIssues(manifest).map(({ path, message }) => ({ path, message })),
];

/** A draft, as the manifest the engine would run — compiled when it is version 1. */
export function executable(document: unknown): Manifest | null {
  const version = (document as { schemaVersion?: unknown } | null)?.schemaVersion;
  const loaded = loadManifest(document, typeof version === 'number' ? version : CURRENT_SCHEMA_VERSION);
  return loaded.ok ? loaded.manifest : null;
}

/* ── The draft itself ───────────────────────────────────────────────────── */

export async function listDrafts(actor: Actor): Promise<drafts.Draft[]> {
  void actor;
  return withTransaction((db) => drafts.list(db));
}

export async function openDraft(
  actor: Actor,
  id: string,
): Promise<{ draft: drafts.Draft; validation: Validation }> {
  void actor;
  const draft = await withTransaction((db) => drafts.find(db, id));
  if (!draft) throw notFound({ message: 'That draft does not exist.', code: 'missing.draft' });

  // Validated on the way out, so opening a recovered AI build shows immediately
  // what is left to fix rather than waiting for somebody to press something.
  return { draft, validation: validate(draft.document) };
}

/**
 * The two facts about a manifest that nobody can be asked for.
 *
 * `schemaVersion` IS THE PRODUCT'S, NOT THE CUSTOMER'S, and `identity.version`
 * is the lineage number this document will be published AS — `publishDraft`
 * overwrites it from the lineage either way. Both are required, so a document
 * missing them can never validate, and neither is a question a form could
 * sensibly put to somebody: "which version of our manifest format is your API"
 * has no answer.
 *
 * A DRAFT WAS ONLY SEEDED WHEN IT ARRIVED EMPTY, which meant the builder's own
 * route lost the seed the moment somebody typed a sentence about what the
 * connector reads — that sentence arrives as a document, and a document
 * replaced the default. The draft then had six things left and two of them were
 * unreachable from the screen.
 *
 * MERGED UNDER, NEVER OVER. An imported manifest keeps its own values,
 * including a schema version this build does not support — which has to fail
 * validation where somebody can see it, rather than being quietly rewritten to
 * one that parses.
 */
/**
 * THE VERSION A NEW DRAFT STARTS AT: the one the form and the model write. A
 * version 1 draft already saved stays version 1 and is compiled when published.
 */
const DRAFT_SCHEMA_VERSION = CURRENT_SCHEMA_VERSION;

function born(document: Record<string, unknown> = {}): Record<string, unknown> {
  const identity = (document.identity ?? {}) as Record<string, unknown>;

  return {
    schemaVersion: DRAFT_SCHEMA_VERSION,
    ...document,
    identity: { version: 1, ...identity },
  };
}

export async function createDraft(
  actor: Actor,
  input: {
    name: string;
    document?: Record<string, unknown>;
    sourceRoute?: 'ai' | 'visual';
    failedStage?: string | null;
  },
): Promise<drafts.Draft> {
  return withTransaction((db) =>
    drafts.insert(db, {
      id: generateId(),
      organisationId: actor.organisationId,
      name: input.name,
      document: born(input.document),
      sourceRoute: input.sourceRoute ?? 'visual',
      failedStage: input.failedStage ?? null,
      createdBy: actor.membershipId,
    }),
  );
}

export async function saveDraft(
  actor: Actor,
  id: string,
  patch: { name?: string; document?: Record<string, unknown> },
): Promise<{ draft: drafts.Draft; validation: Validation }> {
  void actor;

  /*
   * SAVED WITHOUT VALIDATION, AND VALIDATED AFTERWARDS. The builder saves as
   * somebody types, and refusing a save because the document is not yet a
   * manifest would mean the only recoverable drafts are the ones that did not
   * need recovering.
   */
  const draft = await withTransaction((db) => drafts.update(db, id, patch));
  if (!draft) throw notFound({ message: 'That draft does not exist.', code: 'missing.draft' });

  return { draft, validation: validate(draft.document) };
}

/**
 * A version 1 draft rewritten as version 2.
 *
 * THE BUILDER'S FORMS EDIT VERSION 2 ONLY. A draft saved before it moved still
 * opens and still validates against the form it was written in, but cannot be
 * edited field by field until it is rewritten. The rewrite is the compile the
 * engine already runs on it at every load, so what the draft becomes is exactly
 * what it already did; what the compile could not carry over becomes the
 * draft's authoring notes, which the builder shows.
 */
export async function upgradeDraft(actor: Actor, id: string): Promise<{ draft: drafts.Draft; validation: Validation }> {
  void actor;
  return withTransaction(async (db) => {
    const found = await drafts.find(db, id);
    if (!found) throw notFound({ message: 'That draft does not exist.', code: 'missing.draft' });
    if ((found.document as { schemaVersion?: unknown }).schemaVersion !== 1) {
      throw invalid({ message: 'This draft is already written in the current form.', code: 'invalid.draft_current' });
    }
    const loaded = loadManifest(found.document, 1);
    if (!loaded.ok) {
      throw invalid({
        message: 'Finish this draft before upgrading it: the upgrade rewrites a complete connector, and this one is not complete yet.',
        code: 'invalid.draft_incomplete',
        detail: { errors: validate(found.document).errors },
      });
    }
    const document = { ...loaded.manifest, authoring: { from: 'v1' as const, notes: loaded.notes.slice(0, 100) } };
    const draft = await drafts.update(db, id, { document: JSON.parse(JSON.stringify(document)) as Record<string, unknown> });
    if (!draft) throw notFound({ message: 'That draft does not exist.', code: 'missing.draft' });
    return { draft, validation: validate(draft.document) };
  });
}

export async function deleteDraft(actor: Actor, id: string): Promise<void> {
  void actor;
  const removed = await withTransaction((db) => drafts.remove(db, id));
  if (!removed) throw notFound({ message: 'That draft does not exist.', code: 'missing.draft' });
}

/* ── Becoming a connector ───────────────────────────────────────────────── */

export interface Published {
  manifestId: string;
  connectorKey: string;
  version: number;
}

/**
 * The only crossing from a draft to something the engine can execute.
 *
 * STRICT, AND IT REFUSES RATHER THAN REPAIRS. §5 says the builder "never emits a
 * manifest it could not execute" — a document patched into validity here would
 * be a connector doing something its author did not configure, and the author
 * would have no way to discover that.
 *
 * VERSIONS RATHER THAN OVERWRITES, because manifests are immutable once written
 * (013's trigger) and connections point at a specific one. Publishing a fix
 * while somebody's query is mid-flight must not change what that query is doing.
 */
export async function publishDraft(actor: Actor, id: string): Promise<Published> {
  const draft = await withTransaction((db) => drafts.find(db, id));
  if (!draft) throw notFound({ message: 'That draft does not exist.', code: 'missing.draft' });

  const validation = validate(draft.document);
  const manifest = validation.valid ? executable(draft.document) : null;
  if (!manifest) {
    throw invalid({
      message: 'This connector is not finished yet.',
      code: 'invalid.draft_incomplete',
      detail: { errors: validation.errors },
    });
  }

  /*
   * STORED AS WRITTEN. A version 1 document is kept as version 1 and compiled
   * each time it is loaded, so what was published is what is cited.
   */
  const stored = draft.document as Record<string, unknown> & { identity: Record<string, unknown>; schemaVersion: number };
  return publishVersion(actor, { stored, manifest, sourceRoute: draft.sourceRoute, draftId: id });
}

/**
 * A version of a connector that says only how to reach the system and sign in.
 *
 * FOR A BUILD WHOSE SIGN-IN NEEDS A CONNECTION FIRST — a consent page (OAuth)
 * or the customer's agent. Both are set up on a connection, and a connection
 * points at a published version, so the build publishes this one first: its
 * one object is unavailable, so nothing can be asked of it. The finished
 * connector is published after it, in the same lineage, and the connection
 * moves onto that through the ordinary adoption.
 */
export async function publishSignIn(actor: Actor, signIn: Manifest): Promise<Published> {
  const stored = JSON.parse(JSON.stringify(signIn)) as Record<string, unknown> & { identity: Record<string, unknown>; schemaVersion: number };
  return publishVersion(actor, { stored, manifest: signIn, sourceRoute: 'ai', draftId: null });
}

/**
 * A version of a connection's connector that reads more of the system — every
 * field on its own field list. Published in the same lineage; the connection
 * moves onto it through the ordinary adoption, which reads every object first.
 */
export async function publishExpanded(actor: Actor, expanded: Manifest): Promise<Published> {
  const stored = JSON.parse(JSON.stringify(expanded)) as Record<string, unknown> & { identity: Record<string, unknown>; schemaVersion: number };
  return publishVersion(actor, { stored, manifest: expanded, sourceRoute: 'ai', draftId: null });
}

async function publishVersion(
  actor: Actor,
  input: {
    stored: Record<string, unknown> & { identity: Record<string, unknown>; schemaVersion: number };
    manifest: Manifest;
    sourceRoute: 'ai' | 'visual';
    /** The draft this version is the published form of. Null for a sign-in version, which leaves its draft unpublished. */
    draftId: string | null;
  },
): Promise<Published> {
  const { stored } = input;
  const connectorKey = keyFor(input.manifest);
  const id = input.draftId;

  return withTransaction(async (db) => {
    /*
     * THE LOCK IS TAKEN BEFORE THE COUNT AND HELD FOR THE REST OF THE
     * TRANSACTION. Two publishes racing would otherwise both read the same
     * highest version and both try to write it, and one would fail on 013's
     * unique index — a confusing error for a person who pressed a button twice,
     * when the honest outcome is version 4 followed by version 5.
     */
    await lifecycle.lockLineage(db, `manifest:${actor.organisationId}:${connectorKey}`);

    const version = await lifecycle.nextVersion(db, {
      organisationId: actor.organisationId,
      connectorKey,
    });

    const manifestId = await lifecycle.insertVersion(db, {
      organisationId: actor.organisationId,
      connectorKey,
      version,
      /* The version is stamped into the document as well as the column: an
         answer cites the identity it was produced from, not the row it sat in. */
      document: { ...stored, identity: { ...stored.identity, version } },
      schemaVersion: stored.schemaVersion,
      sourceRoute: input.sourceRoute,
      createdBy: actor.membershipId,
    });

    /*
     * §11 — "Manifests are immutable once used and every returned figure cites a
     * version in its lineage." A publish that is not recorded cannot be
     * reconciled with the answers that came out of it afterwards.
     */
    await writeAudit(db, {
      event: 'connector_manifest_versioned',
      organisationId: actor.organisationId,
      membershipId: actor.membershipId,
      userId: null,
      detail: { manifestId, connectorKey, version, sourceRoute: input.sourceRoute },
    });

    if (id) await drafts.markPublished(db, id, manifestId);
    return { manifestId, connectorKey, version };
  });
}

/**
 * The stable name a connector's versions share.
 *
 * DERIVED FROM THE PROVIDER, NOT FROM THE DRAFT'S NAME. Somebody renaming a
 * draft from "Salesforce (test)" to "Salesforce" must not thereby start a
 * separate connector at version 1 while the connections keep pointing at the old
 * lineage.
 */
function keyFor(manifest: Manifest): string {
  return manifest.identity.provider
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 128);
}

/* ── What the dropdowns are made of ─────────────────────────────────────── */

export interface BuilderVocabulary extends drafts.Vocabulary {
  presets: {
    page: readonly Preset[];
    records: readonly Preset[];
    filterStyles: readonly FilterStyle[];
    canonical: Array<{ id: string; expression: string }>;
  };
}

export async function vocabularyFor(actor: Actor, route: 'ai' | 'visual'): Promise<BuilderVocabulary> {
  void actor;
  const tables = await withTransaction((db) => drafts.vocabulary(db, route));
  return {
    ...tables,
    presets: {
      page: PAGE_PRESETS,
      records: RECORDS_PRESETS,
      filterStyles: FILTER_STYLES,
      canonical: Object.entries(CANONICAL_PRESETS).map(([id, expression]) => ({ id, expression })),
    },
  };
}

/**
 * A preset filled in: the expressions it writes, for the form to merge into the
 * operation. Refuses a preset id it does not know, by name.
 */
export function expand(input: {
  kind: 'page' | 'records' | 'filters';
  id: string;
  values: Record<string, string>;
  fields?: string[];
  ops?: string[];
}): Record<string, unknown> {
  if (input.kind === 'filters') {
    if (!FILTER_STYLES.some((style) => style.id === input.id)) {
      throw invalid({ message: `There is no filter style called ${input.id}.`, code: 'invalid.preset_unknown' });
    }
    return filterTemplates(input.id, input.values, input.fields ?? [], input.ops ?? []);
  }
  const preset = (input.kind === 'page' ? PAGE_PRESETS : RECORDS_PRESETS).find((one) => one.id === input.id);
  if (!preset) throw invalid({ message: `There is no ${input.kind} preset called ${input.id}.`, code: 'invalid.preset_unknown' });
  return expandPreset(preset, input.values);
}
