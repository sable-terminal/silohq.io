// The services this build can run. Each service's definition lives in
// src/routes/<service>/index.route.ts and is loaded only by a process that hosts it
// (SILO_SERVICE, SILO_SERVICES), so a process carries its own services' code and no other.
// Every Node service of the catalogue is here (silo-agent is a separate program).

import type { ServiceName } from './config/service.config.ts';
import type { ServiceDefinition } from './infra/service.infra.ts';
import { AppError } from './utils/errors.util.ts';

export const SERVICE_MODULES: Partial<Record<ServiceName, () => Promise<ServiceDefinition>>> = {
  auth: () => import('./routes/auth/index.route.ts').then((m) => m.service),
  actions: () => import('./routes/actions/index.route.ts').then((m) => m.service),
  approvals: () => import('./routes/approvals/index.route.ts').then((m) => m.service),
  revert: () => import('./routes/revert/index.route.ts').then((m) => m.service),
  billing: () => import('./routes/billing/index.route.ts').then((m) => m.service),
  metering: () => import('./routes/metering/index.route.ts').then((m) => m.service),
  credential: () => import('./routes/credential/index.route.ts').then((m) => m.service),
  'connect-registry': () => import('./routes/connect-registry/index.route.ts').then((m) => m.service),
  'connect-runtime': () => import('./routes/connect-runtime/index.route.ts').then((m) => m.service),
  'change-stream': () => import('./routes/change-stream/index.route.ts').then((m) => m.service),
  'state-plane': () => import('./routes/state-plane/index.route.ts').then((m) => m.service),
  oauth: () => import('./routes/oauth/index.route.ts').then((m) => m.service),
  'expression-evaluator': () => import('./routes/expression-evaluator/index.route.ts').then((m) => m.service),
  'pushdown-compiler': () => import('./routes/pushdown-compiler/index.route.ts').then((m) => m.service),
  conformance: () => import('./routes/conformance/index.route.ts').then((m) => m.service),
  catalogue: () => import('./routes/catalogue/index.route.ts').then((m) => m.service),
  'schema-inference': () => import('./routes/schema-inference/index.route.ts').then((m) => m.service),
  'visual-builder': () => import('./routes/visual-builder/index.route.ts').then((m) => m.service),
  'connector-builder': () => import('./routes/connector-builder/index.route.ts').then((m) => m.service),
  directory: () => import('./routes/directory/index.route.ts').then((m) => m.service),
  'fleet-control': () => import('./routes/fleet-control/index.route.ts').then((m) => m.service),
  gateway: () => import('./routes/gateway/index.route.ts').then((m) => m.service),
  status: () => import('./routes/status/index.route.ts').then((m) => m.service),
  policy: () => import('./routes/policy/index.route.ts').then((m) => m.service),
  audit: () => import('./routes/audit/index.route.ts').then((m) => m.service),
  notify: () => import('./routes/notify/index.route.ts').then((m) => m.service),
  'outbox-relay': () => import('./routes/outbox-relay/index.route.ts').then((m) => m.service),
  maintenance: () => import('./routes/maintenance/index.route.ts').then((m) => m.service),
  'tenant-migrations': () => import('./routes/tenant-migrations/index.route.ts').then((m) => m.service),
  'org-export': () => import('./routes/org-export/index.route.ts').then((m) => m.service),
  'fde-orchestrator': () => import('./routes/fde-orchestrator/index.route.ts').then((m) => m.service),
  'admin-portal': () => import('./routes/admin-portal/index.route.ts').then((m) => m.service),
  'model-gateway': () => import('./routes/model-gateway/index.route.ts').then((m) => m.service),
  'warehouse-provisioner': () => import('./routes/warehouse-provisioner/index.route.ts').then((m) => m.service),
  'warehouse-schema': () => import('./routes/warehouse-schema/index.route.ts').then((m) => m.service),
  'warehouse-sync': () => import('./routes/warehouse-sync/index.route.ts').then((m) => m.service),
  'warehouse-reconcile': () => import('./routes/warehouse-reconcile/index.route.ts').then((m) => m.service),
  'warehouse-access': () => import('./routes/warehouse-access/index.route.ts').then((m) => m.service),
  'import-loader': () => import('./routes/import-loader/index.route.ts').then((m) => m.service),
  'index-builder': () => import('./routes/index-builder/index.route.ts').then((m) => m.service),
  'bigquery-metering': () => import('./routes/bigquery-metering/index.route.ts').then((m) => m.service),
  'siloes-capture': () => import('./routes/siloes-capture/index.route.ts').then((m) => m.service),
  'siloes-import': () => import('./routes/siloes-import/index.route.ts').then((m) => m.service),
  scheduler: () => import('./routes/scheduler/index.route.ts').then((m) => m.service),
  files: () => import('./routes/files/index.route.ts').then((m) => m.service),
  render: () => import('./routes/render/index.route.ts').then((m) => m.service),
  ontology: () => import('./routes/ontology/index.route.ts').then((m) => m.service),
  compile: () => import('./routes/compile/index.route.ts').then((m) => m.service),
  planner: () => import('./routes/planner/index.route.ts').then((m) => m.service),
  executor: () => import('./routes/executor/index.route.ts').then((m) => m.service),
  resolution: () => import('./routes/resolution/index.route.ts').then((m) => m.service),
  workspace: () => import('./routes/workspace/index.route.ts').then((m) => m.service),
  'canvas-layout': () => import('./routes/canvas-layout/index.route.ts').then((m) => m.service),
  studio: () => import('./routes/studio/index.route.ts').then((m) => m.service),
  ask: () => import('./routes/ask/index.route.ts').then((m) => m.service),
  lineage: () => import('./routes/lineage/index.route.ts').then((m) => m.service),
  search: () => import('./routes/search/index.route.ts').then((m) => m.service),
  recognition: () => import('./routes/recognition/index.route.ts').then((m) => m.service),
  simulation: () => import('./routes/simulation/index.route.ts').then((m) => m.service),
  'connector-maintenance': () => import('./routes/connector-maintenance/index.route.ts').then((m) => m.service),
  discovery: () => import('./routes/discovery/index.route.ts').then((m) => m.service),
};

export async function loadServices(names: readonly ServiceName[]): Promise<ServiceDefinition[]> {
  const missing = names.filter((name) => SERVICE_MODULES[name] === undefined);
  if (missing.length > 0) {
    throw new AppError('configuration', `not built yet: ${missing.join(', ')}`, { code: 'config.service.not_built' });
  }
  return Promise.all(names.map((name) => SERVICE_MODULES[name]!()));
}
