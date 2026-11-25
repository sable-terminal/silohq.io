// Ask in the product (spec 36): threads and turns. Starting a thread and asking need
// query.compile (the ask service decides again, with query.advanced for an advanced
// compile). A thread is private: reading, renaming, archiving, scoping it and re-running
// its answers reach only the member's own threads, which the ask service scopes to the
// membership the gateway puts in the context.

import * as th from '../ask/thread.contract.ts';
import { definePublicRoute } from './publicRoute.contract.ts';

const compile = { permission: 'query.compile' };

export const createAskThread = definePublicRoute({
  name: 'createAskThread', method: 'POST', path: '/ask/threads', session: 'complete', permission: compile,
  body: th.createThread.body, response: th.createThread.response, status: 201, forwards: th.createThread,
  call: (input) => ({ body: input.body }), reply: (output) => output,
});

export const listAskThreads = definePublicRoute({
  name: 'listAskThreads', method: 'GET', path: '/ask/threads', session: 'complete', ownRecords: true,
  query: th.listThreads.query, response: th.listThreads.response, forwards: th.listThreads,
  // The query crosses again as text: archived goes back to the form the contract parses.
  call: ({ query: { archived, ...rest } }) => ({ query: { ...rest, archived: String(archived) } }),
  reply: (output) => output,
});

export const readAskThread = definePublicRoute({
  name: 'readAskThread', method: 'GET', path: '/ask/threads/:threadId', session: 'complete', ownRecords: true,
  params: th.getThread.params, response: th.getThread.response, forwards: th.getThread,
  call: (input) => ({ params: input.params }), reply: (output) => output,
});

export const renameAskThread = definePublicRoute({
  name: 'renameAskThread', method: 'PATCH', path: '/ask/threads/:threadId', session: 'complete', ownRecords: true,
  params: th.renameThread.params, body: th.renameThread.body, response: th.renameThread.response, forwards: th.renameThread,
  call: (input) => ({ params: input.params, body: input.body }), reply: (output) => output,
});

export const archiveAskThread = definePublicRoute({
  name: 'archiveAskThread', method: 'POST', path: '/ask/threads/:threadId/archive', session: 'complete', ownRecords: true,
  params: th.archiveThread.params, response: th.archiveThread.response, forwards: th.archiveThread,
  call: (input) => ({ params: input.params }), reply: (output) => output,
});

export const scopeAskThread = definePublicRoute({
  name: 'scopeAskThread', method: 'PUT', path: '/ask/threads/:threadId/scope', session: 'complete', ownRecords: true,
  params: th.widenThreadScope.params, body: th.widenThreadScope.body, response: th.widenThreadScope.response, forwards: th.widenThreadScope,
  call: (input) => ({ params: input.params, body: input.body }), reply: (output) => output,
});

export const askQuestion = definePublicRoute({
  name: 'askQuestion', method: 'POST', path: '/ask/threads/:threadId/turns', session: 'complete', permission: compile,
  params: th.askQuestion.params, body: th.askQuestion.body, response: th.askQuestion.response, status: 201, forwards: th.askQuestion,
  maxBodyBytes: 16 * 1024,
  call: (input) => ({ params: input.params, body: input.body }), reply: (output) => output,
});

export const rerunAskTurn = definePublicRoute({
  name: 'rerunAskTurn', method: 'POST', path: '/ask/threads/:threadId/turns/:sequence/runs', session: 'complete', ownRecords: true,
  params: th.rerunTurn.params, response: th.rerunTurn.response, forwards: th.rerunTurn,
  call: (input) => ({ params: input.params }), reply: (output) => output,
});

/** The web context policy: the organisation's switch for anyone in it; scope policies where the reader holds ask.web.manage. */
export const readAskWebPolicy = definePublicRoute({
  name: 'readAskWebPolicy', method: 'GET', path: '/ask/web-policy', session: 'complete', ownRecords: true,
  response: th.readAskWebPolicy.response, forwards: th.readAskWebPolicy,
  call: () => ({}), reply: (output) => output,
});

/** ask.web.manage (36.7): the organisation's web context on or off. */
export const setAskWebPolicy = definePublicRoute({
  name: 'setAskWebPolicy', method: 'PUT', path: '/ask/web-policy', session: 'complete', permission: { permission: 'ask.web.manage' },
  body: th.setAskWebPolicy.body, response: th.setAskWebPolicy.response, forwards: th.setAskWebPolicy,
  call: (input) => ({ body: input.body }), reply: (output) => output,
});

/** ask.web.manage at the scope (D89): web context on or off there, domain lists, marked data covered. */
export const setAskWebScopePolicy = definePublicRoute({
  name: 'setAskWebScopePolicy', method: 'PUT', path: '/ask/web-policy/scopes/:scopeId', session: 'complete',
  permission: { permission: 'ask.web.manage', scopeId: (input) => input.params.scopeId },
  params: th.setAskWebScopePolicy.params, body: th.setAskWebScopePolicy.body, response: th.setAskWebScopePolicy.response, forwards: th.setAskWebScopePolicy,
  call: (input) => ({ params: input.params, body: input.body }), reply: (output) => output,
});

export const ASK_ROUTES = [
  createAskThread, listAskThreads, readAskThread, renameAskThread, archiveAskThread, scopeAskThread, askQuestion, rerunAskTurn, readAskWebPolicy, setAskWebPolicy,
  setAskWebScopePolicy,
];
