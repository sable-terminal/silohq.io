// What the person did on the canvas, as the client reports it (spec 28, 31.5, 31.9; D208):
// recorded as the member, references only, and only about a type the member can see.

import type { recordCanvasInteraction } from '../../contracts/canvas-layout/interaction.contract.ts';
import type { ParsedInput } from '../../contracts/endpoint.contract.ts';
import { inTransaction } from '../../infra/postgres.infra.ts';
import { AppError } from '../../utils/errors.util.ts';
import { access, mainManifest, member, recordEvent, type CanvasDeps, type Context } from './deps.service.ts';

type Interaction = ParsedInput<typeof recordCanvasInteraction>['body'];

export async function recordInteraction(deps: CanvasDeps, ctx: Context, input: Interaction): Promise<{ recorded: true }> {
  const me = member(ctx);
  const typeId = input.objectTypeId;
  if (typeId !== undefined) {
    // A type of the ontology, and one the person can see.
    const [manifest, seen] = await Promise.all([mainManifest(deps, ctx), access(deps, ctx, { objectTypes: [typeId] })]);
    if (!manifest.objectTypes.some((t) => t.id === typeId) || seen.decision !== 'allow' || seen.objectTypes.find((t) => t.id === typeId)?.visible !== true) {
      throw new AppError('forbidden', 'not a type you can see', { code: 'clone.not_visible' });
    }
  }
  await inTransaction(deps.databases.pool('control'), me.request, (db) => {
    switch (input.event) {
      case 'clone_opened':
        return recordEvent(db, me, ctx.correlationId, {
          event: 'clone_opened', resource: { type: 'object', id: input.objectId },
          detail: { object_type_id: input.objectTypeId, layout: input.layout ?? null, canvas_view_id: input.canvasViewId ?? null },
        });
      case 'element_drilled':
        return recordEvent(db, me, ctx.correlationId, {
          event: 'element_drilled', resource: { type: input.surface === 'view' ? 'view' : 'canvas_view', id: input.resultRef },
          detail: { element: input.element, object_type_id: input.objectTypeId ?? null, records: input.records },
        });
      case 'flag_opened':
        return recordEvent(db, me, ctx.correlationId, {
          event: 'flag_opened', resource: { type: 'object_type', id: input.objectTypeId },
          detail: { flag: input.flag, object_id: input.objectId ?? null, surface: input.surface },
        });
    }
  });
  return { recorded: true };
}
