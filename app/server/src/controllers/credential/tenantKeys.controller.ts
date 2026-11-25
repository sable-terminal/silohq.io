// The credential service's tenant migration keys: the organisation from the request
// context, never the body.

import type { exportOrganisationKeys, importOrganisationKeys, openTenantBundleKey, tenantImportKey } from '../../contracts/credential/tenantKeys.contract.ts';
import type { RouteHandlers } from '../../infra/http.infra.ts';
import type { TenantKeys } from '../../services/credential/tenantKeys.service.ts';

export function tenantKeysController(keys: TenantKeys): {
  importKey: RouteHandlers<typeof tenantImportKey>;
  export: RouteHandlers<typeof exportOrganisationKeys>;
  import: RouteHandlers<typeof importOrganisationKeys>;
  openBundleKey: RouteHandlers<typeof openTenantBundleKey>;
} {
  return {
    importKey: { handle: () => keys.importKey() },
    export: {
      handle: async (input, ctx) => ({ keys: await keys.export(ctx.request.organisationId!, input.body.migrationId, input.body.destinationKey) }),
    },
    import: { handle: (input, ctx) => keys.import(ctx.request.organisationId!, input.body.migrationId, input.body.keys) },
    openBundleKey: { handle: (input) => keys.openBundleKey(input.body.migrationId, input.body.sealedKey) },
  };
}
