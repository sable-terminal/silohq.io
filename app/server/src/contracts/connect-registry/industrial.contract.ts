// Industrial endpoints (spec 20.1 to 20.3, 20.7): the MQTT broker or OPC UA server an
// industrial connection reaches, always through the connection's Silo Agent pool, so no
// inbound firewall rule is added. A holder of industrial.connect at the connection's owning
// scope creates one. Its security policy says how it is secured: an MQTT broker's TLS, or an
// OPC UA server's policy and mode. OPC UA's None is refused unless the connection owner records
// an exception for a segregated network (industrial.declare_writable), shown on every clone from
// that connection (opcua_insecure_exception_recorded).
//
// A signed OPC UA endpoint is reached as one application: the credential service makes its
// certificate and key at creation, and the customer trusts the certificate on the server (the
// builder shows it). The owner pins the server's own certificate by its thumbprint, as the
// server's configuration shows it; the agent refuses any other. The endpoint is untrusted until
// verified: the probe connects as a read would, and the endpoint becomes active once the server
// accepts the application (industrial_endpoint_verified) or stays untrusted
// (industrial_endpoint_untrusted).

import { z } from 'zod';
import { defineContract } from '../endpoint.contract.ts';

export const INDUSTRIAL_PLUGINS = ['mqtt', 'opcua'] as const;

/** An MQTT broker: tcp:// (plain, inside the customer's network) or ssl:// (TLS); an OPC UA server: opc.tcp://. No credentials in the URL. */
const endpointUrl = z.string().max(500).regex(/^(tcp|ssl|mqtt|mqtts|opc\.tcp):\/\/[A-Za-z0-9.\-[\]:]+(:\d{1,5})?(\/[^\s?#@]*)?$/, 'a broker or server URL, no credentials');

/** A certificate thumbprint as a server shows it: SHA-1 or SHA-256, hex, colons or spaces allowed. */
const thumbprint = z.string().trim().max(200).transform((t) => t.replace(/[\s:]/g, '').toLowerCase())
  .refine((t) => /^([0-9a-f]{40}|[0-9a-f]{64})$/.test(t), 'a SHA-1 or SHA-256 thumbprint in hex');

export const industrialEndpointView = z.object({
  id: z.uuid(),
  connectionId: z.uuid(),
  plugin: z.enum(INDUSTRIAL_PLUGINS),
  endpointUrl: z.string(),
  agentPoolId: z.uuid(),
  securityPolicy: z.string(),
  /** The owner who recorded a security policy None exception; shown on every clone from the connection. */
  insecureExceptionBy: z.uuid().nullable(),
  /** A signed OPC UA endpoint's application instance certificate: what the customer trusts on the server. */
  applicationCertificate: z.object({ pem: z.string(), thumbprint: z.string() }).nullable(),
  /** The server certificate pinned for a signed OPC UA endpoint. */
  serverCertificateThumbprint: z.string().nullable(),
  /** The server's namespaces at its last verification. */
  namespaceUris: z.array(z.string()),
  verifiedAt: z.string().nullable(),
  status: z.enum(['active', 'untrusted', 'unreachable', 'revoked']),
  createdAt: z.string(),
});
export type IndustrialEndpointView = z.infer<typeof industrialEndpointView>;

const connectionId = z.strictObject({ connectionId: z.uuid() });

export const createIndustrialEndpoint = defineContract({
  service: 'connect-registry', name: 'createIndustrialEndpoint', method: 'POST', path: '/v1/connections/:connectionId/industrial-endpoints',
  callers: ['gateway'],
  context: 'organisation', idempotency: 'none',
  params: connectionId,
  body: z.strictObject({
    plugin: z.enum(INDUSTRIAL_PLUGINS),
    endpointUrl,
    /**
     * MQTT: "tls" (an ssl:// broker) or "plain" (a tcp:// broker on the customer's network).
     * OPC UA: policy and mode, such as "Basic256Sha256 SignAndEncrypt" (Aes128_Sha256_RsaOaep and
     * Aes256_Sha256_RsaPss too; Sign or SignAndEncrypt); "None" needs the exception.
     */
    securityPolicy: z.string().trim().min(1).max(200),
    /** OPC UA only: the connection owner records a security policy None exception for a segregated network. */
    insecureException: z.literal(true).optional(),
    /** A signed OPC UA policy: the server's certificate, by its thumbprint as the server shows it (SHA-1 or SHA-256). */
    serverCertificateThumbprint: thumbprint.optional(),
  }),
  response: industrialEndpointView,
  status: 201,
  maxBodyBytes: 4_096,
});

export const PROBE_OUTCOMES = ['trusted', 'untrusted', 'server_certificate_mismatch', 'policy_not_offered', 'login_refused', 'unreachable'] as const;

/**
 * An OPC UA endpoint's verification: the agent connects as a read would. trusted makes it active;
 * untrusted or another server certificate leaves it untrusted; unreachable marks one never
 * verified; a refused login or a policy the server does not offer leaves it as it was. The
 * certificate the server presented is returned for the owner to compare with the server's own.
 */
export const verifyIndustrialEndpoint = defineContract({
  service: 'connect-registry', name: 'verifyIndustrialEndpoint', method: 'POST', path: '/v1/connections/:connectionId/industrial-endpoints/:endpointId/verifications',
  callers: ['gateway'],
  context: 'organisation', idempotency: 'none',
  params: z.strictObject({ connectionId: z.uuid(), endpointId: z.uuid() }),
  response: z.object({
    outcome: z.enum(PROBE_OUTCOMES),
    endpoint: industrialEndpointView,
    presented: z.object({ sha1: z.string(), sha256: z.string() }).optional(),
  }),
});

export const listIndustrialEndpoints = defineContract({
  service: 'connect-registry', name: 'listIndustrialEndpoints', method: 'GET', path: '/v1/connections/:connectionId/industrial-endpoints',
  callers: ['gateway'],
  context: 'organisation', idempotency: 'none',
  params: connectionId,
  response: z.object({ endpoints: z.array(industrialEndpointView) }),
});
