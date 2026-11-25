// The Object Index in the product (spec 69.1 to 69.11): creating one (silo.create; keyed, so
// a retried create makes one), its nominations and their refresh (silo.manage).

import * as ix from '../index-builder/index.contract.ts';
import { definePublicRoute } from './publicRoute.contract.ts';

const manage = { permission: 'silo.manage' };

export const createObjectIndexRoute = definePublicRoute({
  name: 'createObjectIndex', method: 'POST', path: '/object-indexes', session: 'complete', permission: { permission: 'silo.create' },
  body: ix.createObjectIndex.body, response: ix.createObjectIndex.response, status: 201, forwards: ix.createObjectIndex,
  call: (input) => ({ body: input.body }), reply: (output) => output,
});

export const getObjectIndexRoute = definePublicRoute({
  name: 'getObjectIndex', method: 'GET', path: '/object-indexes/:siloId', session: 'complete', permission: manage,
  params: ix.getObjectIndex.params, response: ix.getObjectIndex.response, forwards: ix.getObjectIndex,
  call: (input) => ({ params: input.params }), reply: (output) => output,
});

export const addIndexTypeRoute = definePublicRoute({
  name: 'addIndexType', method: 'POST', path: '/object-indexes/:siloId/types', session: 'complete', permission: manage,
  params: ix.addIndexType.params, body: ix.addIndexType.body, response: ix.addIndexType.response, status: 201, forwards: ix.addIndexType,
  call: (input) => ({ params: input.params, body: input.body }), reply: (output) => output,
});

export const changeIndexPropertiesRoute = definePublicRoute({
  name: 'changeIndexProperties', method: 'POST', path: '/object-indexes/:siloId/types/:definitionId/properties', session: 'complete',
  permission: manage, params: ix.changeIndexProperties.params, body: ix.changeIndexProperties.body, response: ix.changeIndexProperties.response,
  forwards: ix.changeIndexProperties, call: (input) => ({ params: input.params, body: input.body }), reply: (output) => output,
});

export const removeIndexTypeRoute = definePublicRoute({
  name: 'removeIndexType', method: 'POST', path: '/object-indexes/:siloId/types/:definitionId/remove', session: 'complete', permission: manage,
  params: ix.removeIndexType.params, response: ix.removeIndexType.response, forwards: ix.removeIndexType,
  call: (input) => ({ params: input.params }), reply: (output) => output,
});

export const rebuildIndexTypeRoute = definePublicRoute({
  name: 'rebuildIndexType', method: 'POST', path: '/object-indexes/:siloId/types/:definitionId/rebuild', session: 'complete', permission: manage,
  params: ix.rebuildIndexType.params, response: ix.rebuildIndexType.response, status: 202, forwards: ix.rebuildIndexType,
  call: (input) => ({ params: input.params }), reply: (output) => output,
});

export const OBJECT_INDEX_ROUTES = [
  createObjectIndexRoute, getObjectIndexRoute, addIndexTypeRoute, changeIndexPropertiesRoute, removeIndexTypeRoute, rebuildIndexTypeRoute,
] as const;
