// Search in the product (spec 33.5 Cmd-K, 34.1 Explorer): ontology search over the person's
// vocabulary and federated object search. Both need ontology.view; the search service applies
// the person's markings, connection grants and field policies itself. POST, so the search
// text travels in the body and stays out of access logs.

import * as sr from '../search/search.contract.ts';
import { definePublicRoute } from './publicRoute.contract.ts';

const view = { permission: 'ontology.view' };

export const searchVocabulary = definePublicRoute({
  name: 'searchVocabulary', reads: true, method: 'POST', path: '/search/vocabulary', session: 'complete', permission: view,
  body: sr.searchVocabulary.body, response: sr.searchVocabulary.response, forwards: sr.searchVocabulary,
  call: (input) => ({ body: input.body }), reply: (output) => output,
});

export const searchObjects = definePublicRoute({
  name: 'searchObjects', reads: true, method: 'POST', path: '/search/objects', session: 'complete', permission: view,
  body: sr.searchObjects.body, response: sr.searchObjects.response, forwards: sr.searchObjects,
  call: (input) => ({ body: input.body }), reply: (output) => output,
});

export const SEARCH_ROUTES = [searchVocabulary, searchObjects] as const;
