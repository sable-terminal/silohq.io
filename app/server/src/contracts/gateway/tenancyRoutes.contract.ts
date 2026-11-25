// Tenancy in the product: where the organisation lives and its moves between cells (spec
// 6.4, 6.7), and the exit export (spec 2.6). The gateway's permission is the gate on each:
// org.residency.view for any member, org.migration.request and org.export for a super
// admin, org.migration.approve for the answer to a rebalancing notice.
//
// The operator's side of a migration (signatures, the window, the import key, aborting) is
// admin-portal's, never the product's.

import * as e from '../org-export/export.contract.ts';
import * as m from '../tenant-migrations/migration.contract.ts';
import { definePublicRoute } from './publicRoute.contract.ts';

const residency = { permission: 'org.residency.view' } as const;

export const getResidency = definePublicRoute({
    name: 'getResidency', method: 'GET', path: '/residency', session: 'complete', permission: residency,
    response: m.getResidency.response, forwards: m.getResidency, call: () => ({}), reply: (o) => o,
  });

export const listTenantMigrations = definePublicRoute({
    name: 'listTenantMigrations', method: 'GET', path: '/tenant-migrations', session: 'complete', permission: residency,
    response: m.listTenantMigrations.response, forwards: m.listTenantMigrations, call: () => ({}), reply: (o) => o,
  });

export const getTenantMigration = definePublicRoute({
    name: 'getTenantMigration', method: 'GET', path: '/tenant-migrations/:migrationId', session: 'complete', permission: residency,
    params: m.getTenantMigration.params, response: m.getTenantMigration.response, forwards: m.getTenantMigration,
    call: (i) => ({ params: i.params }), reply: (o) => o,
  });

export const requestTenantMigration = definePublicRoute({
    name: 'requestTenantMigration', method: 'POST', path: '/tenant-migrations', session: 'complete',
    permission: { permission: 'org.migration.request' },
    body: m.requestTenantMigration.body, response: m.requestTenantMigration.response, status: 201, forwards: m.requestTenantMigration,
    call: (i) => ({ body: i.body }), reply: (o) => o,
  });

export const respondToRebalancing = definePublicRoute({
    name: 'respondToRebalancing', method: 'POST', path: '/tenant-migrations/:migrationId/response', session: 'complete',
    permission: { permission: 'org.migration.approve' },
    params: m.respondToRebalancing.params, body: m.respondToRebalancing.body, response: m.respondToRebalancing.response,
    forwards: m.respondToRebalancing, call: (i) => ({ params: i.params, body: i.body }), reply: (o) => o,
  });

export const withdrawTenantMigration = definePublicRoute({
    name: 'withdrawTenantMigration', method: 'POST', path: '/tenant-migrations/:migrationId/withdraw', session: 'complete',
    permission: { permission: 'org.migration.request' },
    params: m.withdrawTenantMigration.params, response: m.withdrawTenantMigration.response, forwards: m.withdrawTenantMigration,
    call: (i) => ({ params: i.params }), reply: (o) => o,
  });

export const requestOrgExport = definePublicRoute({
    name: 'requestOrgExport', method: 'POST', path: '/org-exports', session: 'complete', permission: { permission: 'org.export' },
    response: e.requestOrgExport.response, status: 202, forwards: e.requestOrgExport, call: () => ({}), reply: (o) => o,
  });

export const listOrgExports = definePublicRoute({
    name: 'listOrgExports', method: 'GET', path: '/org-exports', session: 'complete', permission: { permission: 'org.export' },
    response: e.listOrgExports.response, forwards: e.listOrgExports, call: () => ({}), reply: (o) => o,
  });

export const getOrgExport = definePublicRoute({
    name: 'getOrgExport', method: 'GET', path: '/org-exports/:exportId', session: 'complete', permission: { permission: 'org.export' },
    params: e.getOrgExport.params, response: e.getOrgExport.response, forwards: e.getOrgExport, call: (i) => ({ params: i.params }), reply: (o) => o,
  });

export const downloadOrgExport = definePublicRoute({
    name: 'downloadOrgExport', method: 'GET', path: '/org-exports/:exportId/content', session: 'complete', permission: { permission: 'org.export' },
    params: e.downloadOrgExport.params, query: e.downloadOrgExport.query, response: e.downloadOrgExport.response, forwards: e.downloadOrgExport,
    call: (i) => ({ params: i.params, query: i.query }), reply: (o) => o,
  });

export const TENANCY_ROUTES = [
  getResidency,
  listTenantMigrations,
  getTenantMigration,
  requestTenantMigration,
  respondToRebalancing,
  withdrawTenantMigration,
  requestOrgExport,
  listOrgExports,
  getOrgExport,
  downloadOrgExport,
] as const;
