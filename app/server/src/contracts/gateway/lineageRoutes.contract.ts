// Lineage in the product (spec 59.4, 59.5): the sources of a figure or artefact a person can
// see (lineage.view, every member), and the reviewer's queries from the Governance page
// (lineage.read). The lineage service decides again: lineage.read must be held
// organisation-wide, and the reader's markings withhold what they do not satisfy.

import { exportLineage } from '../lineage/export.contract.ts';
import * as ln from '../lineage/lineage.contract.ts';
import { definePublicRoute } from './publicRoute.contract.ts';

const review = { permission: 'lineage.read' };

export const readLineage = definePublicRoute({
  name: 'readLineage', method: 'GET', path: '/lineage/upstream', session: 'complete', permission: { permission: 'lineage.view' },
  query: ln.getLineage.query, response: ln.getLineage.response, forwards: ln.getLineage,
  call: (input) => ({ query: input.query }), reply: (output) => output,
});

export const reviewLineageUpstream = definePublicRoute({
  name: 'reviewLineageUpstream', method: 'GET', path: '/lineage/review/upstream', session: 'complete', permission: review,
  query: ln.queryUpstream.query, response: ln.queryUpstream.response, forwards: ln.queryUpstream,
  call: (input) => ({ query: input.query }), reply: (output) => output,
});

export const reviewLineageDownstream = definePublicRoute({
  name: 'reviewLineageDownstream', method: 'GET', path: '/lineage/review/downstream', session: 'complete', permission: review,
  query: ln.queryDownstream.query, response: ln.queryDownstream.response, forwards: ln.queryDownstream,
  call: (input) => ({ query: input.query }), reply: (output) => output,
});

export const explainLineageMarkings = definePublicRoute({
  name: 'explainLineageMarkings', method: 'GET', path: '/lineage/review/markings', session: 'complete', permission: review,
  query: ln.explainMarkings.query, response: ln.explainMarkings.response, forwards: ln.explainMarkings,
  call: (input) => ({ query: input.query }), reply: (output) => output,
});

export const reviewLineageAccess = definePublicRoute({
  name: 'reviewLineageAccess', method: 'GET', path: '/lineage/review/access', session: 'complete', permission: review,
  query: ln.accessOverlay.query, response: ln.accessOverlay.response, forwards: ln.accessOverlay,
  call: (input) => ({ query: input.query }), reply: (output) => output,
});

/** A reviewer's query, stored in Files as a document carrying the markings of every node it names (spec 59.4, 59.7). */
export const exportLineageGraph = definePublicRoute({
  name: 'exportLineageGraph', method: 'POST', path: '/lineage/review/exports', session: 'complete', permission: review,
  body: exportLineage.body, response: exportLineage.response, status: 201, forwards: exportLineage,
  call: (input) => ({ body: input.body }), reply: (output) => output,
});

export const LINEAGE_ROUTES = [
  readLineage, reviewLineageUpstream, reviewLineageDownstream, explainLineageMarkings, reviewLineageAccess, exportLineageGraph,
] as const;
