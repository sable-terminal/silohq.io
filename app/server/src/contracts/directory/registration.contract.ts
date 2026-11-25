// The directory (spec 6.2, 55.1): the only component that crosses a cell boundary. It
// routes a login to the cell holding the organisation or the person, and holds nothing
// else: an organisation slug, a keyed hash of an email address, cell identifiers and
// statuses. Never a plaintext address, a name, a logo or password material.
//
// Cells register what they create, move or close (spec 6.2, "Registration (cell to
// directory)"). The global tier has no organisation context, so no operation is keyed:
// each sets a state, and sending it again changes nothing.
//
// The email hash is computed by the cell: HMAC-SHA-256 inside the KMS, under the
// directory key (KMS_DIRECTORY_KEY_URI, version DIRECTORY_KEY_VERSION), over
// emailRoutingInput(address) (utils/email.util.ts). The address never leaves the cell.

import { z } from 'zod';
import { CELL_KINDS, RESIDENCIES } from '../../config/cell.config.ts';
import { defineContract } from '../endpoint.contract.ts';

export const CELL_STATUSES = ['provisioning', 'active', 'closed_to_placement', 'draining', 'retired'] as const;
export const ORGANISATION_STATUSES = ['active', 'suspended', 'closed'] as const;

export const cellIdSchema = z.string().max(63).regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'must be a cell identifier such as uk-lon-1');
// directory.organisation_directory: citext, so compared without case; sent in lower case.
export const organisationSlugSchema = z.string().toLowerCase().regex(/^[a-z0-9][a-z0-9-]{1,62}$/, 'must be an organisation slug');
// 32 bytes, base64url without padding, in its one canonical spelling.
export const emailHashSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/, 'must be 32 bytes, base64url')
  .refine((value) => Buffer.from(value, 'base64url').toString('base64url') === value, 'must be canonical base64url');

export const cellView = z.object({
  id: z.string(),
  kind: z.enum(CELL_KINDS),
  residency: z.enum(RESIDENCIES),
  hostname: z.string(),
  status: z.enum(CELL_STATUSES),
  /** Its live connections as its Fleet agent last reported them, and when (D203). */
  connectionCount: z.int().min(0).optional(),
  countsAt: z.string().nullable().optional(),
});

export const organisationView = z.object({
  organisationSlug: z.string(),
  cellId: z.string(),
  status: z.enum(ORGANISATION_STATUSES),
});

/**
 * A cell's placement limits (spec 6.3): "about 2,000 organisations and 50,000 connections". New
 * organisations are placed only below both; provisioning starts at 75% of either, and existing
 * tenants growing past 110% call for a rebalancing migration.
 */
export const CELL_LIMITS = { organisations: 2_000, connections: 50_000 } as const;

/** A cell registers itself, and reports each change of status (spec 6.3: "directory registration"), and its live connections. */
export const registerCell = defineContract({
  service: 'directory', name: 'registerCell', method: 'PUT', path: '/v1/cells/:cellId',
  // The cell's Fleet agent, which runs as fleet-control inside the cell and applies the template.
  callers: ['fleet-control'],
  context: 'none', idempotency: 'none',
  params: z.strictObject({ cellId: cellIdSchema }),
  body: z.strictObject({
    kind: z.enum(CELL_KINDS),
    residency: z.enum(RESIDENCIES),
    hostname: z.string().max(253).regex(/^[a-z0-9-]+(\.[a-z0-9-]+)+$/, 'must be a DNS name'),
    status: z.enum(CELL_STATUSES),
    /** Its live connections now, as its Fleet agent counted them (D203): what placement weighs beside its organisations. */
    connectionCount: z.int().min(0).max(10_000_000).optional(),
  }),
  response: cellView,
  maxBodyBytes: 1024,
});

/** A new organisation's slug, or a change of its status, from the cell that holds it. */
export const registerOrganisation = defineContract({
  service: 'directory', name: 'registerOrganisation', method: 'PUT', path: '/v1/organisations/:organisationSlug',
  callers: ['auth', 'tenant-migrations'],
  context: 'none', idempotency: 'none',
  params: z.strictObject({ organisationSlug: organisationSlugSchema }),
  body: z.strictObject({
    cellId: cellIdSchema,
    status: z.enum(ORGANISATION_STATUSES),
  }),
  response: organisationView,
  maxBodyBytes: 1024,
});

/** The directory_updated stage of a tenant migration (spec 6.4): the slug now routes to the destination. */
export const moveOrganisation = defineContract({
  service: 'directory', name: 'moveOrganisation', method: 'POST', path: '/v1/organisations/:organisationSlug/move',
  callers: ['tenant-migrations'],
  // From one named cell to another: repeating it finds the move done and changes nothing.
  context: 'none', idempotency: 'none',
  params: z.strictObject({ organisationSlug: organisationSlugSchema }),
  body: z.strictObject({ fromCellId: cellIdSchema, toCellId: cellIdSchema }),
  response: organisationView,
  maxBodyBytes: 1024,
});

/** A person now has a user in this cell: their address's hash routes here too. */
export const registerIdentity = defineContract({
  service: 'directory', name: 'registerIdentity', method: 'PUT', path: '/v1/identities',
  callers: ['auth', 'tenant-migrations'],
  context: 'none', idempotency: 'none',
  body: z.strictObject({
    cellId: cellIdSchema,
    emailHash: emailHashSchema,
    hashKeyVersion: z.number().int().min(1).max(32_767),
  }),
  response: z.object({ created: z.boolean() }),
  maxBodyBytes: 1024,
});

/** Where an organisation lives: sign-up checks a slug is free, a migration checks its source. */
export const findOrganisation = defineContract({
  service: 'directory', name: 'findOrganisation', method: 'GET', path: '/v1/organisations/:organisationSlug',
  callers: ['auth', 'tenant-migrations'],
  context: 'none', idempotency: 'none',
  params: z.strictObject({ organisationSlug: organisationSlugSchema }),
  response: organisationView.extend({ hostname: z.string() }),
});

// ----------------------------------------------------------------------------- the login page
// Not a service contract: the browser calls the directory's public listener (spec 6.2,
// "Login routing (browser to directory, then to the cell)"). The address is hashed in
// the KMS as it arrives and is never stored, logged or returned. The login page renders
// after routing, inside the cell.

export const LOGIN_ROUTE_PATH = '/v1/login/route';

export const loginRouteRequest = z.union([
  z.strictObject({ organisationSlug: organisationSlugSchema }),
  z.strictObject({ email: z.string().max(320).trim().regex(/^[^\s@]+@[^\s@]+\.[^\s@]+$/, 'must be an email address') }),
]);

export const loginRouteResponse = z.discriminatedUnion('next', [
  /** Go to this cell's login page. */
  z.object({ next: z.literal('cell'), cellId: z.string(), loginUrl: z.url() }),
  /** The address is known in more than one cell: ask which organisation, then route by slug. */
  z.object({ next: z.literal('organisation') }),
  /** No organisation has that slug (slugs are public: they are in every URL). */
  z.object({ next: z.literal('unknown_organisation') }),
]);

// Self-serve sign-up's first step (decision 2026-11-14; spec 6.4): the residency chosen at
// sign-up (default UK), then the cell in it with the most headroom. Never across residency.
export const SIGNUP_PLACE_PATH = '/v1/signup/place';

export const signupPlaceRequest = z.strictObject({ residency: z.enum(RESIDENCIES).default('uk') });

export const signupPlaceResponse = z.discriminatedUnion('next', [
  /** Sign up on this cell's page. */
  z.object({ next: z.literal('cell'), cellId: z.string(), signupUrl: z.url() }),
  /** No cell in the residency takes new organisations now (or this is a sovereign directory: Enterprise is on contract). */
  z.object({ next: z.literal('unavailable') }),
]);

export type SignupPlaceResponse = z.infer<typeof signupPlaceResponse>;
export type LoginRouteRequest = z.infer<typeof loginRouteRequest>;
export type LoginRouteResponse = z.infer<typeof loginRouteResponse>;
