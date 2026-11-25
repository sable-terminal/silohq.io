// Crons in the product (spec 40): creating one needs automation.create; the rest reach a
// member's own Crons, or every Cron for a holder of automation.manage, which the scheduler
// decides per Cron for the membership the gateway puts in the context.

import * as cr from '../scheduler/cron.contract.ts';
import { definePublicRoute } from './publicRoute.contract.ts';

export const createCron = definePublicRoute({
  name: 'createCron', method: 'POST', path: '/crons', session: 'complete', permission: { permission: 'automation.create' },
  body: cr.createCron.body, response: cr.createCron.response, status: 201, forwards: cr.createCron,
  call: (input) => ({ body: input.body }), reply: (output) => output,
});

export const listCrons = definePublicRoute({
  name: 'listCrons', method: 'GET', path: '/crons', session: 'complete', ownRecords: true,
  query: cr.listCrons.query, response: cr.listCrons.response, forwards: cr.listCrons,
  call: (input) => ({ query: input.query }), reply: (output) => output,
});

export const readCron = definePublicRoute({
  name: 'readCron', method: 'GET', path: '/crons/:cronId', session: 'complete', ownRecords: true,
  params: cr.getCron.params, response: cr.getCron.response, forwards: cr.getCron,
  call: (input) => ({ params: input.params }), reply: (output) => output,
});

export const pauseCron = definePublicRoute({
  name: 'pauseCron', method: 'POST', path: '/crons/:cronId/pause', session: 'complete', ownRecords: true,
  params: cr.pauseCron.params, response: cr.pauseCron.response, forwards: cr.pauseCron,
  call: (input) => ({ params: input.params }), reply: (output) => output,
});

export const resumeCron = definePublicRoute({
  name: 'resumeCron', method: 'POST', path: '/crons/:cronId/resume', session: 'complete', ownRecords: true,
  params: cr.resumeCron.params, response: cr.resumeCron.response, forwards: cr.resumeCron,
  call: (input) => ({ params: input.params }), reply: (output) => output,
});

export const deleteCron = definePublicRoute({
  name: 'deleteCron', method: 'DELETE', path: '/crons/:cronId', session: 'complete', ownRecords: true,
  params: cr.deleteCron.params, response: cr.deleteCron.response, forwards: cr.deleteCron,
  call: (input) => ({ params: input.params }), reply: (output) => output,
});

export const runCronNow = definePublicRoute({
  name: 'runCronNow', method: 'POST', path: '/crons/:cronId/runs', session: 'complete', ownRecords: true,
  params: cr.runCronNow.params, response: cr.runCronNow.response, status: 202, forwards: cr.runCronNow,
  call: (input) => ({ params: input.params }), reply: (output) => output,
});

export const listCronRuns = definePublicRoute({
  name: 'listCronRuns', method: 'GET', path: '/crons/:cronId/runs', session: 'complete', ownRecords: true,
  params: cr.listCronRuns.params, query: cr.listCronRuns.query, response: cr.listCronRuns.response, forwards: cr.listCronRuns,
  call: (input) => ({ params: input.params, query: input.query }), reply: (output) => output,
});

export const acknowledgeCronEscalation = definePublicRoute({
  name: 'acknowledgeCronEscalation', method: 'POST', path: '/cron-escalations/:runActionId/acknowledgement', session: 'complete',
  ownRecords: true,
  params: cr.acknowledgeEscalation.params, response: cr.acknowledgeEscalation.response, forwards: cr.acknowledgeEscalation,
  call: (input) => ({ params: input.params }), reply: (output) => output,
});

/** Sharing a Cron (spec 40.8): the owner's, within the sharing policy, which the scheduler decides for the membership in the context. */
export const shareCron = definePublicRoute({
  name: 'shareCron', method: 'PUT', path: '/crons/:cronId/shares', session: 'complete', ownRecords: true,
  params: cr.shareCron.params, body: cr.shareCron.body, response: cr.shareCron.response, forwards: cr.shareCron,
  call: (input) => ({ params: input.params, body: input.body }), reply: (output) => output,
});

export const revokeCronShare = definePublicRoute({
  name: 'revokeCronShare', method: 'POST', path: '/crons/:cronId/shares/:shareId/revoke', session: 'complete', ownRecords: true,
  params: cr.revokeCronShare.params, response: cr.revokeCronShare.response, forwards: cr.revokeCronShare,
  call: (input) => ({ params: input.params }), reply: (output) => output,
});

export const listCronShares = definePublicRoute({
  name: 'listCronShares', method: 'GET', path: '/crons/:cronId/shares', session: 'complete', ownRecords: true,
  params: cr.listCronShares.params, response: cr.listCronShares.response, forwards: cr.listCronShares,
  call: (input) => ({ params: input.params }), reply: (output) => output,
});

export const SCHEDULER_ROUTES = [
  createCron, listCrons, readCron, pauseCron, resumeCron, deleteCron, runCronNow, listCronRuns, acknowledgeCronEscalation,
  shareCron, revokeCronShare, listCronShares,
];
