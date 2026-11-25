// visual-builder (catalogue; spec 16.4): a connector built by hand, block by block, with the
// YAML view as the raw form of the same manifest. Drafts are tried against the live system
// through a sandbox connection as probes; publishing hands the release to conformance.

import {
  convertDraft, importDraft, publishDraft, setBuildSecrets, tryDraft, validateDraft,
} from '../../contracts/visual-builder/builder.contract.ts';
import { builderController } from '../../controllers/visual-builder/builder.controller.ts';
import { route } from '../../infra/http.infra.ts';
import { defineService } from '../../infra/service.infra.ts';
import { createVisualBuilder } from '../../services/visual-builder/visualBuilder.service.ts';

export const service = defineService({
  name: 'visual-builder',
  // redis-data holds the idempotency keys of tries and publications.
  needs: { postgres: ['control'], redis: ['data'] },
  create(deps) {
    const c = builderController(createVisualBuilder({ databases: deps.databases, services: deps.services, logger: deps.logger }));
    return {
      routes: [
        route(validateDraft, c.validateDraft), route(convertDraft, c.convertDraft), route(importDraft, c.importDraft), route(tryDraft, c.tryDraft),
        route(publishDraft, c.publishDraft), route(setBuildSecrets, c.setBuildSecrets),
      ],
    };
  },
});
