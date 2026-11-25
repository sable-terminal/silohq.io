// Asking and running (spec 26, 27): a question compiled to an answer, a refusal or a
// clarification; a plan in structure run without a model call; a stored plan; the reader's
// vocabulary for building plans in Explorer and Studio; and the further pages of a result.
// The gateway decides the route's permission first; compile decides query.compile and
// query.advanced again, and every element is checked against the reader's vocabulary.

import * as cp from '../compile/compile.contract.ts';
import * as cal from '../compile/calendar.contract.ts';
import * as ex from '../executor/result.contract.ts';
import * as ov from '../executor/objectView.contract.ts';
import * as at from '../executor/actionTargets.contract.ts';
import { definePublicRoute } from './publicRoute.contract.ts';

const view = { permission: 'ontology.view' };

export const compileQuestionRoute = definePublicRoute({
  name: 'compileQuestion', reads: true, method: 'POST', path: '/questions', session: 'complete', permission: { permission: 'query.compile' },
  body: cp.compileQuestion.body, response: cp.compileQuestion.response, forwards: cp.compileQuestion,
  call: (input) => ({ body: input.body }), reply: (output) => output,
});

export const runStructuredPlan = definePublicRoute({
  name: 'runStructuredPlan', reads: true, method: 'POST', path: '/plans', session: 'complete', permission: view,
  body: cp.compilePlan.body, response: cp.compilePlan.response, forwards: cp.compilePlan,
  call: (input) => ({ body: input.body }), reply: (output) => output,
});

export const readCompiledPlan = definePublicRoute({
  name: 'readCompiledPlan', method: 'GET', path: '/plans/:planId', session: 'complete', permission: view,
  params: cp.getCompiledPlan.params, response: cp.getCompiledPlan.response, forwards: cp.getCompiledPlan,
  call: (input) => ({ params: input.params }), reply: (output) => output,
});

export const readVocabulary = definePublicRoute({
  name: 'readVocabulary', method: 'GET', path: '/vocabulary', session: 'complete', permission: view,
  query: cp.getVocabulary.query, response: cp.getVocabulary.response, forwards: cp.getVocabulary,
  call: (input) => ({ query: input.query }), reply: (output) => output,
});

/** A result again, header and first page (spec 31.2): its own actor's, which the executor checks. */
export const readResult = definePublicRoute({
  name: 'readResult', method: 'GET', path: '/results/:queryId', session: 'complete', ownRecords: true,
  params: ex.readResult.params, response: ex.readResult.response, forwards: ex.readResult,
  call: (input) => ({ params: input.params }), reply: (output) => output,
});

/** A result's pages are its own actor's: the executor checks, so no permission covers them. */
export const readResultPage = definePublicRoute({
  name: 'readResultPage', method: 'GET', path: '/results/:queryId/pages/:page', session: 'complete', ownRecords: true,
  params: ex.readResultPage.params, response: ex.readResultPage.response, forwards: ex.readResultPage,
  call: (input) => ({ params: input.params }), reply: (output) => output,
});

/** One object, read live under the reader's access (spec 34.2, 34.3). */
export const readObjectView = definePublicRoute({
  name: 'readObjectView', reads: true, method: 'POST', path: '/objects/view', session: 'complete', permission: view,
  body: ov.readObjectView.body, response: ov.readObjectView.response, forwards: ov.readObjectView,
  call: (input) => ({ body: input.body }), reply: (output) => output,
});

/** A selection's targets for an Action (spec 29.6): what a proposal from the canvas would write, for one who may propose. */
export const resolveActionTargets = definePublicRoute({
  name: 'resolveActionTargets', reads: true, method: 'POST', path: '/objects/action-targets', session: 'complete', permission: { permission: 'mutation.propose' },
  body: at.resolveActionTargets.body, response: at.resolveActionTargets.response, forwards: at.resolveActionTargets, maxBodyBytes: 512 * 1024,
  call: (input) => ({ body: input.body }), reply: (output) => output,
});

export const readOrganisationCalendar = definePublicRoute({
  name: 'readOrganisationCalendar', method: 'GET', path: '/organisation/calendar', session: 'complete', decidedByService: 'any member reads the calendar their periods are reckoned in',
  response: cal.getOrganisationCalendar.response, forwards: cal.getOrganisationCalendar, call: () => ({}), reply: (o) => o,
});

export const setOrganisationCalendarRoute = definePublicRoute({
  name: 'setOrganisationCalendar', method: 'PUT', path: '/organisation/calendar', session: 'complete', permission: { permission: 'calendar.manage' },
  body: cal.setOrganisationCalendar.body, response: cal.setOrganisationCalendar.response, forwards: cal.setOrganisationCalendar,
  call: (i) => ({ body: i.body }), reply: (o) => o,
});

export const QUERY_ROUTES = [compileQuestionRoute, runStructuredPlan, readCompiledPlan, readVocabulary, readResult, readResultPage, readObjectView, resolveActionTargets,
  readOrganisationCalendar, setOrganisationCalendarRoute];
