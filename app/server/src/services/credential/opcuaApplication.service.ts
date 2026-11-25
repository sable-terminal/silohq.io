// OPC UA application instance certificates (spec 20.3; contracts/credential/opcuaApplication
// .contract.ts). issue makes an RSA-2048 key and a self-signed certificate for one endpoint, as
// OPC UA Part 6 describes an application instance certificate: the application URI in the
// subject alternative name, digital signature, non-repudiation, key and data encipherment and
// certificate signing, client and server authentication, SHA-256 with RSA. The key is sealed
// here as a connection credential (purpose opcua_application_key, one field per endpoint) and
// its clear bytes zeroed; only the certificate leaves.
//
// sealForAgent opens the key for one piece of work on one agent of the connection's pool and
// seals it to that agent with HPKE, the plaintext document assembled from the opened bytes so the
// key never becomes a JavaScript string; each opening is in the unwrap ledger.

import 'reflect-metadata';
import * as x509 from '@peculiar/x509';
import { createHash, webcrypto } from 'node:crypto';
import { AGENT_CREDENTIAL_SECONDS } from '../../contracts/credential/connectionCredential.contract.ts';
import { AGENT_OPCUA_KEY_INFO, OPCUA_CERTIFICATE_DAYS } from '../../contracts/credential/opcuaApplication.contract.ts';
import { inTransaction, type Databases } from '../../infra/postgres.infra.ts';
import { agentRepo, connectionCredentialRepo } from '../../repos/connect/index.repo.ts';
import { canonicalJsonBytes } from '../../utils/canonicalJson.util.ts';
import { base64Bytes, randomBytes, zeroise } from '../../utils/crypto.util.ts';
import { seal, sealBindings, type KeyRing, type SealedSecret } from '../../utils/envelope.util.ts';
import { AppError } from '../../utils/errors.util.ts';
import { hpkeSeal, x25519PublicKey } from '../../utils/hpke.util.ts';
import { uuidv7 } from '../../utils/id.util.ts';
import { recordConnectEvent } from '../connect-registry/connectEvents.service.ts';
import type { Caller, ConnectionCredentials } from './connectionCredential.service.ts';

x509.cryptoProvider.set(webcrypto as unknown as Crypto);
/** The key types the library takes, whichever WebCrypto declarations the program has (Node's here; the DOM's in the web client's type-check). */
type LibraryKeys = Parameters<typeof x509.X509CertificateGenerator.createSelfSigned>[0]['keys'];
type LibraryKey = Parameters<typeof x509.SubjectKeyIdentifierExtension.create>[0];

const PURPOSE = 'opcua_application_key';
const DAY_MS = 86_400_000;
const fieldOf = (endpointId: string): string => `opcua_application_key_${endpointId}`;
export const opcUaApplicationUri = (endpointId: string): string => `urn:silohq.io:agent:opcua:${endpointId}`;

export interface OpcUaApplicationDeps {
  keys: KeyRing;
  databases: Databases;
  credentials: ConnectionCredentials;
}

export function createOpcUaApplications(deps: OpcUaApplicationDeps) {
  const control = deps.databases.pool('control');

  return {
    async issue(caller: Caller, input: { connectionId: string; endpointId: string }) {
      const loaded = await deps.credentials.load(caller, input.connectionId);
      const { connection, manifest } = loaded;
      if (connection.status === 'revoked') throw new AppError('conflict', 'a revoked connection takes no new key', { code: 'connection.revoked' });
      if (manifest.protocol.kind !== 'opc_ua' || connection.agentPoolId === null) {
        throw new AppError('validation', 'an application certificate is for an OPC UA connection reached through the Silo Agent', { code: 'credential.not_opcua' });
      }
      const organisationId = connection.organisationId;
      const fieldName = fieldOf(input.endpointId);
      if (loaded.rows.some((r) => r.fieldName === fieldName)) {
        throw new AppError('conflict', 'that endpoint already has its application key', { code: 'credential.opcua_key_exists' });
      }
      const keys = await webcrypto.subtle.generateKey(
        { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify'],
      ) as webcrypto.CryptoKeyPair;
      const now = Date.now();
      const notBefore = new Date(now - 5 * 60_000);
      const notAfter = new Date(now + OPCUA_CERTIFICATE_DAYS * DAY_MS);
      // A positive serial of 16 random bytes (RFC 5280: at most 20 octets, non-negative).
      const serial = randomBytes(16);
      serial[0] = serial[0]! & 0x7f;
      const applicationUri = opcUaApplicationUri(input.endpointId);
      const certificate = await x509.X509CertificateGenerator.createSelfSigned({
        serialNumber: serial.toString('hex'),
        name: `CN=Silo Agent, O=Silo, OU=${input.endpointId}`,
        // The library's own key types: Node's WebCrypto keys, as the provider above.
        notBefore, notAfter, keys: keys as unknown as LibraryKeys,
        signingAlgorithm: { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
        extensions: [
          new x509.BasicConstraintsExtension(false, undefined, true),
          new x509.KeyUsagesExtension(x509.KeyUsageFlags.digitalSignature | x509.KeyUsageFlags.nonRepudiation | x509.KeyUsageFlags.keyEncipherment
            | x509.KeyUsageFlags.dataEncipherment | x509.KeyUsageFlags.keyCertSign, true),
          new x509.ExtendedKeyUsageExtension([x509.ExtendedKeyUsage.serverAuth, x509.ExtendedKeyUsage.clientAuth], false),
          new x509.SubjectAlternativeNameExtension([{ type: 'url', value: applicationUri }], false),
          await x509.SubjectKeyIdentifierExtension.create(keys.publicKey as unknown as LibraryKey, false),
        ],
      });
      const id = uuidv7();
      const pkcs8 = Buffer.from(await webcrypto.subtle.exportKey('pkcs8', keys.privateKey));
      let sealed: SealedSecret;
      try {
        sealed = await seal(deps.keys, pkcs8, sealBindings.connectionCredential({ id, organisationId, connectionId: connection.id, fieldName, purpose: PURPOSE }));
      } finally {
        zeroise(pkcs8);
      }
      await inTransaction(control, caller.request, async (db) => {
        await connectionCredentialRepo.insert(db, {
          id, organisationId, connectionId: connection.id, purpose: PURPOSE, fieldName, custody: 'cell',
          ciphertext: sealed.ciphertext, nonce: sealed.nonce, dekWrapped: sealed.dekWrapped, keyVersionId: sealed.keyVersionId,
          lastFour: null, authStrategy: 'opcua_application',
        });
        await recordConnectEvent(db, { service: 'credential',
          organisationId, correlationId: caller.correlationId, event: 'credential_sealed', membershipId: caller.request.membershipId,
          resourceType: 'credential', resourceId: id, detail: { connection_id: connection.id, field: fieldName, kind: 'secret' },
        });
      });
      return {
        certificatePem: certificate.toString('pem'),
        thumbprint: createHash('sha1').update(Buffer.from(certificate.rawData)).digest('hex'),
        applicationUri, notAfter: notAfter.toISOString(),
      };
    },

    async sealForAgent(caller: Caller, input: { connectionId: string; endpointId: string; reason: 'query' | 'probe' | 'change_stream'; agentId: string; workId: string }) {
      const loaded = await deps.credentials.load(caller, input.connectionId);
      deps.credentials.usable(loaded, input.reason);
      const { connection } = loaded;
      const row = loaded.rows.find((r) => r.fieldName === fieldOf(input.endpointId) && r.purpose === PURPOSE);
      if (row === undefined) throw new AppError('not_found', 'that endpoint has no application key', { code: 'credential.opcua_key_missing' });
      const agent = await inTransaction(control, caller.request, (db) => agentRepo.findById(db, input.agentId), { readOnly: true });
      if (agent === undefined || agent.poolId !== connection.agentPoolId || agent.status === 'revoked') {
        throw new AppError('forbidden', 'that agent does not serve this connection', { code: 'credential.agent_not_in_pool' });
      }
      if (agent.sealingKey === null) {
        throw new AppError('conflict', 'the agent has no key to take a secret sealed to it; it gets one at its next renewal or update', { code: 'agent.no_sealing_key' });
      }
      const expiresAt = new Date(Date.now() + AGENT_CREDENTIAL_SECONDS * 1000).toISOString();
      const info = Buffer.concat([Buffer.from(`${AGENT_OPCUA_KEY_INFO}\u0000`, 'utf8'),
        canonicalJsonBytes({ agentId: agent.id, connectionId: connection.id, organisationId: connection.organisationId, workId: input.workId })]);
      const recipient = x25519PublicKey(agent.sealingKey);
      return deps.credentials.open(caller, [row], input.reason, async (values) => {
        const encoded = base64Bytes(values.get(row.fieldName)!);
        const plaintext = Buffer.concat([Buffer.from(`{"expiresAt":${JSON.stringify(expiresAt)},"privateKey":"`, 'utf8'), encoded, Buffer.from('"}', 'utf8')]);
        try {
          return { sealed: hpkeSeal(recipient, info, plaintext).toString('base64'), expiresAt };
        } finally {
          zeroise(encoded, plaintext);
        }
      });
    },
  };
}

export type OpcUaApplications = ReturnType<typeof createOpcUaApplications>;
