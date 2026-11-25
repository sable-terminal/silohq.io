import * as model from '../infra/model.infra';
import * as tokens from './tokens.service';
import { ModelUnavailable } from '../infra/model.infra';
import { request, HttpError } from '../infra/httpClient.infra';
import { invalid, refusal } from '../utils/error.util';
import { childLogger } from '../config/logger.config';
import { createDraft, validate } from './connectorBuilder.service';
import { compileOpenApi } from '../engine/compile/openapi.compile';
import { compileGraphql, introspectionOf } from '../engine/compile/graphql.compile';
import { compileWsdl } from '../engine/compile/wsdl.compile';
import type { Compiled } from '../engine/compile/shared.compile';
import type { Actor } from './scope.service';
import type { Draft } from '../repos/connectorDraft.repo';
import type { Validation } from './connectorBuilder.service';

const log = childLogger('connector-ai');

/**
 * Route 2 — the AI builder.
 *
 * §5's STAGES, AND WHERE EACH ONE LIVES:
 *
 *   Parse            here. Model output, Zod-validated, REJECTED on schema
 *                    failure rather than repaired.
 *   Probe            `connectorProbe.service`, once a connection exists.
 *   Reconcile        `connectorHeal.service` — comparing declared against
 *                    observed is the same comparison self-heal makes weekly.
 *   Propose mapping  not built. The ontology it maps to does not exist yet.
 *   Confirm          `connectorBuilder.service`, which is the visual builder.
 *   Verify           `connectorVerify.service`.
 *
 * IT ALWAYS PRODUCES A DRAFT, NEVER A CONNECTOR. Even a parse that validates
 * perfectly lands in the builder, because §5's escape hatch is not a failure
 * path — "a half-built AI connector opens here rather than being discarded" is
 * how the route stays useful when it goes wrong, and it will.
 *
 * FAILURE IS HONEST. Where the model returns nothing usable, this names the
 * stage that failed and stores what it got. It never emits a manifest it could
 * not parse.
 */

export type SourceKind = 'openapi' | 'graphql' | 'wsdl' | 'documentation' | 'description';

export interface DraftedConnector {
  draft: Draft;
  validation: Validation;
  /** Which stage stopped, when one did. */
  failedStage: 'parse' | null;
  /** What the model actually said, when it could not be used. */
  modelNote: string | null;
  inputTokens: number;
  outputTokens: number;
}

const MAX_SOURCE_CHARS = 400_000;

/**
 * Fetch a specification the customer pointed at.
 *
 * THROUGH THE GUARDED CLIENT, because the URL is typed by a customer and is the
 * same SSRF surface every other customer-supplied URL is. An OpenAPI document at
 * `http://169.254.169.254/` is a URL somebody can enter.
 */
export async function fetchSource(url: string): Promise<string> {
  let response;
  try {
    response = await request(url, { headers: { accept: 'application/json, text/plain, */*' } });
  } catch (error) {
    /*
     * THE GUARD'S REFUSAL HAS TO BECOME AN ANSWER. `HttpError` is not part of the
     * error taxonomy, so letting it escape turns a deliberate, correct refusal
     * into a 500 — which tells the person Silo is broken rather than that the
     * address they typed is not one Silo will fetch.
     */
    if (error instanceof HttpError && error.kind === 'blocked') {
      throw refusal({ message: error.message, code: 'refusal.blocked_host' });
    }
    throw invalid({
      message: 'That address could not be reached. Check the link, or paste the document instead.',
      code: 'invalid.specification_unreachable',
    });
  }

  if (response.status < 200 || response.status >= 300) {
    throw invalid({
      message: `That address returned ${response.status}. Check the link, or paste the document instead.`,
      code: 'invalid.specification_unreachable',
    });
  }

  if (response.body.length > MAX_SOURCE_CHARS) {
    /*
     * TRUNCATED IN THE MIDDLE WOULD BE WORSE THAN REFUSED. A specification cut
     * off halfway produces a manifest describing the first half of a system,
     * which looks complete and is missing objects nobody will think to look for.
     */
    throw invalid({
      message:
        'That specification is too large to draft from in one go. Point at a single service, ' +
        'or build it in the visual builder.',
      code: 'invalid.specification_too_large',
    });
  }

  return response.body;
}

export async function draft(
  actor: Actor,
  input: {
    name: string;
    sourceKind: SourceKind;
    /** What it reads, in the builder's words. */
    description?: string;
    /** One of these two. A URL is fetched; text is used as given. */
    sourceUrl?: string;
    sourceText?: string;
    baseUrl?: string;
    transportHint?: string;
  },
): Promise<DraftedConnector> {
  if (!input.sourceUrl && !input.sourceText) {
    throw invalid({
      message: 'Give a link to the specification, or paste it.',
      code: 'invalid.no_source',
    });
  }

  const source = input.sourceText ?? (await fetchSource(input.sourceUrl!));

  /*
   * COMPILERS FIRST, THE MODEL SECOND (MANIFEST-V2 WP10). A specification says
   * exactly what a model would be asked to read out of it, so where one
   * compiles it is compiled: deterministic, free, and the same every time. The
   * model is for documentation that is prose, and for a specification that
   * compiles to nothing.
   */
  const compiled = compileSpecification(input, source);
  if (compiled) {
    const document = compiled.document;
    if (input.description) document.identity = { ...(document.identity as Record<string, unknown>), description: input.description };
    const draftRow = await createDraft(actor, { name: input.name, document, sourceRoute: 'ai', failedStage: null });
    return { draft: draftRow, validation: validate(draftRow.document), failedStage: null, modelNote: null, inputTokens: 0, outputTokens: 0 };
  }

  if (!model.isConfigured()) {
    throw refusal({
      message: 'The AI builder is not available in this deployment. Use the visual builder.',
      code: 'refusal.model_unavailable',
    });
  }

  /* Billing §4 — six tokens, refused before the model runs and charged once it answers. */
  await tokens.afford(actor, 'connector_generation');

  let result;
  try {
    result = await model.draftManifest({
      source: source.slice(0, MAX_SOURCE_CHARS),
      sourceKind: input.sourceKind,
      baseUrl: input.baseUrl,
      transportHint: input.transportHint,
    });
  } catch (error: unknown) {
    /*
     * THE SAME ANSWER AS AN UNCONFIGURED DEPLOYMENT, because it is the same fact
     * from the user's side: there is no AI builder here, use the visual one.
     * `isConfigured` cannot see this — credentials are a network call away — so
     * the check at the top of this function passes and this is where it surfaces.
     */
    if (error instanceof ModelUnavailable) {
      throw refusal({
        message: 'The AI builder is not available in this deployment. Use the visual builder.',
        code: 'refusal.model_unavailable',
        detail: { reason: error.reason },
      });
    }
    throw error;
  }

  /*
   * A MODEL THAT DECLINED IS NOT AN ERROR. It is a stage that failed, and §5
   * says the builder names it — the draft is created anyway so the person has
   * somewhere to continue from rather than an apology and a blank screen.
   */
  if (!result.ok || !result.raw) {
    return finish(actor, input.name, {}, 'parse', result.refusal ?? 'The model returned nothing.', result);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(result.raw);
  } catch {
    log.info({ length: result.raw.length }, 'Model returned unparseable JSON for a connector');
    return finish(actor, input.name, {}, 'parse', 'The model did not return a usable document.', result);
  }

  /*
   * VALIDATED, AND NOT REPAIRED. §5 is explicit: "rejected on schema failure
   * rather than repaired". A document patched into validity here is a connector
   * nobody wrote and nobody reviewed, and its author would have no way to find
   * out what was changed on their behalf.
   *
   * IT STILL BECOMES A DRAFT. Rejected means not accepted as a manifest, not
   * thrown away — a document that is ninety per cent right is most of a
   * connector, and the builder is where the rest is done.
   */
  const document = parsed as Record<string, unknown>;

  /*
   * THE BUILDER'S DESCRIPTION WINS OVER THE MODEL'S. A person saying "our
   * warehouse — orders, shipments, stock" knows something the specification
   * does not, and it is the sentence the compiler will read when it has to
   * choose between two connectors. Written on rather than merged, because the
   * model was never asked for one.
   */
  if (input.description) {
    const identity = (document.identity ?? {}) as Record<string, unknown>;
    document.identity = { ...identity, description: input.description };
  }
  const check = validate(document);

  return finish(
    actor,
    input.name,
    document,
    check.valid ? null : 'parse',
    check.valid ? null : 'The draft does not yet satisfy the connector schema.',
    result,
  );
}

/** A specification compiled, with its notes written into the draft, or null to hand it to the model. */
function compileSpecification(input: { sourceKind: SourceKind; sourceUrl?: string; baseUrl?: string; name: string }, source: string): { document: Record<string, unknown> } | null {
  try {
    let compiled: Compiled | null = null;
    let from: 'openapi' | 'graphql' | 'wsdl' = 'openapi';
    if (input.sourceKind === 'openapi') {
      compiled = compileOpenApi(source, { name: input.name, specUrl: input.sourceUrl, baseUrl: input.baseUrl });
    } else if (input.sourceKind === 'graphql') {
      const endpoint = input.baseUrl ?? input.sourceUrl;
      if (!endpoint) return null;
      from = 'graphql';
      compiled = compileGraphql(introspectionOf(source), { endpoint, name: input.name });
    } else if (input.sourceKind === 'wsdl') {
      from = 'wsdl';
      compiled = compileWsdl(source, { name: input.name, wsdlUrl: input.sourceUrl, endpoint: input.baseUrl });
    }
    if (!compiled || (compiled.document.objects as unknown[]).length === 0) return null;
    return { document: { ...compiled.document, authoring: { from, notes: compiled.notes.slice(0, 100).map((n) => n.slice(0, 500)) } } };
  } catch (error) {
    log.info({ err: error, sourceKind: input.sourceKind }, 'The specification did not compile; the model will read it');
    return null;
  }
}

async function finish(
  actor: Actor,
  name: string,
  document: Record<string, unknown>,
  failedStage: 'parse' | null,
  modelNote: string | null,
  usage: { inputTokens: number; outputTokens: number },
): Promise<DraftedConnector> {
  /*
   * Billing §4 — CHARGED WHEN THE MODEL ANSWERED, whatever the answer was worth.
   * A draft that failed the schema is still a draft to continue from and still
   * cost a model call; a model that declined outright produced nothing and is a
   * refusal, which §4 never bills.
   */
  if (usage.outputTokens > 0) await tokens.spend(actor, 'connector_generation');

  const draftRow = await createDraft(actor, {
    name,
    document,
    sourceRoute: 'ai',
    failedStage,
  });

  return {
    draft: draftRow,
    validation: validate(draftRow.document),
    failedStage,
    modelNote,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
  };
}
