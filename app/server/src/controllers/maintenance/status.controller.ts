// The maintenance status endpoint.

import type { maintenanceStatus } from '../../contracts/maintenance/status.contract.ts';
import type { RouteHandlers } from '../../infra/http.infra.ts';
import type { Maintenance } from '../../services/maintenance/maintenance.service.ts';

export function statusController(maintenance: Maintenance): { maintenanceStatus: RouteHandlers<typeof maintenanceStatus> } {
  return { maintenanceStatus: { handle: async () => maintenance.status() } };
}
