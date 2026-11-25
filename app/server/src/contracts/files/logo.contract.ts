// The organisation's logo (spec 56.2): PNG, JPEG, SVG or WebP, at most 2 MB and 1024 pixels a
// side, its type sniffed from its bytes, an SVG sanitised; stored under the organisation's own
// object path, the key alone in the organisation row; served through this membership-checked
// route, never a public bucket. Set under org.logo.manage (super admin only).

import { z } from 'zod';
import { defineContract } from '../endpoint.contract.ts';

export const LOGO_MAX_BYTES = 2 * 1024 * 1024;
export const LOGO_MAX_PIXELS = 1024;

export const logoView = z.object({
  contentType: z.enum(['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml']),
  width: z.int().nullable(), height: z.int().nullable(), bytes: z.int(), uploadedBy: z.uuid(), uploadedAt: z.string(),
});

export const setOrganisationLogo = defineContract({
  service: 'files', name: 'setOrganisationLogo', method: 'PUT', path: '/v1/organisation/logo', callers: ['gateway'],
  context: 'organisation', idempotency: 'none',
  body: z.strictObject({ contentBase64: z.base64().min(4).max(Math.ceil(LOGO_MAX_BYTES / 3) * 4 + 4) }),
  response: logoView,
  maxBodyBytes: Math.ceil(LOGO_MAX_BYTES / 3) * 4 + 1_024,
});

/** The logo, for any member of the organisation (the route checks membership, as 56.2 requires). */
export const getOrganisationLogo = defineContract({
  service: 'files', name: 'getOrganisationLogo', method: 'GET', path: '/v1/organisation/logo', callers: ['gateway'],
  context: 'organisation', idempotency: 'none',
  response: z.object({ contentType: z.string(), contentBase64: z.base64() }),
});
