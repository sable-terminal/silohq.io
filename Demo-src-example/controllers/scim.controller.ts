import type { Request, Response } from 'express';
import * as scim from '../services/scim.service';
import { scimError } from '../middleware/scim.middleware';
import { isAppError } from '../utils/error.util';
import { actorOf } from '../middleware/authorise.middleware';
import { body, params } from '../middleware/validate.middleware';

/**
 * §1 — the SCIM 2.0 surface an identity provider talks to.
 *
 * ── IT SPEAKS SCIM, NOT THIS PRODUCT'S API ─────────────────────────────────
 *
 * The shapes here are RFC 7643's, down to the `schemas` array and the casing of
 * `Resources`. Entra and Okta are the clients and they parse what the standard
 * says; a response that was merely close would fail in their UI as an opaque
 * sync error with nothing to act on.
 *
 * THE ERRORS ARE SCIM-SHAPED TOO, for the same reason — see `scimError`.
 */

const USER_SCHEMA = 'urn:ietf:params:scim:schemas:core:2.0:User';
const GROUP_SCHEMA = 'urn:ietf:params:scim:schemas:core:2.0:Group';
const LIST_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:ListResponse';

const organisationOf = (req: Request) => req.scim!.organisationId;

/** Anything this layer throws becomes a SCIM error rather than the app envelope. */
async function answering(res: Response, run: () => Promise<void>): Promise<void> {
  try {
    await run();
  } catch (error: unknown) {
    if (isAppError(error)) {
      const status = error.kind === 'denial' ? 403 : error.kind === 'invalid' ? 400 : 404;
      scimError(res, status, error.message);
      return;
    }
    scimError(res, 500, 'That could not be completed.');
  }
}

/* ── What a provider fetches before it does anything ─────────────────────── */

/**
 * The capabilities document, which is the first thing a directory asks for.
 *
 * ENTRA AND OKTA BOTH FETCH THIS DURING SETUP. A 404 here is a directory that
 * cannot be connected at all — the failure happens before provisioning is ever
 * attempted, and it appears in their interface as an opaque error with nothing
 * to act on.
 *
 * IT DECLARES WHAT IS TRUE, NOT WHAT IS FLATTERING. `patch` is supported and
 * `bulk` is not; saying otherwise would make a provider send something that
 * then fails per-request, which is a worse failure than being told up front.
 */
export function serviceProviderConfig(_req: Request, res: Response): void {
  res.status(200).json({
    schemas: ['urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig'],
    documentationUri: 'https://silohq.io/docs/scim',
    patch: { supported: true },
    bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
    filter: { supported: true, maxResults: 200 },
    changePassword: { supported: false },
    sort: { supported: false },
    etag: { supported: false },
    /* The customer generates a token here and pastes it there. */
    authenticationSchemes: [
      {
        type: 'oauthbearertoken',
        name: 'OAuth Bearer Token',
        description: 'A token issued in Silo and configured in the identity provider.',
        primary: true,
      },
    ],
    meta: { resourceType: 'ServiceProviderConfig' },
  });
}

export function resourceTypes(_req: Request, res: Response): void {
  const type = (name: string, schema: string) => ({
    schemas: ['urn:ietf:params:scim:schemas:core:2.0:ResourceType'],
    id: name,
    name,
    endpoint: `/${name}s`,
    schema,
    meta: { resourceType: 'ResourceType' },
  });

  res.status(200).json({
    schemas: [LIST_SCHEMA],
    totalResults: 2,
    startIndex: 1,
    itemsPerPage: 2,
    Resources: [type('User', USER_SCHEMA), type('Group', GROUP_SCHEMA)],
  });
}

export function schemas(_req: Request, res: Response): void {
  res.status(200).json({
    schemas: [LIST_SCHEMA],
    totalResults: 2,
    startIndex: 1,
    itemsPerPage: 2,
    Resources: [
      { id: USER_SCHEMA, name: 'User', description: 'A person.' },
      { id: GROUP_SCHEMA, name: 'Group', description: 'A directory group.' },
    ],
  });
}

/* ── Users ───────────────────────────────────────────────────────────────── */

/**
 * The read a provider makes BEFORE it creates anybody.
 *
 * WITHOUT THIS, EVERY SYNC MAKES DUPLICATES — or fails outright. Okta and Entra
 * both look a person up by `userName` first precisely so that a second sync does
 * not create a second account.
 *
 * AN UNRECOGNISED FILTER RETURNS EVERYBODY, NOT NOBODY. A provider reads an
 * empty result as "create one"; answering emptily to a filter this does not
 * parse would manufacture the duplicates the read exists to prevent.
 */
export async function listUsers(req: Request, res: Response): Promise<void> {
  await answering(res, async () => {
    const filter = typeof req.query.filter === 'string' ? req.query.filter : undefined;
    const people = await scim.listUsers(organisationOf(req), filter);

    res.status(200).json({
      schemas: [LIST_SCHEMA],
      totalResults: people.length,
      startIndex: 1,
      itemsPerPage: people.length,
      Resources: people.map(resourceFor),
    });
  });
}

export async function getUser(req: Request, res: Response): Promise<void> {
  await answering(res, async () => {
    const person = await scim.findUser(organisationOf(req), String(req.params.id));

    if (!person) {
      scimError(res, 404, 'No such user.');
      return;
    }

    res.status(200).json(resourceFor(person));
  });
}

const resourceFor = (person: {
  membershipId: string;
  email: string;
  firstName: string;
  lastName: string;
  active: boolean;
}) => ({
  schemas: [USER_SCHEMA],
  id: person.membershipId,
  userName: person.email,
  name: { givenName: person.firstName, familyName: person.lastName },
  emails: [{ value: person.email, primary: true }],
  active: person.active,
  meta: { resourceType: 'User' },
});

/**
 * Create a person, or return the one already there.
 *
 * 200 RATHER THAN 409 ON A REPEAT. Providers re-send, and a conflict makes a
 * sync look broken when nothing is wrong — the account exists, which is what
 * was being asked for.
 */
export async function createUser(req: Request, res: Response): Promise<void> {
  await answering(res, async () => {
    const body = req.body as {
      externalId?: string;
      userName?: string;
      name?: { givenName?: string; familyName?: string };
      emails?: Array<{ value?: string; primary?: boolean }>;
      active?: boolean;
    };

    const email = body.userName ?? body.emails?.find((one) => one.primary)?.value ?? body.emails?.[0]?.value;

    if (!email) {
      scimError(res, 400, 'userName is required.', 'invalidValue');
      return;
    }

    const { membershipId, created } = await scim.provisionUser(organisationOf(req), {
      externalId: body.externalId ?? email,
      email,
      firstName: body.name?.givenName ?? '',
      lastName: body.name?.familyName ?? '',
      active: body.active ?? true,
    });

    res.status(created ? 201 : 200).json(userResource(membershipId, email, body, true));
  });
}

/**
 * Deactivate, which is the whole point of SCIM.
 *
 * `active: false` IS THE ONE THAT MATTERS. Everything else a PATCH may carry is
 * a name change; this is somebody leaving, and it is the reason an enterprise
 * will not buy without this endpoint.
 */
export async function patchUser(req: Request, res: Response): Promise<void> {
  await answering(res, async () => {
    const body = req.body as {
      Operations?: Array<{ op?: string; path?: string; value?: unknown }>;
      active?: boolean;
    };

    const membershipId = String(req.params.id);

    /*
     * BOTH SHAPES, BECAUSE BOTH ARRIVE. Okta sends a PATCH with `Operations`;
     * some providers send the attribute directly. Reading only one of them
     * means deprovisioning silently does nothing for half the market.
     */
    const fromOperations = body.Operations?.map((one) => {
      if (typeof one.value === 'boolean' && (one.path === 'active' || one.path === undefined)) {
        return one.value;
      }
      if (one.value && typeof one.value === 'object' && 'active' in one.value) {
        return (one.value as { active?: unknown }).active;
      }
      return undefined;
    }).find((one) => typeof one === 'boolean');

    const active = typeof body.active === 'boolean' ? body.active : fromOperations;

    if (active === false) {
      await scim.deactivateUser(organisationOf(req), membershipId);
    }

    res.status(200).json({
      schemas: [USER_SCHEMA],
      id: membershipId,
      active: active ?? true,
    });
  });
}

/**
 * DELETE means deactivate.
 *
 * NEVER A HARD DELETE. Suspension silences grants and keeps the rows, so
 * somebody who leaves and returns comes back to what they had — and a
 * deactivation sent by mistake is recoverable. Destroying the membership would
 * make an ordinary HR event unrecoverable, and providers send plenty of those.
 */
export async function deleteUser(req: Request, res: Response): Promise<void> {
  await answering(res, async () => {
    await scim.deactivateUser(organisationOf(req), String(req.params.id));
    res.status(204).send();
  });
}

const userResource = (
  id: string,
  email: string,
  body: { name?: { givenName?: string; familyName?: string }; externalId?: string },
  active: boolean,
) => ({
  schemas: [USER_SCHEMA],
  id,
  externalId: body.externalId,
  userName: email,
  name: { givenName: body.name?.givenName ?? '', familyName: body.name?.familyName ?? '' },
  emails: [{ value: email, primary: true }],
  active,
  meta: { resourceType: 'User' },
});

/* ── Groups ──────────────────────────────────────────────────────────────── */

export async function getGroup(req: Request, res: Response): Promise<void> {
  await answering(res, async () => {
    const groups = await scim.listGroups(organisationOf(req));
    const group = groups.find((one) => one.id === String(req.params.id));

    if (!group) {
      scimError(res, 404, 'No such group.');
      return;
    }

    const members = await scim.membersOf(organisationOf(req), group.id);

    res.status(200).json({
      schemas: [GROUP_SCHEMA],
      id: group.id,
      externalId: group.externalId,
      displayName: group.displayName,
      members: members.map((one) => ({ value: one })),
      meta: { resourceType: 'Group' },
    });
  });
}

export async function listGroups(req: Request, res: Response): Promise<void> {
  await answering(res, async () => {
    const groups = await scim.listGroups(organisationOf(req));

    res.status(200).json({
      schemas: [LIST_SCHEMA],
      totalResults: groups.length,
      startIndex: 1,
      itemsPerPage: groups.length,
      Resources: groups.map((one) => ({
        schemas: [GROUP_SCHEMA],
        id: one.id,
        externalId: one.externalId,
        displayName: one.displayName,
        meta: { resourceType: 'Group' },
      })),
    });
  });
}

export async function createGroup(req: Request, res: Response): Promise<void> {
  await answering(res, async () => {
    const body = req.body as {
      externalId?: string;
      displayName?: string;
      members?: Array<{ value?: string }>;
    };

    if (!body.displayName) {
      scimError(res, 400, 'displayName is required.', 'invalidValue');
      return;
    }

    const group = await scim.upsertGroup(organisationOf(req), {
      externalId: body.externalId ?? body.displayName,
      displayName: body.displayName,
    });

    if (body.members) {
      await scim.syncGroupMembers(
        organisationOf(req),
        group.id,
        body.members.map((one) => one.value).filter((one): one is string => Boolean(one)),
      );
    }

    res.status(201).json({
      schemas: [GROUP_SCHEMA],
      id: group.id,
      externalId: group.externalId,
      displayName: group.displayName,
      meta: { resourceType: 'Group' },
    });
  });
}

/**
 * Membership changes.
 *
 * THE PROVIDER DECIDES WHO IS IN THE GROUP AND NOTHING ELSE. What being in it
 * carries was declared by an administrator and checked against the delegation
 * rules then; this only fills the envelope.
 */
export async function patchGroup(req: Request, res: Response): Promise<void> {
  await answering(res, async () => {
    const body = req.body as {
      Operations?: Array<{ op?: string; path?: string; value?: Array<{ value?: string }> }>;
    };

    const groupId = String(req.params.id);
    const current = new Set(await scim.membersOf(organisationOf(req), groupId));

    for (const operation of body.Operations ?? []) {
      if (operation.path !== 'members') continue;

      const ids = (operation.value ?? [])
        .map((one) => one.value)
        .filter((one): one is string => Boolean(one));

      const op = (operation.op ?? '').toLowerCase();
      if (op === 'add') for (const id of ids) current.add(id);
      else if (op === 'remove') for (const id of ids) current.delete(id);
      else if (op === 'replace') {
        current.clear();
        for (const id of ids) current.add(id);
      }
    }

    await scim.syncGroupMembers(organisationOf(req), groupId, [...current]);

    res.status(204).send();
  });
}

export async function deleteGroup(req: Request, res: Response): Promise<void> {
  await answering(res, async () => {
    await scim.deleteGroup(organisationOf(req), String(req.params.id));
    res.status(204).send();
  });
}

/* ── The administrative side, used by a person ───────────────────────────── */

/**
 * Issue a provisioning token.
 *
 * THE PLAINTEXT IS IN THIS RESPONSE AND NOWHERE ELSE. A customer pastes it into
 * their provider; a list that returned it later would mean the value survived
 * somewhere it could be read.
 */
export async function issueToken(req: Request, res: Response): Promise<void> {
  const input = body<{ name: string }>(req);
  res.status(201).json(await scim.issueToken(actorOf(req), input));
}

export async function listTokens(req: Request, res: Response): Promise<void> {
  res.status(200).json({ tokens: await scim.listTokens(actorOf(req)) });
}

export async function revokeToken(req: Request, res: Response): Promise<void> {
  const { id } = params<{ id: string }>(req);
  await scim.revokeToken(actorOf(req), id);
  res.status(204).send();
}

/**
 * Declare what a directory group carries.
 *
 * THE ONE AUTHORITY DECISION IN SCIM, and it is made here by a person. The
 * service runs the same six delegation rules a human grant runs: if they could
 * not grant this role at this scope themselves, they cannot arrange for a
 * directory to do it for them.
 */
export async function declareGroupGrant(req: Request, res: Response): Promise<void> {
  const input = body<Parameters<typeof scim.declareGroupGrant>[1]>(req);
  res.status(201).json({ mapping: await scim.declareGroupGrant(actorOf(req), input) });
}

export async function withdrawGroupGrant(req: Request, res: Response): Promise<void> {
  const { id } = params<{ id: string }>(req);
  await scim.withdrawGroupGrant(actorOf(req), id);
  res.status(204).send();
}
