// What the person did in the workspace, as the client reports it (spec 33.5, 37; D208):
// recorded as the member, references, closed sets and counts only.

import type { ParsedInput } from '../../contracts/endpoint.contract.ts';
import type { recordWorkspaceInteraction } from '../../contracts/workspace/interaction.contract.ts';
import { inTransaction } from '../../infra/postgres.infra.ts';
import { member, recordEvent, type Context, type WorkspaceDeps } from './deps.service.ts';

type Interaction = ParsedInput<typeof recordWorkspaceInteraction>['body'];

export async function recordInteraction(deps: WorkspaceDeps, ctx: Context, input: Interaction): Promise<{ recorded: true }> {
  const me = member(ctx);
  await inTransaction(deps.databases.pool('control'), me.request, (db) => {
    switch (input.event) {
      case 'palette_command_run':
        return recordEvent(db, me, ctx.correlationId, { event: 'palette_command_run', resource: null, detail: { command: input.command, page: input.page } });
      case 'dashboard_tile_fallback':
        return recordEvent(db, me, ctx.correlationId, {
          event: 'dashboard_tile_fallback', resource: { type: 'view', id: input.savedViewId }, detail: { from: input.from, to: input.to, reason: input.reason },
        });
      case 'analysis_step_refused':
        return recordEvent(db, me, ctx.correlationId, {
          event: 'analysis_step_refused', resource: input.savedViewId === undefined ? null : { type: 'view', id: input.savedViewId },
          detail: { step: input.step, step_index: input.stepIndex, bound: input.bound, count: input.count },
        });
    }
  });
  return { recorded: true };
}
