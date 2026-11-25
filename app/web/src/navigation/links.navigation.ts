// The address of each thing a page links to, in one place: every page that links to an object, an
// app or a saved view builds the same address, and an address changes here once. Ids travel in
// the query string (a static export has no page per id).

import { hrefWith } from '../utils/href.util.ts';

/** An object's view: by its Silo id, or by the system holding it and that system's reference. */
export function objectHref(target: { objectTypeId: string; objectId: string } | { objectTypeId: string; connectionId: string; reference: string }): string {
  return 'objectId' in target
    ? hrefWith('/explorer/object/', { type: target.objectTypeId, id: target.objectId })
    : hrefWith('/explorer/object/', { type: target.objectTypeId, connection: target.connectionId, ref: target.reference });
}

/** A search hit's object: from the index by its Silo id, live from the first system that holds it. */
export function hitHref(hit: { objectTypeId: string; identifier: string; sources: readonly { connectionId: string }[] }): string {
  const source = hit.sources[0];
  return source === undefined
    ? objectHref({ objectTypeId: hit.objectTypeId, objectId: hit.identifier })
    : objectHref({ objectTypeId: hit.objectTypeId, connectionId: source.connectionId, reference: hit.identifier });
}

export const typeHref = (objectTypeId: string): string => hrefWith('/explorer/types/', { type: objectTypeId });
export const appHref = (appId: string, version?: number): string => hrefWith('/studio/apps/', { app: appId, version });
export const appEditorHref = (appId: string): string => hrefWith('/studio/apps/', { edit: appId });
/** A saved view: an object set opens in Explorer, where it was made; any other in Ask. */
export const viewHref = (viewId: string, kind?: string): string => (kind === 'object_set' ? hrefWith('/explorer/types/', { view: viewId }) : hrefWith('/ask/views/', { view: viewId }));
export const threadHref = (threadId: string): string => hrefWith('/ask/threads/', { thread: threadId });
export const scenarioHref = (scenarioId: string): string => hrefWith('/scenarios/list/', { scenario: scenarioId });
export const findingHref = (findingId: string): string => hrefWith('/explorer/findings/', { finding: findingId });
export const approvalHref = (chainId: string): string => hrefWith('/governance/approvals/', { chain: chainId });
export const cronHref = (cronId: string): string => hrefWith('/governance/crons/', { cron: cronId });
export const connectionHref = (connectionId: string): string => hrefWith('/connect/connections/', { connection: connectionId });
