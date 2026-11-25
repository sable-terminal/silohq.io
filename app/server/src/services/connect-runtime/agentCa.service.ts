// The cell's agent certificate authority (spec 10.2, 10.7): "The agent generates its key pair
// locally; the private key never leaves the host. It sends a signing request ... The cell's
// agent certificate authority issues a client certificate bound to the agent's service
// principal ... Certificates. Valid 30 days, renewed at 20 with a new local key pair."
//
// The CA's key and certificate come from the deployment (AGENT_CA_KEY, AGENT_CA_CERT_FILE),
// as the SAML key does (decision 2026-11-14): this code signs, and never generates a key.
// The library (@peculiar/x509) builds and signs the certificate; nothing here encodes ASN.1.
//
// A request is accepted only with a P-256 ECDSA key and a valid self-signature. The
// certificate names the agent and its organisation, is for client authentication only, and
// is not a CA. Its fingerprint (SHA-256 of the DER) is what the tunnel finds the agent by.

// The library's dependency injection needs the metadata polyfill loaded first.
import 'reflect-metadata';
import * as x509 from '@peculiar/x509';
import { createHash, randomBytes, webcrypto } from 'node:crypto';
import { AppError } from '../../utils/errors.util.ts';

x509.cryptoProvider.set(webcrypto as unknown as Crypto);

export const AGENT_CERT_DAYS = 30;
const DAY_MS = 86_400_000;

export interface AgentCa {
  /** The CA certificate, PEM, which agents pin for the tunnel and the tunnel checks clients against. */
  certificatePem: string;
  issue(requestPem: string, subject: { agentId: string; organisationId: string }, at: Date): Promise<IssuedCertificate>;
}

export interface IssuedCertificate {
  certificatePem: string;
  /** SHA-256 of the certificate's DER. */
  fingerprint: Buffer;
  serial: string;
  notBefore: Date;
  notAfter: Date;
}

const invalidRequest = (why: string): AppError =>
  new AppError('validation', `the certificate signing request is not one the agent CA signs: ${why}`, { code: 'agent.csr_invalid' });

export const fingerprintOf = (der: ArrayBuffer | Buffer): Buffer => createHash('sha256').update(Buffer.from(der as ArrayBuffer)).digest();

export async function createAgentCa(options: { certificatePem: string; keyPem: string }): Promise<AgentCa> {
  const caCertificate = new x509.X509Certificate(options.certificatePem);
  const keyDer = Buffer.from(options.keyPem.replace(/-----[A-Z ]+-----/g, '').replace(/\s+/g, ''), 'base64');
  let signingKey: CryptoKey;
  try {
    signingKey = await webcrypto.subtle.importKey('pkcs8', keyDer, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']) as CryptoKey;
  } catch (cause) {
    throw new AppError('configuration', 'AGENT_CA_KEY is a P-256 ECDSA private key in PKCS#8 PEM', { code: 'config.agent_ca', cause });
  }
  const authorityKeyIdentifier = await x509.AuthorityKeyIdentifierExtension.create(caCertificate, false);

  return {
    certificatePem: caCertificate.toString('pem'),
    async issue(requestPem, subject, at) {
      let request: x509.Pkcs10CertificateRequest;
      try {
        request = new x509.Pkcs10CertificateRequest(requestPem);
      } catch {
        throw invalidRequest('not a PKCS#10 request in PEM');
      }
      const algorithm = request.publicKey.algorithm as webcrypto.EcKeyAlgorithm;
      if (algorithm.name !== 'ECDSA' || algorithm.namedCurve !== 'P-256') throw invalidRequest('its key is not P-256 ECDSA');
      if (!await request.verify()) throw invalidRequest('its signature does not verify');
      const notBefore = new Date(at.getTime() - 5 * 60_000);
      const notAfter = new Date(at.getTime() + AGENT_CERT_DAYS * DAY_MS);
      // A positive serial of 16 random bytes (RFC 5280: at most 20 octets, non-negative).
      const serialBytes = randomBytes(16);
      serialBytes[0] = serialBytes[0]! & 0x7f;
      const serial = serialBytes.toString('hex');
      const certificate = await x509.X509CertificateGenerator.create({
        serialNumber: serial,
        issuer: caCertificate.subject,
        subject: `CN=${subject.agentId}, O=${subject.organisationId}`,
        notBefore, notAfter,
        publicKey: request.publicKey,
        signingKey,
        signingAlgorithm: { name: 'ECDSA', hash: 'SHA-256' },
        extensions: [
          new x509.BasicConstraintsExtension(false, undefined, true),
          new x509.KeyUsagesExtension(x509.KeyUsageFlags.digitalSignature, true),
          new x509.ExtendedKeyUsageExtension([x509.ExtendedKeyUsage.clientAuth], false),
          new x509.SubjectAlternativeNameExtension([{ type: 'url', value: `urn:silo:agent:${subject.agentId}` }], false),
          authorityKeyIdentifier,
          await x509.SubjectKeyIdentifierExtension.create(request.publicKey, false),
        ],
      });
      return { certificatePem: certificate.toString('pem'), fingerprint: fingerprintOf(certificate.rawData), serial, notBefore, notAfter };
    },
  };
}
