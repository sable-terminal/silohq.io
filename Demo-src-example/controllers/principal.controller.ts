import type { Request, Response } from 'express';
import * as principalService from '../services/principal.service';
import { actorOf } from '../middleware/authorise.middleware';
import { body, params } from '../middleware/validate.middleware';
import type { ApiKey, ServicePrincipal } from '../repos/principal.repo';
import { leafIdOf } from '../utils/path.util';

const presentPrincipal = (principal: ServicePrincipal) => ({
  id: principal.id,
  name: principal.name,
  description: principal.description,
  createdBy: principal.createdBy,
  disabled: principal.disabledAt !== null,
  createdAt: principal.createdAt.toISOString(),
});

/**
 * A key as an administrator sees it.
 *
 * NO TOKEN AND NO HASH. The plaintext exists once, in the response to the call
 * that created it; a list that returned it would make every administrator's
 * session a way to take one, and nobody notices a machine credential being used
 * by the wrong machine.
 */
const presentKey = (key: ApiKey) => ({
  id: key.id,
  name: key.name,
  // Recognition only — this is how somebody tells which key is in which
  // deployment. Four characters of a 32-byte secret narrows nothing.
  lastFour: key.lastFour,
  expiresAt: key.expiresAt.toISOString(),
  revokedAt: key.revokedAt?.toISOString() ?? null,
  lastUsedAt: key.lastUsedAt?.toISOString() ?? null,
  createdAt: key.createdAt.toISOString(),
});

export async function list(req: Request, res: Response): Promise<void> {
  const entries = await principalService.list(actorOf(req));
  res.status(200).json({
    principals: entries.map(({ principal, keys }) => ({
      ...presentPrincipal(principal),
      keys: keys.map(presentKey),
    })),
  });
}

export async function create(req: Request, res: Response): Promise<void> {
  const input = body<{ name: string; description?: string | null }>(req);
  const principal = await principalService.create(actorOf(req), input);
  res.status(201).json({ principal: presentPrincipal(principal) });
}

export async function setDisabled(req: Request, res: Response): Promise<void> {
  const { principalId } = params<{ principalId: string }>(req);
  const { disabled } = body<{ disabled: boolean }>(req);
  const principal = await principalService.setDisabled(actorOf(req), principalId, disabled);
  res.status(200).json({ principal: presentPrincipal(principal) });
}

export async function issueKey(req: Request, res: Response): Promise<void> {
  const { principalId } = params<{ principalId: string }>(req);
  const { name, expiresInDays } = body<{ name: string; expiresInDays: number }>(req);

  const { key, token } = await principalService.issueKey(actorOf(req), {
    principalId,
    name,
    expiresInDays,
  });

  res.status(201).json({
    key: presentKey(key),
    /*
     * THE ONE AND ONLY TIME THIS IS RETURNED, and the message says so because a
     * caller who does not save it has to create another key — there is no
     * recovery, by design.
     */
    token,
    warning: 'Save this key now. It cannot be shown again.',
  });
}

export async function revokeKey(req: Request, res: Response): Promise<void> {
  const { keyId } = params<{ keyId: string }>(req);
  await principalService.revokeKey(actorOf(req), keyId);
  res.status(204).end();
}

/**
 * What a key is, and what it may do.
 *
 * THE MACHINE EQUIVALENT OF `/auth/me`, and the first thing anybody integrating
 * will call. It is also how somebody checks a key works without having to find
 * an endpoint that changes something.
 */
export async function me(req: Request, res: Response): Promise<void> {
  const principal = req.principal!;
  res.status(200).json({
    principalId: principal.principalId,
    organisationId: principal.organisationId,
    permissions: [...principal.authority.permissions].sort(),
    /*
     * `leafIdOf`, NOT `.slice(1)`. Stripping the prefix by hand leaves the
     * dashes out and produces a 32-character string that looks like a uuid,
     * typechecks as a string all the way to the caller, and compares unequal to
     * the id it came from. Exactly the bug `present.ts` already had.
     */
    scopeIds: principal.authority.adminPaths.map(leafIdOf),
  });
}
