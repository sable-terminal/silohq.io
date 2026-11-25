// Who is calling, and on whose behalf, on the service listener (spec 7.1, 64.3).
//
// The caller: its mTLS identity, spiffe://<cell id>/service/<name>, which the contract
// must list. A process hosting several services carries one identity per service in its
// certificate, and the caller is the one the contract lists; a certificate names one cell,
// which must be this cell except on a global-tier route. Without TLS, in development and
// tests only, a header names the caller.
//
// On whose behalf: the identity headers the contract requires, each a lowercase UUID, set
// with SET LOCAL by inTransaction for row-level security. A request acts as one
// membership or one service principal, never both. Only the admin portal names a member
// of staff: from any other caller that header is dropped, so a request a service passes on
// never carries staff authority further.

import type { Request, RequestHandler } from 'express';
import type { TLSSocket } from 'node:tls';
import { isGlobalService, SERVICES, type ServiceName } from '../config/service.config.ts';
import { CONTEXT_HEADERS, DEV_CALLER_CELL_HEADER, DEV_CALLER_HEADER, type AnyContract } from '../contracts/endpoint.contract.ts';
import type { RequestContext } from '../infra/postgres.infra.ts';
import { AppError } from '../utils/errors.util.ts';
import { isUuid } from '../utils/id.util.ts';
import { localsOf } from './request.middleware.ts';

const IDENTITY = /^URI:spiffe:\/\/([a-z0-9]+(?:-[a-z0-9]+)*)\/service\/([a-z][a-z0-9-]*)$/;
const CELL = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const isService = (name: string): name is ServiceName => (SERVICES as readonly string[]).includes(name);

function callersOf(req: Request, contract: AnyContract, tls: boolean, cellId: string): { cell: string; names: ServiceName[] } {
  const anyCell = isGlobalService(contract.service);
  if (tls) {
    const socket = req.socket as TLSSocket;
    if (!socket.authorized) {
      throw new AppError('unauthenticated', 'a client certificate issued in this cell is required', { code: 'caller.no_certificate' });
    }
    const found = (socket.getPeerCertificate().subjectaltname ?? '').split(/,\s*/)
      .map((entry) => IDENTITY.exec(entry))
      .filter((match): match is RegExpExecArray => match !== null && isService(match[2]!))
      .map((match) => ({ cell: match[1]!, name: match[2] as ServiceName }));
    const cells = new Set(found.map((entry) => entry.cell));
    const cell = cells.size === 1 ? [...cells][0]! : undefined;
    if (cell === undefined || (!anyCell && cell !== cellId)) {
      throw new AppError('unauthenticated', 'the client certificate names no service of this cell', { code: 'caller.unknown_identity' });
    }
    return { cell, names: found.map((entry) => entry.name) };
  }
  const named = req.headers[DEV_CALLER_HEADER];
  if (typeof named !== 'string' || !isService(named)) {
    throw new AppError('unauthenticated', `name the calling service in ${DEV_CALLER_HEADER}`, { code: 'caller.unnamed' });
  }
  const cellHeader = req.headers[DEV_CALLER_CELL_HEADER];
  const cell = typeof cellHeader === 'string' ? cellHeader : cellId;
  if (!CELL.test(cell) || (!anyCell && cell !== cellId)) {
    throw new AppError('unauthenticated', 'the caller names no service of this cell', { code: 'caller.unknown_identity' });
  }
  return { cell, names: [named] };
}

export function callerIdentity(contract: AnyContract, options: { tls: boolean; cellId: string }): RequestHandler {
  return (req, res, next) => {
    const locals = localsOf(res);
    const identities = callersOf(req, contract, options.tls, options.cellId);
    locals.callerCell = identities.cell;
    const caller = identities.names.find((name) => contract.callers.includes(name));
    if (caller === undefined) {
      throw new AppError('forbidden', `${identities.names.join(', ')} is not a listed caller of ${contract.id} (spec 7.1)`, {
        code: 'caller.not_listed', details: { caller: identities.names.join(',') },
      });
    }
    locals.caller = caller;
    locals.log = locals.log.child({ caller });
    next();
  };
}

function contextOf(req: Request, contract: AnyContract): RequestContext {
  const context: RequestContext = {};
  for (const [field, header] of Object.entries(CONTEXT_HEADERS) as [keyof RequestContext, string][]) {
    const value = req.headers[header];
    if (value === undefined) continue;
    if (typeof value !== 'string' || !isUuid(value)) {
      throw new AppError('validation', `${header} must be a lowercase UUID`, { code: 'context.invalid' });
    }
    context[field] = value;
  }
  if (contract.context === 'none') return {};
  if (contract.context === 'organisation') {
    if (context.organisationId === undefined) {
      throw new AppError('validation', `${contract.id} runs in an organisation: send ${CONTEXT_HEADERS.organisationId}`, {
        code: 'context.organisation_missing',
      });
    }
    if (context.membershipId !== undefined && context.servicePrincipalId !== undefined) {
      throw new AppError('validation', 'a request acts as one membership or one service principal, not both', { code: 'context.two_actors' });
    }
  }
  if (contract.context === 'user' && context.userId === undefined) {
    throw new AppError('validation', `${contract.id} is for a person: send ${CONTEXT_HEADERS.userId}`, { code: 'context.user_missing' });
  }
  return context;
}

export function requestContext(contract: AnyContract): RequestHandler {
  return (req, res, next) => {
    const locals = localsOf(res);
    const request = contextOf(req, contract);
    if (request.operatorId !== undefined && locals.caller !== 'admin-portal') delete request.operatorId;
    locals.request = request;
    locals.log = locals.log.child({
      ...(request.organisationId ? { organisationId: request.organisationId } : {}),
      ...(request.membershipId ? { membershipId: request.membershipId } : {}),
    });
    next();
  };
}
