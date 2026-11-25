import { withTransaction } from '../infra/db.infra';
import { wrapper } from '../infra/kms.infra';
import * as model from '../infra/model.infra';
import { ModelBusy, ModelUnavailable } from '../infra/model.infra';
import { childLogger } from '../config/logger.config';
import { seal } from '../utils/envelope.util';
import { withSecret } from '../utils/mediator.util';
import { credentialAccessLog } from '../utils/credentialAudit.util';
import { invalid, isAppError, notFound, refusal, toResponse } from '../utils/error.util';
import { generateId } from '../utils/tokens.util';
import { labelOf } from '../utils/words.util';
import { manifestV2, type ManifestV2 } from '../schemas/manifest.schema';
import * as builds from '../repos/connectorBuild.repo';
import * as drafts from '../repos/connectorDraft.repo';
import * as probeRuns from '../repos/probe.repo';
import * as connectorRepo from '../repos/connector.repo';
import type { LoadedConnection, StoredCredential } from '../repos/connector.repo';
import { runRead } from '../engine/read/run.read';
import { ReadBudget } from '../engine/read/budget.read';
import { BlobStore } from '../engine/read/blob.read';
import type { ReadContext } from '../engine/read/context.read';
import { pinsFor } from '../engine/read/pins.read';
import { paramsFor } from '../engine/read/params.read';
import { recordsIn } from '../engine/discovery/derive.discovery';
import { shapeOf } from '../engine/discovery/shape.discovery';
import { candidatesFromResponse } from '../engine/compile/paging.compile';
import type { Credential } from '../engine/auth/credential.auth';
import { log as writeAudit } from './audit.service';
import { withConnection } from './connectorRuntime.service';
import { formFor, type ConnectForm } from './connectForm.service';
import * as ai from './connectorAi.service';
import { executable, publishDraft, publishSignIn, validate } from './connectorBuilder.service';
import { adopt, adoption } from './connectionVersion.service';
import { readEveryField } from './connectorFields.service';
import { routeFor } from './agentRoute.service';
import * as connections from './connection.service';
import { confirmMappings } from './connectorVerify.service';
import type { Actor } from './scope.service';
import type { Build, ProgressLine } from '../repos/connectorBuild.repo';

const log = childLogger('connector-build');

/**
 * Route 2, finished by Silo rather than by the person (MANIFEST-V2 §5).
 *
 * ── THE AI BUILDS AND TESTS; THE PERSON CONFIRMS ──────────────────────────
 *
 * The model's first draft is rarely right: a documentation page does not say
 * that HubSpot's fields live under `properties` or that it returns six of
 * them unless asked for more. Handing that draft to a person meant asking a
 * business administrator to finish a technical document. A build instead asks
 * them for the one thing only they have — the credential — and then:
 *
 *   read    each object once, the way the draft says, with that credential
 *   look    at what came back: its STRUCTURE, never its values
 *   repair  the draft from what was seen, and read again
 *
 * until every object reads real records with its fields filled, or a few
 * rounds have passed. Only then is the person shown anything: what was found,
 * as their own records, and a question — does this look right?
 *
 * ── WHAT A BUILD HOLDS, AND FOR HOW LONG ──────────────────────────────────
 *
 * The credential, sealed exactly as a connection's is, for at most a day (127).
 * Connecting moves it onto the new connection through the ordinary path — the
 * same sealing, pinning and audit as typing it into a connection — and clears
 * it here. No record is stored: the rounds keep words and counts, and the
 * review reads its sample live and returns it.
 *
 * ── A SIGN-IN THAT NEEDS A CONNECTION FIRST ───────────────────────────────
 *
 * A system that signs in through its own page (OAuth), or is reached through
 * the customer's agent, is set up on a connection: the consent round trip and
 * the agent's confirmed hosts belong to one. So for those the build publishes
 * a version that says only how to sign in, makes the connection, and tests its
 * draft THROUGH that connection — the test panel's own arrangement, the
 * credential from the connection and the shape from the draft. "Looks right"
 * then publishes the finished connector and moves the connection onto it by
 * the ordinary adoption, which reads every object before it moves.
 */

/** Repair rounds before the build stops and says what it could not fix. */
const MAX_ROUNDS = 4;
/** A person's "this is wrong" buys a few more. */
const FEEDBACK_ROUNDS = 2;
/** How long one round may hold the build — a model call and a few reads. */
const ROUND_SECONDS = 300;
/** How much of a response's structure one object contributes to the findings. */
const SHAPE_CHARS = 6_000;
/**
 * How much documentation a repair reads again — and it reads it only when
 * there is nothing live to go on. Once the system has answered, its answers
 * say more than the documentation does, and a hundred thousand characters of
 * it every round is what made a round take minutes.
 */
const SOURCE_CHARS = 40_000;
/** How long a build waits when the model service is busy, and how many waits in a row before it says so. */
const BUSY_SECONDS = 30;
const BUSY_WAITS = 3;
const BUSY_LINE = 'The AI service is busy. Silo will try again in half a minute.';
/** Records read per object when testing; two pages prove paging. */
const TEST_RECORDS = 200;
const PREVIEW_RECORDS = 5;

export interface BuildView {
  id: string;
  status: builds.BuildStatus;
  rounds: number;
  draftId: string;
  name: string;
  provider: string;
  description: string | null;
  progress: ProgressLine[];
  /** What to ask for, while the build waits for a credential. */
  form: ConnectForm | null;
  /**
   * How the person signs in: a key typed here, a consent page, or through the
   * agent — the last two on the connection the build made for it.
   */
  signIn: SignInKind | null;
  /** The connector's sign-in part, for the consent page's facts (endpoints, scopes). Never a secret. */
  signInDocument: Record<string, unknown> | null;
  /** What the connector reads, in the person's terms. */
  objects: Array<{ name: string; label: string; description: string | null }>;
  /** Why the build stopped, when it did. */
  reason: string | null;
  connectionId: string | null;
  expiresAt: string;
}

export interface Preview {
  objects: Array<{
    name: string;
    label: string;
    description: string | null;
    columns: Array<{ name: string; label: string }>;
    rows: Record<string, unknown>[];
    error: string | null;
    /** The key is not allowed to read these: a permission to give, or an object to connect without. */
    refused: boolean;
  }>;
  /** Where the credential will be sent: the addresses the person is agreeing to. */
  destinations: string[];
}

/* ── Words ──────────────────────────────────────────────────────────────── */

const line = (text: string, tone: ProgressLine['tone'] = 'info'): ProgressLine => ({ at: new Date().toISOString(), text, tone });


const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** What went wrong, for a person — the engine's codes are for the trail. */
function plainly(error: { code: string; message: string }): string {
  const code = error.code;
  if (code.startsWith('denial.')) return 'the system refused the key';
  if (code === 'missing.source_object' || /404/.test(error.message)) return 'the address was not found';
  if (code.startsWith('bounds.')) return 'there was more than a test should read';
  if (code === 'refusal.blocked_host') return 'the address is on a private network';
  if (code.startsWith('refusal.')) return error.message.replace(/\.$/, '').toLowerCase();
  if (code.startsWith('rate_limit')) return 'the system asked Silo to slow down';
  return 'the system answered with an error';
}

/* ── The parts of a draft ───────────────────────────────────────────────── */

type Doc = Record<string, unknown>;
const isObject = (v: unknown): v is Doc => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Stands in for the objects while they are still being worked out, so the sign-in can be read on its own. */
const PLACEHOLDER = { name: '__probe', identifier: ['body'], fields: [{ name: 'body', type: 'json' }], read: { request: { path: '/' }, records: '{{ [] }}' } };

/* A stand-in's request has to be one its transport accepts: a path, a table, a body, a mailbox, a topic. */
const STAND_IN_REQUESTS: Doc[] = [{ path: '/' }, { table: '__probe' }, { method: 'POST', body: {} }, { mailbox: 'INBOX' }, { topic: '__probe' }];

/** The draft's transport, sign-in and settings as a document the engine can run, whatever state its objects are in. */
function signInOf(document: Doc): ManifestV2 | null {
  for (const request of STAND_IN_REQUESTS) {
    /* Mappings name objects, and the objects are the part not being read here. */
    const parsed = manifestV2.safeParse({ ...document, objects: [{ ...PLACEHOLDER, read: { ...PLACEHOLDER.read, request } }], mappings: [] });
    if (parsed.success) return parsed.data;
  }
  return null;
}

/** The first request an object makes — one operation, the first step of a pipeline, or the unfiltered variant. */
function firstRead(object: Doc): Doc | null {
  let read = object.read;
  if (Array.isArray(read)) read = read.find((v) => isObject(v) && v.when === undefined) ?? read[read.length - 1];
  if (!isObject(read)) return null;
  if (Array.isArray(read.steps)) {
    const step = read.steps[0];
    return isObject(step) && isObject(step.operation) ? step.operation : null;
  }
  return read;
}

function describeRequest(read: Doc): string {
  const request = isObject(read.request) ? read.request : {};
  const method = typeof request.method === 'string' ? request.method : 'GET';
  const where = [request.path, request.url, request.table, request.statement, request.rpc, request.topic, request.mailbox].find((v) => typeof v === 'string') ?? '(no path)';
  const query = isObject(request.query) && Object.keys(request.query).length ? ` query ${JSON.stringify(request.query)}` : '';
  return `${method} ${String(where)}${query}`;
}

/* ── Opening the build as a connection ──────────────────────────────────── */

/**
 * The build, as the runtime sees a connection. Its id stands for the
 * connection's: the credential was sealed to it, every open of it is recorded
 * against it, and tokens derived from it are cached under it.
 */
function asConnection(build: Build, manifest: ManifestV2): LoadedConnection {
  return {
    connectionId: build.id,
    name: manifest.identity.name,
    provider: manifest.identity.provider,
    status: 'pending',
    writesEnabled: false,
    manifestId: build.draftId,
    manifestVersion: 0,
    manifest,
    schemaVersion: 2,
    compileNotes: [],
    parameters: build.parameters,
    pins: null,
  };
}

function storedOf(build: Build): StoredCredential | undefined {
  if (!build.sealed || !build.strategy) return undefined;
  return { connectionId: build.id, authStrategy: build.strategy, sealed: build.sealed, grantedScopes: [], expiresAt: null };
}

/* ── Looking ────────────────────────────────────────────────────────────── */

interface Examined {
  object: string;
  ok: boolean;
  /** Pairs of fields that held the same value in every record: one value, declared twice. */
  duplicates: string[];
  /**
   * The system refused the credential for this object. Beside objects that
   * read, that is a permission the key lacks — the person's to give, not the
   * connector's to repair.
   */
  refused: boolean;
  /** For a person. */
  summary: string;
  /** For the model: structure, codes and the system's error text — never a value. */
  finding: string;
}

/** One request as an object would make it, and what came back: the whole body, parsed, or the error. */
async function rawRead(ctx: ReadContext, read: Doc): Promise<{ body: unknown; headers: Record<string, unknown> } | { error: { code: string; message: string } }> {
  const pages: unknown[][] = [];
  try {
    const kept = Object.fromEntries(Object.entries(read).filter(([k]) => ['request', 'format', 'charset', 'formatOptions', 'errors'].includes(k)));
    const manifest = manifestV2.parse({ ...ctx.manifest, objects: [{ ...PLACEHOLDER, read: { ...kept, records: '{{ [{ "body": response, "headers": headers }] }}' } }] });
    const probe: ReadContext = { ...ctx, manifest, object: manifest.objects[0]!, budget: new ReadBudget(), blobs: new BlobStore(), observe: (records) => pages.push(records) };
    await runRead(probe, { object: '__probe', filters: [], sort: [], fields: [], limit: 1 }, { want: 1 });
    const first = pages[0]?.[0] as { body: unknown; headers: Record<string, unknown> } | undefined;
    return first ?? { body: null, headers: {} };
  } catch (error) {
    const body = toResponse(error).body.error;
    return { error: { code: body.code, message: body.message.slice(0, 300) } };
  }
}

/** Every object read as a bare request, for what the system really answers. */
async function lookAtResponses(actor: Actor, build: Build, document: Doc, signIn: ManifestV2): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const objects = Array.isArray(document.objects) ? document.objects.filter(isObject) : [];
  await withConnection({
    actor,
    reason: 'connection-verify',
    ...(await sourceOf(build, signIn)),
    use: async (open) => {
      const ctx = await open('__probe');
      for (const object of objects.slice(0, 12)) {
        const name = String(object.name ?? 'unnamed');
        const read = firstRead(object);
        if (!read) {
          out.set(name, `  It has no read Silo can make.`);
          continue;
        }
        const answer = await rawRead(ctx, read);
        if ('error' in answer) {
          out.set(name, `  ${describeRequest(read)} failed: ${answer.error.code} — ${answer.error.message}`);
          continue;
        }
        const found = recordsIn(answer.body);
        const lines = [`  ${describeRequest(read)} answered.`, `  Response structure: ${shapeOf(answer.body).slice(0, SHAPE_CHARS)}`];
        if (found) lines.push(`  The largest list of records is at ${found.path ? `response.${found.path}` : 'response'} (${found.records.length} on this page).`);
        else lines.push('  No list of records is visible in the response.');
        const paging = candidatesFromResponse({
          body: answer.body,
          headers: answer.headers as Record<string, string | string[]>,
          recordsPath: found?.path ?? null,
          queryParams: isObject(read.request) && isObject((read.request as Doc).query) ? Object.keys((read.request as Doc).query as Doc) : [],
        });
        if (paging.length) lines.push(`  Paging the response suggests: ${paging.slice(0, 3).map((c) => c.because).join(' / ')}`);
        out.set(name, lines.join('\n'));
      }
    },
  });
  return out;
}

/** The draft run as written, two pages of each object, judged. Needs a draft that validates. */
async function tryEachObject(actor: Actor, build: Build, manifest: ManifestV2, raw: Map<string, string>): Promise<Examined[]> {
  const twoPages: ManifestV2 = {
    ...manifest,
    objects: manifest.objects.map((o) => {
      const read = o.read as { page?: object };
      return !Array.isArray(o.read) && read.page ? { ...o, read: { ...(o.read as object), page: { ...read.page, maxPages: 2 } } } : o;
    }) as ManifestV2['objects'],
  };

  return withConnection({
    actor,
    reason: 'connection-verify',
    ...(await sourceOf(build, twoPages)),
    use: async (open) => {
      const out: Examined[] = [];
      for (const object of twoPages.objects) {
        const label = labelOf(object.name);
        const seen = raw.get(object.name) ?? '';
        const pages: unknown[][] = [];
        let rows: Record<string, unknown>[] = [];
        let failure: { code: string; message: string } | null = null;
        try {
          const ctx = await open(object.name);
          ctx.observe = (records) => pages.push(records);
          rows = (await runRead(ctx, { object: object.name, filters: [], sort: [], fields: [], limit: TEST_RECORDS }, { want: TEST_RECORDS })).rows;
        } catch (error) {
          const body = toResponse(error).body.error;
          /* Two pages of a longer list stop at the ceiling the test set: that is paging working. */
          if (!(body.code === 'bounds.read_ceiling' && pages.length >= 2)) failure = { code: body.code, message: body.message.slice(0, 300) };
        }

        if (failure) {
          const refused = failure.code.startsWith('denial.');
          out.push({
            object: object.name,
            ok: false,
            duplicates: [],
            refused,
            summary: refused ? `${label}: your key is not allowed to read these.` : `${label}: ${plainly(failure)}.`,
            finding: `Object "${object.name}": the read failed — ${failure.code}: ${failure.message}\n${seen}`,
          });
          continue;
        }

        const rawCount = pages.reduce((n, p) => n + p.length, 0);
        const declared = object.fields.map((f) => f.name);
        const filled = declared.filter((f) => rows.some((row) => row[f] !== null && row[f] !== undefined && row[f] !== ''));
        const empty = declared.filter((f) => !filled.includes(f));
        const idPresent = rows.every((row) => object.identifier.every((k) => row[k] !== null && row[k] !== undefined));
        const duplicates = rows.length < 2 ? [] : twins(declared, rows).map(([a, b]) => `${a} and ${b}`);
        const listedButUnread = rows.length === 0 && /on this page\)/.test(seen) && !/\(0 on this page\)/.test(seen);

        let pagingNote = 'one page';
        if (pages.length >= 2) {
          const key = object.identifier[0]!;
          const first = new Set(pages[0]!.map((r) => JSON.stringify((r as Doc)?.[key] ?? r)));
          pagingNote = pages[1]!.some((r) => !first.has(JSON.stringify((r as Doc)?.[key] ?? r))) ? 'a second page read different records' : 'the second page repeated the first';
        }

        const problems: string[] = [];
        if (listedButUnread) problems.push('the response has records but the records expression found none');
        if (rows.length > 0 && !idPresent) problems.push(`the identifier ${object.identifier.join(', ')} is missing from some records`);
        if (rows.length > 0 && filled.length < Math.ceil(declared.length / 2)) problems.push(`most fields came back empty: ${empty.join(', ')}`);
        if (pagingNote === 'the second page repeated the first') problems.push('paging asked for the same page twice');

        const finding = [
          `Object "${object.name}": ${describeRequest(firstRead(object as unknown as Doc) ?? {})}`,
          `  With the draft as written: ${rows.length} records read (${rawCount} before fields were applied); ${pagingNote}.`,
          `  Fields with a value in at least one record: ${filled.join(', ') || 'none'}. Empty in every record: ${empty.join(', ') || 'none'}.`,
          problems.length ? `  Problems: ${problems.join('; ')}.` : '  No problems.',
          duplicates.length ? `  The same value in every record, declared twice — keep one of each: ${duplicates.join('; ')}.` : '',
          seen,
        ].filter(Boolean).join('\n');

        if (problems.length) {
          out.push({ object: object.name, ok: false, duplicates, refused: false, summary: `${label}: ${problems[0]}.`, finding });
        } else {
          const some = filled.slice(0, 3).map(labelOf).join(', ');
          out.push({
            object: object.name,
            ok: true,
            duplicates,
            refused: false,
            summary:
              rows.length === 0
                ? `${label}: reads, and there are none yet.`
                : `${label}: read ${plural(rows.length, 'record')}${pages.length >= 2 ? ' across two pages' : ''} — ${some}${filled.length > 3 ? ` and ${filled.length - 3} more` : ''} filled.`,
            finding,
          });
        }
      }
      return out;
    },
  });
}

/** Fields that hold the same value in every record, at least one of them filled: `created` and `created_at`. */
function twins(fields: string[], rows: Record<string, unknown>[]): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  const value = (row: Record<string, unknown>, f: string) => JSON.stringify(row[f] ?? null);
  for (let i = 0; i < fields.length; i += 1) {
    for (let j = i + 1; j < fields.length; j += 1) {
      const [a, b] = [fields[i]!, fields[j]!];
      if (rows.some((r) => r[a] !== null && r[a] !== undefined) && rows.every((r) => value(r, a) === value(r, b))) out.push([a, b]);
    }
  }
  return out;
}

/* ── Repairing ──────────────────────────────────────────────────────────── */

async function repair(sourceUrl: string | null, document: Doc, findings: string, feedback?: string): Promise<Doc> {
  let source: string | undefined;
  if (sourceUrl) source = await ai.fetchSource(sourceUrl).then((s) => s.slice(0, SOURCE_CHARS)).catch(() => undefined);
  return repairWith(source, document, findings, feedback);
}

async function repairWith(source: string | undefined, document: Doc, findings: string, feedback?: string): Promise<Doc> {

  let result;
  try {
    result = await model.repairManifest({ document, findings, feedback, source });
  } catch (error) {
    if (error instanceof ModelBusy) throw error;
    if (error instanceof ModelUnavailable) {
      throw refusal({ message: 'The AI builder is not available in this deployment. Use the visual builder.', code: 'refusal.model_unavailable' });
    }
    throw error;
  }
  if (!result.ok || !result.raw) throw invalid({ message: 'The AI could not repair the connector.', code: 'invalid.repair_empty' });
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.raw);
  } catch {
    throw invalid({ message: 'The AI returned something that is not a connector.', code: 'invalid.repair_unparseable' });
  }
  if (!isObject(parsed)) throw invalid({ message: 'The AI returned something that is not a connector.', code: 'invalid.repair_unparseable' });

  /* The person's words about what it reads are theirs, and the name is what they called it. */
  const before = isObject(document.identity) ? document.identity : {};
  const after = isObject(parsed.identity) ? parsed.identity : {};
  parsed.identity = { ...after, name: before.name ?? after.name, provider: before.provider ?? after.provider, ...(before.description ? { description: before.description } : {}) };
  return parsed;
}

/* ── The view ───────────────────────────────────────────────────────────── */

async function viewOf(build: Build, reason: string | null = null): Promise<BuildView> {
  const draft = await withTransaction((db) => drafts.find(db, build.draftId));
  const document = (draft?.document ?? {}) as Doc;
  const identity = isObject(document.identity) ? document.identity : {};
  const signIn = signInOf(document);
  const objects = (Array.isArray(document.objects) ? document.objects.filter(isObject) : []).map((o) => ({
    name: String(o.name ?? ''),
    label: labelOf(String(o.name ?? '')),
    description: typeof o.description === 'string' ? o.description : null,
  }));
  const last = build.progress.at(-1);
  return {
    id: build.id,
    status: build.status,
    rounds: build.rounds,
    draftId: build.draftId,
    name: String(identity.name ?? draft?.name ?? ''),
    provider: String(identity.provider ?? identity.name ?? ''),
    description: typeof identity.description === 'string' ? identity.description : null,
    progress: build.progress,
    form: signIn && (build.status === 'needs_credential' || build.status === 'stuck' || build.status === 'ready' || build.status === 'testing') ? formFor(onConnection(build) ? build.connectionId : build.id, signIn) : null,
    signIn: signIn ? signInKind(signIn) : null,
    signInDocument: signIn ? (JSON.parse(JSON.stringify({ ...signIn, objects: [] })) as Record<string, unknown>) : null,
    objects,
    reason: reason ?? (build.status === 'stuck' || build.status === 'unsupported' ? (last?.text ?? null) : null),
    connectionId: build.connectionId,
    expiresAt: build.expiresAt.toISOString(),
  };
}

async function load(id: string): Promise<Build> {
  const build = await withTransaction((db) => builds.find(db, id));
  if (!build) throw notFound({ message: 'That build does not exist, or has expired. Start again.', code: 'missing.build' });
  return build;
}

type SignInKind = 'key' | 'oauth' | 'agent' | 'none';

/** How the draft signs in, which decides where the credential is given. */
function signInKind(signIn: ManifestV2): SignInKind {
  const t = signIn.transport;
  if ('via' in t && t.via?.agent) return 'agent';
  if (signIn.auth.every((a) => a.strategy === 'none')) return 'none';
  const typed = signIn.auth.some((a) => {
    const parts = a.strategy === 'all_of' ? a.parts : [a];
    return !parts.some((p) => p.strategy === 'oauth2_authorization_code' || p.strategy === 'oauth2_pkce');
  });
  return typed ? 'key' : 'oauth';
}

/** A build that signs in on a connection it made, until it is connected. */
const onConnection = (build: Build): build is Build & { connectionId: string } => build.connectionId !== null && build.status !== 'connected';

/**
 * The sign-in version, and the connection that is signed in on. The name the
 * person gave is used, or the first free one after it.
 */
async function connectFirst(actor: Actor, signIn: ManifestV2): Promise<string> {
  const standIn = { ...signIn.objects[0]!, name: '__sign_in', description: 'Stands in until Silo has finished the connector.', available: false };
  const published = await publishSignIn(actor, { ...signIn, objects: [standIn] as ManifestV2['objects'] });
  for (let n = 1; ; n += 1) {
    const name = n === 1 ? signIn.identity.name : `${signIn.identity.name} (${n})`;
    try {
      return (await connections.create(actor, { manifestId: published.manifestId, name })).connectionId;
    } catch (error) {
      if (!(isAppError(error) && error.code === 'policy.connection_name_taken') || n >= 9) throw error;
    }
  }
}

/**
 * The runtime's view of what the build reads with: its own sealed key, or the
 * connection it signs in on — with the draft's document in place of the
 * connection's, which is exactly how the test panel reads a draft.
 */
async function sourceOf(build: Build, manifest: ManifestV2): Promise<{ connection: LoadedConnection; credential: StoredCredential | undefined }> {
  if (onConnection(build)) {
    const id = build.connectionId;
    const [loaded] = await withTransaction((db) => connectorRepo.load(db, [id]));
    if (!loaded) throw notFound({ message: 'The connection this build signs in on is gone. Start again.', code: 'missing.connection' });
    const credential = (await withTransaction((db) => connectorRepo.credentialsFor(db, [id]))).get(id);
    return { connection: { ...loaded, manifest }, credential };
  }
  return { connection: asConnection(build, manifest), credential: storedOf(build) };
}

/* ── The steps ──────────────────────────────────────────────────────────── */

export async function start(actor: Actor, input: Parameters<typeof ai.draft>[1]): Promise<BuildView> {
  const drafted = await ai.draft(actor, input);
  let document = drafted.draft.document as Doc;
  const progress: ProgressLine[] = [
    line(
      input.sourceKind === 'description'
        ? 'Drafted from your description.'
        : drafted.failedStage
          ? 'Read the documentation. The first draft is incomplete; it will be finished once Silo can read the system.'
          : 'Read the documentation and drafted the connector.',
    ),
  ];

  /*
   * THE SIGN-IN FIRST. Everything else is repaired from what the system
   * answers, and nothing answers until the credential can be asked for — so a
   * draft whose sign-in does not parse is repaired from its schema errors
   * before the person is asked anything.
   */
  let signIn = signInOf(document);
  if (!signIn && model.isConfigured()) {
    const errors = validate(document).errors.map((e) => `${e.path}: ${e.message}`).join('\n');
    try {
      document = await repair(input.sourceUrl ?? null, document, `The draft does not satisfy the connector schema:\n${errors}\nNothing has been read yet: fix how it signs in and how it is reached first.`);
      await withTransaction((db) => drafts.update(db, drafted.draft.id, { document }));
      signIn = signInOf(document);
      progress.push(line('Fixed how it signs in.'));
    } catch (error) {
      log.info({ code: isAppError(error) ? error.code : 'unknown' }, 'A build could not repair its sign-in');
    }
  }

  const kind = signIn ? signInKind(signIn) : null;
  let connectionId: string | null = null;
  if (!signIn) {
    progress.push(line('The AI could not work out how this system signs in. Open the technical view to finish it, or try again with a link to its API documentation.', 'warn'));
  } else if (kind === 'oauth' || kind === 'agent') {
    connectionId = await connectFirst(actor, signIn);
    progress.push(
      line(
        kind === 'agent'
          ? `${signIn.identity.name} is inside your network. Choose the Silo agent that reaches it, then sign in.`
          : `${signIn.identity.name} signs in through its own page. Sign in, and Silo tests it.`,
      ),
    );
  } else if (kind === 'key') {
    progress.push(line(`Waiting for a key to ${signIn.identity.name}, to test it.`));
  }
  const status: builds.BuildStatus = !signIn ? 'stuck' : kind === 'none' ? 'testing' : 'needs_credential';

  const build = await withTransaction((db) =>
    builds.insert(db, {
      id: generateId(),
      organisationId: actor.organisationId,
      draftId: drafted.draft.id,
      createdBy: actor.membershipId,
      status,
      sourceUrl: input.sourceUrl ?? null,
      progress,
      connectionId,
    }),
  );
  return viewOf(build);
}

/**
 * Signed in on the connection — through the consent page, or with a key and
 * the agent chosen — so testing can start.
 */
export async function signedIn(actor: Actor, id: string): Promise<BuildView> {
  const build = await load(id);
  if (!onConnection(build)) throw invalid({ message: 'This build takes its key directly.', code: 'invalid.build_state' });
  if (build.status === 'testing' || build.status === 'ready') return viewOf(build);
  const draft = await withTransaction((db) => drafts.find(db, build.draftId));
  const signIn = signInOf((draft?.document ?? {}) as Doc);
  const name = signIn?.identity.name ?? 'the system';
  const connectionId = build.connectionId;

  const credential = (await withTransaction((db) => connectorRepo.credentialsFor(db, [connectionId]))).get(connectionId);
  if (!credential) throw invalid({ message: `Sign in to ${name} first.`, code: 'invalid.build_not_signed_in' });
  if (signIn && signInKind(signIn) === 'agent' && !(await routeFor(actor.organisationId, connectionId))) {
    throw invalid({ message: 'Choose the agent that reaches it, and confirm the hosts it may reach, first.', code: 'invalid.build_no_agent' });
  }

  await withTransaction((db) => builds.update(db, build.id, { status: 'testing', progress: [...build.progress, line(`Signed in. Testing it against ${name}.`)] }));
  return viewOf(await load(id));
}

export async function get(actor: Actor, id: string): Promise<BuildView> {
  void actor;
  return viewOf(await load(id));
}

/** The credential for the build, sealed; and the settings that say which instance of the system it is. */
export async function giveCredential(
  actor: Actor,
  id: string,
  input: { strategy: string; fields: Record<string, string>; parameters?: Record<string, string> },
): Promise<BuildView> {
  const build = await load(id);
  if (build.status === 'connected' || build.status === 'unsupported') {
    throw invalid({ message: 'This build is not waiting for a credential.', code: 'invalid.build_state' });
  }
  if (onConnection(build)) throw invalid({ message: 'This one is signed in on its connection.', code: 'invalid.build_state' });
  const draft = await withTransaction((db) => drafts.find(db, build.draftId));
  const signIn = signInOf((draft?.document ?? {}) as Doc);
  const alternative = signIn?.auth.find((a) => a.strategy === input.strategy);
  if (!signIn || !alternative) throw invalid({ message: `This connector does not sign in with ${input.strategy}.`, code: 'invalid.strategy_not_declared' });

  const fields = Object.fromEntries(Object.entries(input.fields).filter(([, v]) => v.trim() !== ''));
  const form = formFor(build.id, signIn);
  const asked = form.alternatives.find((a) => a.strategy === input.strategy)?.fields ?? [];
  const missing = asked.filter((f) => !f.optional && !fields[f.name]);
  if (missing.length) throw invalid({ message: `Fill in ${missing.map((f) => f.label).join(', ')}.`, code: 'invalid.credential_fields' });

  const parameters = { ...build.parameters, ...(input.parameters ?? {}) };
  /* Sealed to the build's id, which is what the runtime opens it with. */
  const sealed = await seal(JSON.stringify(fields), wrapper(), `connection:${build.id}`);
  const secret = asked.find((f) => f.secret && fields[f.name]);
  const hint = secret ? fields[secret.name]!.slice(-4) : null;

  await withTransaction(async (db) => {
    await builds.setCredential(db, build.id, { strategy: input.strategy, sealed, parameters });
    await builds.update(db, build.id, {
      status: 'testing',
      progress: [...build.progress, line(`Key received${hint ? ` — it ends ••••${hint}` : ''}. Testing it against ${signIn.identity.name}.`)],
    });
    await writeAudit(db, {
      event: 'credential_sealed',
      organisationId: actor.organisationId,
      membershipId: actor.membershipId,
      userId: null,
      detail: { buildId: build.id, strategy: input.strategy, lastFour: hint, fields: Object.keys(fields).sort() },
    });
  });
  return viewOf(await load(id));
}

/**
 * One round: read everything, and either say it works, repair it, or say what
 * could not be fixed. The client calls this until the build is not `testing`.
 */
export async function advance(actor: Actor, id: string, feedback?: string): Promise<BuildView> {
  const claimed = await withTransaction((db) => builds.claim(db, id, ROUND_SECONDS));
  if (!claimed) return viewOf(await load(id));
  const build = claimed;
  const progress = [...build.progress];
  let paused = false;

  try {
    if (feedback) {
      if (build.status !== 'ready' && build.status !== 'stuck') return viewOf(build);
    } else if (build.status !== 'testing') {
      return viewOf(build);
    }
    const draft = await withTransaction((db) => drafts.find(db, build.draftId));
    if (!draft) throw notFound({ message: 'The draft behind this build is gone. Start again.', code: 'missing.draft' });
    let document = draft.document as Doc;
    if (feedback) progress.push(line(`You said: “${feedback.slice(0, 200)}”. Fixing it.`));

    const signIn = signInOf(document);
    if (!signIn) {
      progress.push(line('The connector no longer says how it signs in. Open the technical view to finish it.', 'warn'));
      await withTransaction((db) => builds.update(db, build.id, { status: 'stuck', progress }));
      return viewOf(await load(id));
    }

    /* ── read ── */
    const raw = await lookAtResponses(actor, build, document, signIn);
    const validation = validate(document);
    const runnable = validation.valid ? executable(document) : null;
    const examined = runnable ? await tryEachObject(actor, build, runnable, raw) : [];
    for (const one of examined) progress.push(line(one.summary, one.ok ? 'ok' : 'warn'));

    await withTransaction((db) =>
      writeAudit(db, {
        event: 'connector_build_tested',
        organisationId: actor.organisationId,
        membershipId: actor.membershipId,
        userId: null,
        detail: { buildId: build.id, round: build.rounds, objectsRead: examined.filter((e) => e.ok).length, objectsFailed: examined.filter((e) => !e.ok).length },
      }),
    );

    const identity = isObject(document.identity) ? document.identity : {};
    const wanted = typeof identity.description === 'string' && identity.description.trim() ? identity.description.trim() : null;
    /* A connector that says how to sign in and reads nothing: there was nothing to try, so nothing to learn from. */
    const nothingToRead = !Array.isArray(document.objects) || document.objects.length === 0;
    /*
     * A REFUSED KEY IS NOT A BROKEN CONNECTOR. Refused on everything, the key
     * is wrong and is asked for again. Refused on some objects while others
     * read, the key lacks a permission: those are left for the person — give
     * the permission, or connect without them — and cost no repair.
     */
    const refused = examined.filter((e) => e.refused);
    const readable = examined.filter((e) => !e.refused);
    if (runnable !== null && examined.length > 0 && readable.length === 0) {
      progress.push(
        line(
          `${signIn.identity.name} refused the key for everything Silo tried. Check it is the right one — and that it has permission to read ${examined.map((e) => labelOf(e.object).toLowerCase()).join(', ')} — then give it again.`,
          'warn',
        ),
      );
      await withTransaction((db) => builds.update(db, build.id, { status: 'needs_credential', progress }));
      return viewOf(await load(id));
    }
    const allRead = runnable !== null && readable.length > 0 && readable.every((e) => e.ok);
    /*
     * ONE TIDY ROUND, IF IT IS CHEAP. Everything reads, but a value is declared
     * twice — `created` beside `created_at` — which reads as two facts to a
     * person and to the compiler. Worth one more round early on; never worth
     * holding back a connector that works.
     */
    const tidy = allRead && !feedback && build.rounds < 2 && examined.some((e) => e.duplicates.length > 0);
    if (allRead && !feedback && !tidy) {
      progress.push(
        refused.length
          ? line(
              `The rest reads. Your key is not allowed to read ${refused.map((e) => labelOf(e.object).toLowerCase()).join(', ')}: give it that permission in ${signIn.identity.name}, or connect without ${refused.length === 1 ? 'it' : 'them'}.`,
              'ok',
            )
          : line(`Everything reads. Check what Silo found in ${signIn.identity.name}.`, 'ok'),
      );
      await withTransaction((db) => builds.update(db, build.id, { status: 'ready', progress }));
      return viewOf(await load(id));
    }

    /*
     * WHAT THE PERSON SAYS ALWAYS GETS A ROUND, and buys two more after it: the
     * round count is set back so that the rounds that follow have room to
     * finish what the feedback started.
     */
    if (!feedback && build.rounds >= MAX_ROUNDS) {
      const failing = readable.filter((e) => !e.ok).map((e) => labelOf(e.object));
      progress.push(
        line(
          nothingToRead
            ? `Silo could not work out what to read in ${signIn.identity.name}. Tell it what you want — for example “contacts, companies and deals” — or open the technical view.`
            : failing.length
              ? `Silo could not get ${failing.join(', ')} to read after ${plural(build.rounds, 'attempt')}. Tell it what is wrong, or open the technical view.`
              : `Silo could not finish this connector after ${plural(build.rounds, 'attempt')}. Tell it what is wrong, or open the technical view.`,
          'warn',
        ),
      );
      await withTransaction((db) => builds.update(db, build.id, { status: 'stuck', progress }));
      return viewOf(await load(id));
    }

    /* ── repair ── */
    const findings = [
      validation.valid ? 'The draft satisfies the connector schema.' : `The draft does not satisfy the connector schema:\n${validation.errors.map((e) => `  ${e.path}: ${e.message}`).join('\n')}`,
      '',
      ...(nothingToRead
        ? [
            'The draft has NO objects, so nothing could be read and there is nothing to learn from yet.',
            wanted
              ? `The person connecting said it should read: "${wanted}".`
              : 'The person connecting did not say what it should read: add the main things this system holds.',
            `Add an object for each thing they named, with the request ${signIn.identity.name}'s API uses to LIST them, where the records are in its answer, their fields and paging.`,
            'Write what you know of this API even where the documentation above does not show it: the next round reads every object with the',
            "customer's credential and shows you exactly what came back, so a wrong guess is corrected — while an object left out is never tried.",
          ]
        : examined.length
          ? [
              ...readable.map((e) => e.finding),
              ...(refused.length
                ? [`These objects were refused for want of a permission the key lacks — leave them as they are: ${refused.map((e) => e.object).join(', ')}.`]
                : []),
            ]
          : [...raw.entries()].map(([name, seen]) => `Object "${name}":\n${seen}`)),
    ].join('\n');
    const failing = readable.filter((e) => !e.ok).map((e) => labelOf(e.object));
    progress.push(
      line(
        nothingToRead
          ? `Working out what to read in ${signIn.identity.name}${wanted ? ` — ${wanted}` : ''}.`
          : failing.length
            ? `Fixing ${failing.join(', ')}.`
            : tidy
              ? 'Everything reads. Tidying fields that repeat each other.'
              : validation.valid
                ? 'Adjusting the connector.'
                : 'Finishing the connector from what the system answered.',
      ),
    );

    /* The documentation only when there is nothing live to go on; after that the system's answers are the better guide. */
    const nothingLive = nothingToRead || examined.length === 0;
    document = nothingLive ? await repair(build.sourceUrl, document, findings, feedback) : await repairWith(undefined, document, findings, feedback);
    const next = feedback ? MAX_ROUNDS - FEEDBACK_ROUNDS : build.rounds + 1;
    await withTransaction(async (db) => {
      await drafts.update(db, build.draftId, { document });
      await builds.update(db, build.id, { status: 'testing', rounds: next, progress });
    });
    return viewOf(await load(id));
  } catch (error) {
    /*
     * THE MODEL SERVICE BEING BUSY IS NOT THE CONNECTOR FAILING. The round is
     * put back and the build waits half a minute, then goes on by itself; only
     * if it stays busy is the person told to come back later. What somebody
     * said is kept for them to send again, never lost to a busy service.
     */
    if (error instanceof ModelBusy) {
      const waits = progress.slice(-BUSY_WAITS * 2).filter((p) => p.text === BUSY_LINE).length;
      if (feedback) {
        progress.push(line('The AI service is busy right now. Send that again in a minute.', 'warn'));
        await withTransaction((db) => builds.update(db, id, { progress }));
      } else if (waits + 1 >= BUSY_WAITS) {
        progress.push(line('The AI service has been busy for a while. Press Try again in a few minutes.', 'warn'));
        await withTransaction((db) => builds.update(db, id, { status: 'stuck', progress }));
      } else {
        progress.push(line(BUSY_LINE));
        await withTransaction(async (db) => {
          await builds.update(db, id, { status: 'testing', progress });
          await builds.pause(db, id, BUSY_SECONDS);
        });
        paused = true;
      }
      return viewOf(await load(id));
    }
    log.info({ buildId: id, code: isAppError(error) ? error.code : 'unknown' }, 'A build round failed');
    const message = isAppError(error) ? error.message : 'Something went wrong while testing.';
    await withTransaction((db) => builds.update(db, id, { status: 'stuck', progress: [...progress, line(message, 'warn')] }));
    return viewOf(await load(id));
  } finally {
    if (!paused) await withTransaction((db) => builds.release(db, id));
  }
}

/**
 * Carry on after stopping — the model service was busy, or the rounds ran out
 * and somebody wants Silo to have another go. Two more rounds, as feedback buys.
 */
export async function retry(actor: Actor, id: string): Promise<BuildView> {
  void actor;
  const build = await load(id);
  if (build.status !== 'stuck') return viewOf(build);
  await withTransaction((db) =>
    builds.update(db, build.id, {
      status: 'testing',
      rounds: Math.min(build.rounds, MAX_ROUNDS - FEEDBACK_ROUNDS),
      progress: [...build.progress, line('Trying again.')],
    }),
  );
  return viewOf(await load(id));
}

/** What the connector reads, as the person's own records — read now, returned, and kept nowhere. */
export async function preview(actor: Actor, id: string): Promise<Preview> {
  const build = await load(id);
  if (build.status !== 'ready') throw invalid({ message: 'This build has not finished testing.', code: 'invalid.build_state' });
  const draft = await withTransaction((db) => drafts.find(db, build.draftId));
  const manifest = executable(draft?.document);
  if (!manifest) throw invalid({ message: 'The connector is not complete.', code: 'invalid.draft_incomplete' });

  const source = await sourceOf(build, manifest);
  const objects = await withConnection({
    actor,
    reason: 'connection-verify',
    ...source,
    use: async (open) => {
      const out: Preview['objects'] = [];
      for (const object of manifest.objects.filter((o) => o.available)) {
        const columns = object.fields.filter((f) => f.type !== 'json').map((f) => ({ name: f.name, label: labelOf(f.name) }));
        try {
          const ctx = await open(object.name);
          const { rows } = await runRead(ctx, { object: object.name, filters: [], sort: [], fields: [], limit: PREVIEW_RECORDS }, { want: PREVIEW_RECORDS });
          /* A column that repeats an earlier one in every record is shown once. */
          const repeated = new Set(rows.length < 2 ? [] : twins(columns.map((c) => c.name), rows).map(([, second]) => second));
          const shown = columns.filter((c) => !repeated.has(c.name));
          out.push({ name: object.name, label: labelOf(object.name), description: object.description ?? null, columns: shown, rows: rows.slice(0, PREVIEW_RECORDS), error: null, refused: false });
        } catch (error) {
          const failure = toResponse(error).body.error;
          const refused = failure.code.startsWith('denial.');
          out.push({
            name: object.name,
            label: labelOf(object.name),
            description: object.description ?? null,
            columns,
            rows: [],
            error: refused ? 'your key is not allowed to read these' : plainly(failure),
            refused,
          });
        }
      }
      return out;
    },
  });

  /* A value the connector exposes as a setting is part of an address, so the key it came from is read for it. */
  const credential =
    build.sealed && build.strategy
      ? await withSecret(
          build.sealed,
          { wrapper: wrapper(), log: credentialAccessLog(actor) },
          { reason: 'connection-verify', subject: build.id, additionalData: `connection:${build.id}` },
          async (plaintext) => ({ strategy: build.strategy!, fields: JSON.parse(plaintext) as Record<string, string> }) satisfies Credential,
        ).catch(() => null)
      : null;
  const pins = await pinsFor(manifest, paramsFor(manifest, source.connection.parameters, credential));
  return { objects, destinations: pins.origins };
}

/**
 * THE BUILD'S TEST READ, ON THE CONNECTION IT BECAME. Every object was read
 * through it moments ago and the person looked at the records; without this
 * the connection's own page said nothing had ever been read, beside a header
 * saying it was healthy. Recorded as the read-only probe it was.
 */
async function recordSample(actor: Actor, connectionId: string, manifest: ManifestV2): Promise<void> {
  const runId = generateId();
  const objectsFound = manifest.objects.filter((o) => o.available).length;
  await withTransaction(async (db) => {
    await probeRuns.record(db, { id: runId, connectionId, stage: 'probe', status: 'passed', findings: { objectsRead: objectsFound, by: 'connector build' }, errors: [], readOnly: true });
    await writeAudit(db, {
      event: 'probe_completed',
      organisationId: actor.organisationId,
      membershipId: actor.membershipId,
      userId: null,
      detail: { connectionId, stage: 'probe', objectsFound, runId },
    });
  });
}

/**
 * The person looked and it is right: publish it, connect it, move the
 * credential across and confirm — every step the one a person connecting by
 * hand takes, in the same services, so nothing here is a second way in.
 */
export async function connect(actor: Actor, id: string, input: { name?: string; without?: string[] }): Promise<{ connectionId: string }> {
  const build = await load(id);
  if (build.status !== 'ready') throw invalid({ message: 'This build has not finished testing.', code: 'invalid.build_state' });
  const draft = await withTransaction((db) => drafts.find(db, build.draftId));
  let manifest = executable(draft?.document);
  if (!manifest) throw invalid({ message: 'The connector is not complete.', code: 'invalid.draft_incomplete' });

  /*
   * CONNECTED WITHOUT WHAT THE KEY MAY NOT READ. Those objects stay in the
   * connector, switched off, so giving the permission later is a switch in the
   * technical view rather than a rebuild — and nothing asks them a question
   * that would only be refused.
   */
  const without = new Set((input.without ?? []).filter((name) => manifest!.objects.some((o) => o.name === name)));
  if (without.size > 0 && draft) {
    const document = draft.document as Doc;
    const objects = (Array.isArray(document.objects) ? document.objects : []).map((o) => (isObject(o) && without.has(String(o.name)) ? { ...o, available: false } : o));
    await withTransaction((db) => drafts.update(db, build.draftId, { document: { ...document, objects } }));
    manifest = executable({ ...document, objects })!;
  }

  const published = await publishDraft(actor, build.draftId);

  if (onConnection(build)) {
    /*
     * THE CONNECTION MOVES ONTO THE FINISHED CONNECTOR by the ordinary adoption:
     * shown what changes, it reads every object with the new version first and
     * moves only if they all read. What was confirmed is what the review showed.
     */
    const connectionId = build.connectionId;
    const shown = await adoption(actor, connectionId, published.manifestId);
    await adopt(actor, connectionId, published.manifestId, { origins: shown.pins.origins, statements: shown.pins.statements });
    await confirmMappings(actor, connectionId);
    await recordSample(actor, connectionId, manifest);
    const widened = await everyField(actor, connectionId);
    await withTransaction(async (db) => {
      await builds.markConnected(db, build.id, connectionId, [...build.progress, ...widened, line('Connected.', 'ok')]);
      await writeAudit(db, {
        event: 'connector_build_connected',
        organisationId: actor.organisationId,
        membershipId: actor.membershipId,
        userId: null,
        detail: { buildId: build.id, connectionId, manifestId: published.manifestId },
      });
    });
    return { connectionId };
  }

  const made = await connections.create(actor, { manifestId: published.manifestId, name: (input.name ?? manifest.identity.name).trim() });
  if (Object.keys(build.parameters).length) await connections.setParameters(actor, { connectionId: made.connectionId, parameters: build.parameters });
  if (build.sealed && build.strategy) {
    await withSecret(
      build.sealed,
      { wrapper: wrapper(), log: credentialAccessLog(actor) },
      { reason: 'connection-verify', subject: build.id, additionalData: `connection:${build.id}` },
      (plaintext) => connections.setCredential(actor, { connectionId: made.connectionId, strategy: build.strategy!, fields: JSON.parse(plaintext) as Record<string, string> }),
    );
  }
  await confirmMappings(actor, made.connectionId);
  await recordSample(actor, made.connectionId, manifest);
  const widened = await everyField(actor, made.connectionId);

  await withTransaction(async (db) => {
    await builds.markConnected(db, build.id, made.connectionId, [...build.progress, ...widened, line(`Connected as ${made.name}.`, 'ok')]);
    await writeAudit(db, {
      event: 'connector_build_connected',
      organisationId: actor.organisationId,
      membershipId: actor.membershipId,
      userId: null,
      detail: { buildId: build.id, connectionId: made.connectionId, manifestId: published.manifestId },
    });
  });
  return { connectionId: made.connectionId };
}

/**
 * Read every field the system holds, once it is connected.
 *
 * A BUILT CONNECTOR READS WHAT ITS SAMPLES SHOWED. HubSpot answers a list with
 * a company's name and domain unless asked for more, so a connector built from
 * that answer reads two fields of 249 — and later tells somebody a field they
 * hold does not exist. Asking the system for its own list as the last step of a
 * build means no connection starts life that way.
 *
 * NEVER THE REASON A BUILD FAILS. The connection works with the fields it was
 * tested on; not widening it is said in its progress, and the connection's page
 * offers it again.
 */
async function everyField(actor: Actor, connectionId: string): Promise<ProgressLine[]> {
  try {
    const outcome = await readEveryField(actor, connectionId);
    const widened = outcome.objects.filter((one) => one.after > one.before);
    return widened.length
      ? [line(`Reads every field the system lists: ${widened.map((one) => `${one.after} for ${one.object}`).join(', ')}.`, 'ok')]
      : [];
  } catch (error) {
    log.info({ err: error, connectionId }, 'Could not read every field after connecting');
    return [line('Could not read every field the system lists yet; its page offers to try again.', 'warn')];
  }
}
