// The directory service (spec 6.2, 55.1), in the global tier: registration from the
// cells on the service listener, and login routing for the browser on the public listener
// (DIRECTORY_PUBLIC_PORT).
//
// It refuses to start unless every directory key version it uses exists in the KMS and
// can compute a MAC (startupKeyCheck), so a mistyped key fails at deploy time rather than
// routing every login to a decoy.

import { registrationController } from '../../controllers/directory/registration.controller.ts';
import {
  findOrganisation, moveOrganisation, registerCell, registerIdentity, registerOrganisation,
} from '../../contracts/directory/registration.contract.ts';
import { required } from '../../config/index.config.ts';
import { route } from '../../infra/http.infra.ts';
import { createKeyManagement } from '../../infra/kms.infra.ts';
import { defineService, type ServiceDefinition } from '../../infra/service.infra.ts';
import { createDirectory } from '../../services/directory/directory.service.ts';
import { AppError } from '../../utils/errors.util.ts';
import { publicListener } from '../../workers/directory/publicListener.worker.ts';

export interface DirectoryServiceOptions {
  /** Told the public listener's port once it listens (tests bind port 0). */
  onPublicListening?: (port: number) => void;
}

export function createDirectoryService(options: DirectoryServiceOptions = {}): ServiceDefinition {
  return defineService({
    name: 'directory',
    needs: { postgres: ['directory'] },
    async create(deps) {
      const settings = deps.config.globalTier.directory;
      const kmsConfig = required(deps.config.kms, 'KMS_PROVIDER');
      const current = { version: settings.keyVersion, keyUri: required(kmsConfig.directoryKeyUri, 'KMS_DIRECTORY_KEY_URI') };
      const keys = { current, all: [current, ...settings.previousKeys] };

      const kms = await createKeyManagement(kmsConfig);
      try {
        const unusable: string[] = [];
        for (const key of keys.all) {
          const verdict = await kms.verifyKey(key.keyUri, 'mac');
          if (verdict !== 'ok') unusable.push(`version ${key.version}: ${verdict}`);
        }
        if (unusable.length > 0) {
          throw new AppError('configuration', `directory keys not usable, refusing to start: ${unusable.join('; ')}`, {
            code: 'directory.keys_missing', details: { problems: unusable.length },
          });
        }
      } catch (error) {
        await kms.close();
        throw error;
      }

      const directory = createDirectory({
        databases: deps.databases, kms, keys, logger: deps.logger, sovereign: deps.config.cell.buildTarget === 'sovereign',
      });
      const handlers = registrationController(directory, deps.config.cell.id);
      return {
        routes: [
          route(registerCell, handlers.registerCell),
          route(registerOrganisation, handlers.registerOrganisation),
          route(moveOrganisation, handlers.moveOrganisation),
          route(registerIdentity, handlers.registerIdentity),
          route(findOrganisation, handlers.findOrganisation),
        ],
        workers: settings.publicPort === undefined ? [] : [publicListener({
          directory, config: settings, trustProxyHops: deps.config.http.trustProxyHops, logger: deps.logger,
          ...(options.onPublicListening ? { onListening: options.onPublicListening } : {}),
        })],
        close: () => kms.close(),
      };
    },
  });
}

export const service = createDirectoryService();
