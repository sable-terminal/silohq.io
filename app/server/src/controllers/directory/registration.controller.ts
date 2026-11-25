// The directory's service endpoints: contracts to the directory.
//
// Every registered cell calls the directory (the HTTP layer accepts any cell the global
// tier's CA issued and hands the handler that cell). A cell registers only itself, and
// organisations and identities in itself; a move is made by a cell at either end. A
// caller inside the global tier itself (fleet-control, here in this cell) may name any.

import type {
  findOrganisation, moveOrganisation, registerCell, registerIdentity, registerOrganisation,
} from '../../contracts/directory/registration.contract.ts';
import type { HandlerContext, RouteHandlers } from '../../infra/http.infra.ts';
import type { Directory } from '../../services/directory/directory.service.ts';
import { AppError } from '../../utils/errors.util.ts';

export function registrationController(directory: Directory, selfCell: string): {
  registerCell: RouteHandlers<typeof registerCell>;
  registerOrganisation: RouteHandlers<typeof registerOrganisation>;
  moveOrganisation: RouteHandlers<typeof moveOrganisation>;
  registerIdentity: RouteHandlers<typeof registerIdentity>;
  findOrganisation: RouteHandlers<typeof findOrganisation>;
} {
  const mayName = (ctx: HandlerContext, ...cells: string[]): void => {
    if (ctx.callerCell === selfCell || cells.includes(ctx.callerCell)) return;
    throw new AppError('forbidden', 'a cell registers only itself and what it holds', {
      code: 'directory.foreign_cell', details: { callerCell: ctx.callerCell },
    });
  };
  return {
    registerCell: {
      async handle(input, ctx) {
        mayName(ctx, input.params.cellId);
        const cell = await directory.registerCell(input.params.cellId, input.body);
        return {
          id: cell.id, kind: cell.kind, residency: cell.residency, hostname: cell.hostname, status: cell.status,
          // Counts once the cell's Fleet agent has reported them (D203).
          ...(cell.countsAt === null ? {} : { connectionCount: cell.connectionCount, countsAt: new Date(cell.countsAt).toISOString() }),
        };
      },
    },
    registerOrganisation: {
      async handle(input, ctx) {
        mayName(ctx, input.body.cellId);
        return directory.registerOrganisation(input.params.organisationSlug, input.body.cellId, input.body.status);
      },
    },
    moveOrganisation: {
      async handle(input, ctx) {
        mayName(ctx, input.body.fromCellId, input.body.toCellId);
        return directory.moveOrganisation(input.params.organisationSlug, input.body.fromCellId, input.body.toCellId);
      },
    },
    registerIdentity: {
      async handle(input, ctx) {
        mayName(ctx, input.body.cellId);
        return directory.registerIdentity(input.body.cellId, Buffer.from(input.body.emailHash, 'base64url'), input.body.hashKeyVersion);
      },
    },
    findOrganisation: {
      handle: (input) => directory.findOrganisation(input.params.organisationSlug),
    },
  };
}
