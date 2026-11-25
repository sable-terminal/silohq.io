// OPC UA application instance certificates (spec 20.3): a signed or encrypted OPC UA endpoint is
// reached by the Silo Agent as one application, whose certificate the customer trusts on the
// server, once, whichever agent of the pool does the work. Its RSA key is made and held here,
// sealed as a connection credential of purpose opcua_application_key on the endpoint's
// connection, and never leaves in clear: for one piece of work on one agent it is sealed to that
// agent's X25519 key with HPKE, as a login is (10.7), bound to the organisation, agent,
// connection and work, valid for two minutes. The certificate is public: connect-registry keeps
// it on the endpoint and shows it in the builder; connect-runtime sends it with the work.

import { z } from 'zod';
import { defineContract } from '../endpoint.contract.ts';

/** The HPKE info's purpose for an application key; the binding follows a NUL, as a login's does. */
export const AGENT_OPCUA_KEY_INFO = 'silo.agent_opcua_key.v1';
/** The certificate's validity: rotated by issuing another (a new endpoint) before it ends. */
export const OPCUA_CERTIFICATE_DAYS = 730;

export const issueOpcUaApplicationCertificate = defineContract({
  service: 'credential', name: 'issueOpcUaApplicationCertificate', method: 'POST', path: '/v1/opcua-application-certificates',
  callers: ['connect-registry'],
  // Each call makes a new key; a retry after a lost answer leaves an unused key, never a shared one.
  context: 'organisation', idempotency: 'none',
  body: z.strictObject({ connectionId: z.uuid(), endpointId: z.uuid() }),
  response: z.object({
    certificatePem: z.string(),
    /** SHA-1 of the certificate, lower-case hex: how OPC UA servers list a trusted certificate. */
    thumbprint: z.string().regex(/^[0-9a-f]{40}$/),
    applicationUri: z.string(),
    notAfter: z.iso.datetime({ offset: true }),
  }),
  maxBodyBytes: 256,
});

export const sealOpcUaApplicationKey = defineContract({
  service: 'credential', name: 'sealOpcUaApplicationKey', method: 'POST', path: '/v1/opcua-application-keys',
  callers: ['connect-runtime'],
  context: 'organisation', idempotency: 'none',
  body: z.strictObject({
    connectionId: z.uuid(),
    endpointId: z.uuid(),
    reason: z.enum(['query', 'probe', 'change_stream']),
    agentId: z.uuid(),
    workId: z.uuid(),
  }),
  response: z.object({
    /** HPKE enc || ciphertext || tag, base64, of {"expiresAt":...,"privateKey":"<PKCS#8 DER, base64>"}. */
    sealed: z.base64(),
    expiresAt: z.iso.datetime({ offset: true }),
  }),
  maxBodyBytes: 512,
});
