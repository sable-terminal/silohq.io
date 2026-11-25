// The SOAP protocol engine (docs/siloServiceCatalogue.doc.md; spec 14.4, 14.5). Generic: the
// manifest names the operation, its namespace and declared parameters, where the records sit
// under the Body and how a page leads to the next; the engine builds the envelope (see
// envelope.protocol.ts), sends it through the credential service, which places the secret at
// the HTTP level, and reads the records. Pushdown and paging set parameters only, never the
// envelope's structure, so a value is only ever escaped element text.
//
// A SOAP 1.1 fault comes with 500 whoever is at fault, so the Fault's code decides before
// HTTP's meaning does (after the manifest's own rules), except that 401, 403 and 429 mean
// what they say. Rows past the step's bound and pages past the manifest's are refused,
// never truncated. An expired token is refreshed once, under the OAuth lock. WS-Security's
// UsernameToken travels in the envelope's header, placed by the credential service on the
// way out (credential/wsSecurity.service.ts); the runtime never holds the password.

import type { PreparedRequest } from '../../../../contracts/credential/connectionCredential.contract.ts';
import type { ErrorMeaning, ManifestObject, RequestPatch, SoapSource } from '../../../../contracts/connect/manifest.contract.ts';
import { AppError, isAppError } from '../../../../utils/errors.util.ts';
import { compileExpression } from '../../../expression-evaluator/evaluator.service.ts';
import { restPatches } from '../../../pushdown-compiler/compile.service.ts';
import {
  checkDeadline, classify, coerce, getPath, limited, rowsBound, SourceError, withRetries, type ErrorInput, type ProtocolEngine, type ReadContext, type Row,
} from '../../engine.service.ts';
import { expandPath } from '../graphql/graphql.protocol.ts';
import { recordsAt } from '../graphql/query.protocol.ts';
import { httpStandard } from '../rest/rest.protocol.ts';
import { buildEnvelope, faultOf, framing, readEnvelope, type SoapVersion } from './envelope.protocol.ts';

/** 401, 403 and 429 by HTTP; then a Fault by its code; then HTTP's meaning. */
export function soapStandard(input: ErrorInput): ErrorMeaning | undefined {
  if (input.status === 401 || input.status === 403 || input.status === 429) return httpStandard(input);
  return faultOf(input.body) ?? httpStandard(input);
}

/** Applies the parameters of a patch; anything else in it is a manifest fault. Only declared parameters may be set. */
export function applyParameters(source: Pick<SoapSource, 'parameters'>, values: Record<string, unknown>, patch: RequestPatch): Record<string, unknown> {
  if (patch.path !== undefined || patch.query !== undefined || patch.headers !== undefined || patch.body !== undefined) {
    throw new AppError('integrity', 'a SOAP patch sets parameters only', { code: 'soap.patch_not_parameters' });
  }
  const declared = new Set(source.parameters.map((p) => p.name));
  const next = { ...values };
  for (const [name, value] of Object.entries(patch.variables ?? {})) {
    if (!declared.has(name)) throw new AppError('integrity', 'a patch sets a parameter the operation does not declare', { code: 'soap.parameter_undeclared', details: { parameter: name } });
    if (value === null) delete next[name];
    else next[name] = value;
  }
  return next;
}

export async function sendOnce(ctx: ReadContext, version: SoapVersion, source: Pick<SoapSource, 'action'>, path: string, envelope: string)
  : Promise<{ status: number; headers: Record<string, string>; body: Record<string, unknown> }> {
  const { contentType, headers } = framing(version, source.action);
  const prepared: PreparedRequest = { method: 'POST', path, query: {}, headers, xml: { text: envelope, contentType } };
  let refreshed = false;
  for (;;) {
    checkDeadline(ctx);
    let response;
    try {
      response = await limited(ctx, () => ctx.send(prepared));
    } catch (error) {
      if (isAppError(error) && error.code === 'credential.token_expired' && !refreshed) {
        refreshed = true;
        await ctx.refresh();
        continue;
      }
      throw error;
    }
    let body: Record<string, unknown> = {};
    if (response.body.trim() !== '') {
      try {
        body = readEnvelope(response.body);
      } catch (error) {
        // A failure answered with a page that is not SOAP is classified by its status; success must be SOAP.
        if (response.status >= 200 && response.status < 300) throw error;
      }
    }
    const error = await classify(ctx.manifest, { status: response.status, headers: response.headers, body, sqlstate: '' }, soapStandard, ctx.now);
    if (error === undefined) return { status: response.status, headers: response.headers, body };
    if (error.meaning === 'auth' && !refreshed && ctx.manifest.auth.strategy.startsWith('oauth2_')) {
      refreshed = true;
      await ctx.refresh();
      continue;
    }
    throw new SourceError(error.meaning, { status: response.status }, error.retryAfterMs);
  }
}

export const soapEngine: ProtocolEngine = {
  async read(ctx, object: ManifestObject, native, fields) {
    if (object.source.kind !== 'soap' || ctx.manifest.protocol.kind !== 'soap') {
      throw new AppError('integrity', 'a SOAP object has a SOAP source', { code: 'manifest.source_kind' });
    }
    const source = object.source;
    const version = ctx.manifest.protocol.version;
    const path = expandPath(source.path, ctx.params);
    let values: Record<string, unknown> = { ...source.constants };
    for (const patch of await restPatches(object, native, ctx.params, ctx.now)) values = applyParameters(source, values, patch);
    const next = source.paging === undefined ? undefined : compileExpression('paging.next', 'cel', source.paging.next.cel);
    const maxPages = source.paging?.maxPages ?? 1;
    const rows: Row[] = [];

    for (let page = 1; ; page++) {
      const sent = values;
      const envelope = buildEnvelope(version, source, sent);
      const response = await withRetries(ctx, () => sendOnce(ctx, version, source, path, envelope));
      ctx.stats.pages += 1;
      const records = recordsAt(response.body, source.recordPath);
      ctx.stats.sourceRows += records.length;
      for (const record of records) {
        const row: Row = {};
        for (const field of fields) row[field.name] = coerce(getPath(record, field.path ?? field.name), field.type, ctx.stats);
        rows.push(row);
      }
      if (native.limit !== null && rows.length >= native.limit) return rows.slice(0, native.limit);
      if (rows.length > ctx.maxRows) throw rowsBound(ctx);
      if (next === undefined) return rows;
      const patch = await next.evaluate({
        request: { variables: sent },
        response: { status: response.status, headers: response.headers, body: response.body },
        page: { number: page, records: records.length, received: rows.length },
        links: {},
        params: ctx.params,
      }, ctx.now) as RequestPatch | null;
      if (patch === null) return rows;
      if (page >= maxPages) {
        throw new AppError('bounds', 'the source has more pages than the manifest allows one read; refused rather than returned in part', {
          code: 'connect.max_pages', details: { bound: 'max_pages', limit: maxPages },
        });
      }
      values = applyParameters(source, values, patch);
    }
  },
};
