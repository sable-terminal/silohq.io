// The credential service (spec 61): the only holder of KMS access. It refuses to start
// unless every key version that may still open a secret is present and usable
// (startupKeyCheck, decision 2026-10-29).

import { unwrapsLastFiveMinutes } from '../../services/credential/unwrapRate.service.ts';
import { fetchDocument } from '../../contracts/credential/documentFetch.contract.ts';
import { fetchPublicDocument } from '../../services/credential/documentFetch.service.ts';
import { createOutboundWebhookSecret, signOutboundWebhook } from '../../contracts/credential/outboundWebhookSecret.contract.ts';
import {
  revokeConnectionCredentials, sealAgentCredentials, sendAuthorisedRequest, sendSftpRequest, storeConnectionCredentials,
} from '../../contracts/credential/connectionCredential.contract.ts';
import {
  discoverOAuthMetadata, exchangeAuthorisationCode, refreshAccessToken, registerOAuthDynamicClient, revokeOAuthClientSecret, sealOAuthVerifier, storeOAuthClientSecret,
} from '../../contracts/credential/oauthCredential.contract.ts';
import {
  completeFederatedSignIn, directoryEmailHash, readIdentityProvider, readServiceProviderMetadata, receiveSamlLogout, startFederatedSignIn,
  startSamlLogout, storeIdentityProvider,
} from '../../contracts/credential/identityProvider.contract.ts';
import { openRecordValues, sealRecordValues } from '../../contracts/credential/recordValue.contract.ts';
import { hashForEntityGraph } from '../../contracts/credential/entityHash.contract.ts';
import { enrolTotp, verifyTotp } from '../../contracts/credential/totp.contract.ts';
import { sealWebhookSecret, verifyWebhookDelivery } from '../../contracts/credential/changeStream.contract.ts';
import { createActionEventSecret, signActionEvent } from '../../contracts/credential/actionEventSecret.contract.ts';
import { issueOpcUaApplicationCertificate, sealOpcUaApplicationKey } from '../../contracts/credential/opcuaApplication.contract.ts';
import { opcUaApplicationController } from '../../controllers/credential/opcuaApplication.controller.ts';
import { createOpcUaApplications } from '../../services/credential/opcuaApplication.service.ts';
import { actionEventSecretController } from '../../controllers/credential/actionEventSecret.controller.ts';
import { createActionEventSecrets } from '../../services/credential/actionEventSecret.service.ts';
import { changeStreamCredentialController } from '../../controllers/credential/changeStream.controller.ts';
import { createChangeStreamCredentials } from '../../services/credential/changeStream.service.ts';
import { entityHashController } from '../../controllers/credential/entityHash.controller.ts';
import { createOrganisationKeys } from '../../services/credential/organisationKey.service.ts';
import { createOrganisationKeyStore } from '../../services/credential/organisationKeyStore.service.ts';
import { recordValueController } from '../../controllers/credential/recordValue.controller.ts';
import { createRecordValueCipher } from '../../services/credential/recordValue.service.ts';
import { identityProviderController } from '../../controllers/credential/identityProvider.controller.ts';
import { createDirectoryHasher } from '../../services/credential/directoryHash.service.ts';
import { createIdentityProviders } from '../../services/credential/identityProvider.service.ts';
import { createSftpMediator } from '../../services/credential/sftp.service.ts';
import { connectionCredentialController, sftpController } from '../../controllers/credential/connectionCredential.controller.ts';
import { oauthCredentialController } from '../../controllers/credential/oauthCredential.controller.ts';
import { totpController } from '../../controllers/credential/totp.controller.ts';
import { tenantKeysController } from '../../controllers/credential/tenantKeys.controller.ts';
import { exportOrganisationKeys, importOrganisationKeys, openTenantBundleKey, tenantImportKey } from '../../contracts/credential/tenantKeys.contract.ts';
import { createTenantKeys } from '../../services/credential/tenantKeys.service.ts';
import { createEgress, createTcpEgress } from '../../infra/egress.infra.ts';
import { route } from '../../infra/http.infra.ts';
import { createConnectionCredentials } from '../../services/credential/connectionCredential.service.ts';
import { createOAuthCredentials } from '../../services/credential/oauthCredential.service.ts';
import { DekCache } from '../../utils/envelope.util.ts';
import { createKeyManagement, startupKeyCheck } from '../../infra/kms.infra.ts';
import { defineService } from '../../infra/service.infra.ts';
import { createCredentialService, repoKeyRegistry } from '../../services/credential/credential.service.ts';
import { AppError } from '../../utils/errors.util.ts';
import { readKeyRotation, startKeyRotation } from '../../contracts/credential/keyRotation.contract.ts';
import { createKeyRotation } from '../../services/credential/keyRotation.service.ts';
import { sleep } from '../../utils/time.util.ts';

/** How often a rotation's sweep runs: a rotation is rare; each round re-wraps what is left. */
const ROTATION_SWEEP_MS = 10_000;

export const service = defineService({
  name: 'credential',
  needs: { postgres: ['control'] },
  async create(deps) {
    // Unwraps a minute, for the page on unwrap anomalies (13.2; D252).
    deps.signals.gauge('credential_unwraps_5m', async () => unwrapsLastFiveMinutes());
    if (deps.config.kms === undefined) throw new AppError('configuration', 'the credential service needs KMS_PROVIDER', { code: 'config.kms' });
    const kms = await createKeyManagement(deps.config.kms);
    const registry = repoKeyRegistry(deps.databases, kms.provider);
    try {
      await startupKeyCheck(kms, registry);
    } catch (error) {
      // startup_refused_no_kms_key (spec 61.9): before any organisation is reached, so the cell's own log carries it for operations.
      deps.logger.failure('no usable KMS key: the credential service refuses to start', error, { event: 'startup_refused_no_kms_key' });
      await kms.close();
      throw error;
    }
    // One DEK cache for every secret this process opens (spec 61.4).
    const cache = new DekCache();
    const credential = createCredentialService({ kms, registry, databases: deps.databases, logger: deps.logger, cache });
    const totp = totpController(credential);
    const egress = createEgress(deps.config.connect);
    const mediated = createConnectionCredentials({ keys: credential.keys, cache, databases: deps.databases, egress });
    const connections = connectionCredentialController(mediated);
    // SFTP (spec 14.4): the SSH session runs here, beside the login, over TCP under the egress's rules.
    const sftp = sftpController(createSftpMediator({ credentials: mediated, tcp: createTcpEgress(deps.config.connect) }));
    // Change streams (spec 18.8): webhook signing secrets, and deliveries verified here.
    const streams = changeStreamCredentialController(createChangeStreamCredentials({ keys: credential.keys, databases: deps.databases, credentials: mediated }));
    // Outbound Action events (spec 48.3): each subscription's signing secret, opened only to sign.
    const actionEvents = actionEventSecretController(createActionEventSecrets({ keys: credential.keys, databases: deps.databases, credentials: mediated }));
    // OPC UA (spec 20.3): each signed endpoint's application key, made and held here, sealed to its agent per piece of work.
    const opcua = opcUaApplicationController(createOpcUaApplications({ keys: credential.keys, databases: deps.databases, credentials: mediated }));
    const oauth = oauthCredentialController(createOAuthCredentials({
      keys: credential.keys, cache, databases: deps.databases, egress, credentials: mediated,
    }));
    // Identity providers (spec 55.5): sealed here, their answers verified here.
    const sso = deps.config.sso;
    const idp = identityProviderController(createIdentityProviders({
      // The cell's SAML SP key pair, and the next during a rotation (decision 2026-11-14).
      sp: sso.samlSpPrivateKey === undefined || sso.samlSpCertificate === undefined ? undefined : {
        privateKey: sso.samlSpPrivateKey, certificate: sso.samlSpCertificate,
        next: sso.samlSpNextPrivateKey === undefined || sso.samlSpNextCertificate === undefined ? undefined
          : { privateKey: sso.samlSpNextPrivateKey, certificate: sso.samlSpNextCertificate },
      },
      keys: credential.keys, cache, databases: deps.databases, egress, logger: deps.logger,
      allowInsecureRequests: deps.config.connect.egressAllowHttp,
    }), createDirectoryHasher(kms, deps.config.kms.directoryKeyUri, deps.config.globalTier.directory.keyVersion));
    // Each organisation's own keys: data (record values at rest) and hmac (the entity
    // graph's keyed hashes, spec 23.3).
    const organisationKeyStore = createOrganisationKeyStore({ keys: credential.keys, databases: deps.databases, logger: deps.logger });
    const recordValues = recordValueController(createRecordValueCipher(organisationKeyStore));
    const entityHashes = entityHashController(createOrganisationKeys(organisationKeyStore));
    // Tenant migrations (spec 6.4): the organisation's keys sealed to another cell's import
    // key, and keys sealed to this cell's import key wrapped under this cell's KEK.
    const tenantKeys = tenantKeysController(createTenantKeys({
      kms, importKeyUri: deps.config.kms.importKeyUri, keys: credential.keys, databases: deps.databases, logger: deps.logger,
    }));
    // KEK rotation (spec 61.2): started by staff, swept here until every secret is re-wrapped.
    const rotation = createKeyRotation({ kms, databases: deps.databases, logger: deps.logger });
    return {
      workers: [{
        name: 'key-rotation-sweep',
        async run(signal) {
          while (!signal.aborted) {
            try {
              await rotation.sweep();
            } catch (error) {
              deps.logger.failure('the key rotation sweep failed; the next round retries', error, { event: 'kms.rotation_sweep_failed' });
            }
            await sleep(ROTATION_SWEEP_MS, signal).catch(() => undefined);
          }
        },
      }],
      routes: [
        route(startKeyRotation, { handle: ({ body }, ctx) => rotation.start(body, ctx.correlationId) }),
        route(readKeyRotation, { handle: () => rotation.status() }),
        route(enrolTotp, totp.enrol), route(verifyTotp, totp.verify),
        route(storeConnectionCredentials, connections.store), route(revokeConnectionCredentials, connections.revoke),
        route(sendAuthorisedRequest, connections.send), route(sendSftpRequest, sftp.request), route(sealAgentCredentials, connections.sealForAgent),
        route(issueOpcUaApplicationCertificate, opcua.issue), route(sealOpcUaApplicationKey, opcua.sealKey),
        route(sealOAuthVerifier, oauth.sealVerifier), route(exchangeAuthorisationCode, oauth.exchange),
        route(refreshAccessToken, oauth.refresh), route(storeOAuthClientSecret, oauth.storeClientSecret),
        route(revokeOAuthClientSecret, oauth.revokeClientSecret),
        route(discoverOAuthMetadata, oauth.discover), route(registerOAuthDynamicClient, oauth.registerDynamic),
        route(fetchDocument, { handle: ({ body }) => fetchPublicDocument(egress, body.url) }),
        route(storeIdentityProvider, idp.store), route(readIdentityProvider, idp.read),
        route(startFederatedSignIn, idp.start), route(completeFederatedSignIn, idp.complete),
        route(readServiceProviderMetadata, idp.metadata), route(startSamlLogout, idp.logoutStart), route(receiveSamlLogout, idp.logoutReceive),
        route(directoryEmailHash, idp.directoryHash),
        route(sealWebhookSecret, streams.storeSecret), route(verifyWebhookDelivery, streams.verify),
        route(createActionEventSecret, actionEvents.create), route(signActionEvent, actionEvents.sign), route(createOutboundWebhookSecret, actionEvents.createWebhook), route(signOutboundWebhook, actionEvents.signWebhook),
        route(sealRecordValues, recordValues.toSealed), route(openRecordValues, recordValues.toOpened),
        route(hashForEntityGraph, entityHashes.hash),
        route(tenantImportKey, tenantKeys.importKey), route(exportOrganisationKeys, tenantKeys.export),
        route(importOrganisationKeys, tenantKeys.import), route(openTenantBundleKey, tenantKeys.openBundleKey),
      ],
      close: async () => {
        organisationKeyStore.close();
        await kms.close();
      },
    };
  },
});
