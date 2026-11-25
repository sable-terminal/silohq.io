// Federated sign-in and WebAuthn, for the auth service (spec 55.4, 55.5).
//
// The public addresses come from GATEWAY_PUBLIC_ORIGIN, which the browser loads the app
// from: the OIDC redirect URI is the app's callback page, the SAML assertion consumer is
// the gateway's ACS endpoint, the WebAuthn relying party is the origin's host. A sign-in in
// flight lasts 10 minutes by default (this build's choice).
//
// The directory (spec 55.1) is told of each person this cell holds, when the cell has a
// directory: SERVICE_URL_DIRECTORY set. A self-managed cell without one registers nothing.
//
// The SAML service provider's key pair (decision 2026-11-14): one per cell, from the
// deployment (GCP Secret Manager), PEM. The credential service signs its AuthnRequests and
// LogoutRequests with it and decrypts encrypted assertions with it; the SP metadata publishes
// its certificate. During a rotation the next pair is set too: both certificates are
// published, assertions encrypted to either are decrypted, and requests are signed with the
// current one. Silo never generates the keys.

import { z } from 'zod';
import { parseSection, read, zPositiveInt, type Env } from './env.config.ts';

const schema = z.object({
  flowSeconds: zPositiveInt(1_800).default(600),
  /** The app's OIDC callback page; default <origin>/sso/callback. */
  oidcRedirectUri: z.url({ protocol: /^https?$/ }).optional(),
  /** The SAML service provider's entity id; default <origin>/api/v1/sso/saml/metadata. */
  samlEntityId: z.url({ protocol: /^https?$/ }).optional(),
  webauthnRpName: z.string().min(1).max(64).default('Silo'),
  /** How often registrations the directory missed are tried again (D69); default five minutes. */
  directoryRetrySeconds: zPositiveInt(86_400).default(300),
  samlSpPrivateKey: z.string().includes('PRIVATE KEY').optional(),
  samlSpCertificate: z.string().includes('CERTIFICATE').optional(),
  samlSpNextPrivateKey: z.string().includes('PRIVATE KEY').optional(),
  samlSpNextCertificate: z.string().includes('CERTIFICATE').optional(),
}).refine((c) => (c.samlSpPrivateKey === undefined) === (c.samlSpCertificate === undefined), 'SAML_SP_PRIVATE_KEY and SAML_SP_CERTIFICATE are set together')
  .refine((c) => (c.samlSpNextPrivateKey === undefined) === (c.samlSpNextCertificate === undefined), 'SAML_SP_NEXT_PRIVATE_KEY and SAML_SP_NEXT_CERTIFICATE are set together')
  .refine((c) => c.samlSpNextPrivateKey === undefined || c.samlSpPrivateKey !== undefined, 'a next SAML key pair rotates from a current one');

export type SsoConfig = z.output<typeof schema>;

export function loadSsoConfig(env: Env, problems: string[]): SsoConfig | undefined {
  return parseSection(schema, {
    flowSeconds: read(env, 'SSO_FLOW_SECONDS'),
    oidcRedirectUri: read(env, 'SSO_OIDC_REDIRECT_URI'),
    samlEntityId: read(env, 'SSO_SAML_ENTITY_ID'),
    webauthnRpName: read(env, 'WEBAUTHN_RP_NAME'),
    directoryRetrySeconds: read(env, 'DIRECTORY_RETRY_SECONDS'),
    samlSpPrivateKey: read(env, 'SAML_SP_PRIVATE_KEY'),
    samlSpCertificate: read(env, 'SAML_SP_CERTIFICATE'),
    samlSpNextPrivateKey: read(env, 'SAML_SP_NEXT_PRIVATE_KEY'),
    samlSpNextCertificate: read(env, 'SAML_SP_NEXT_CERTIFICATE'),
  }, {
    flowSeconds: 'SSO_FLOW_SECONDS', oidcRedirectUri: 'SSO_OIDC_REDIRECT_URI', samlEntityId: 'SSO_SAML_ENTITY_ID',
    webauthnRpName: 'WEBAUTHN_RP_NAME', directoryRetrySeconds: 'DIRECTORY_RETRY_SECONDS',
    samlSpPrivateKey: 'SAML_SP_PRIVATE_KEY', samlSpCertificate: 'SAML_SP_CERTIFICATE',
    samlSpNextPrivateKey: 'SAML_SP_NEXT_PRIVATE_KEY', samlSpNextCertificate: 'SAML_SP_NEXT_CERTIFICATE',
  }, problems);
}
