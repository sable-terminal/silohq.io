// An organisation's email domains (decision 2026-11-14; D79), org.sso.manage. Verifying one
// is optional: a TXT record at the name given, carrying the value given, proves control, and
// a verified domain is claimed in the cell, so no one signs up a separate organisation with
// an address at it.

import { z } from 'zod';
import { defineContract } from '../endpoint.contract.ts';

const timestamp = z.iso.datetime({ offset: true });

export const domainView = z.object({
  id: z.uuid(),
  domain: z.string(),
  status: z.enum(['pending', 'verified']),
  /** Publish this TXT record to verify the domain. */
  txtName: z.string(),
  txtValue: z.string(),
  createdAt: timestamp,
  verifiedAt: timestamp.nullable(),
});

export const listDomains = defineContract({
  service: 'auth', name: 'listDomains', method: 'GET', path: '/v1/domains', callers: ['gateway'],
  context: 'organisation', idempotency: 'none',
  response: z.object({ domains: z.array(domainView) }),
});

/** Adds a domain to verify. Adding one the organisation already has returns it. */
export const addDomain = defineContract({
  service: 'auth', name: 'addDomain', method: 'POST', path: '/v1/domains', callers: ['gateway'],
  context: 'organisation', idempotency: 'none',
  body: z.strictObject({
    domain: z.string().trim().toLowerCase().max(253).regex(/^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/, 'must be a domain name'),
  }),
  response: domainView,
  status: 201,
  maxBodyBytes: 512,
});

/** Looks the TXT record up now; verified, the domain is claimed in the cell. */
export const verifyDomain = defineContract({
  service: 'auth', name: 'verifyDomain', method: 'POST', path: '/v1/domains/:domainId/verify', callers: ['gateway'],
  // Verifying a verified domain changes nothing.
  context: 'organisation', idempotency: 'none',
  params: z.strictObject({ domainId: z.uuid() }),
  response: domainView,
});

/** Removes a domain, and with it any claim. */
export const removeDomain = defineContract({
  service: 'auth', name: 'removeDomain', method: 'DELETE', path: '/v1/domains/:domainId', callers: ['gateway'],
  // Removing a removed domain changes nothing.
  context: 'organisation', idempotency: 'none',
  params: z.strictObject({ domainId: z.uuid() }),
  response: z.undefined(),
});
