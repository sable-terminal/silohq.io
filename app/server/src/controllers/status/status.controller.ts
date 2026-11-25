// The status service's endpoints: contracts to the board.
//
// Every registered cell's Fleet agent reports here; a cell reports only for itself (the
// HTTP layer names the calling cell). A caller inside the global tier itself may report
// for any.

import type { putNotice, putNoticeUpdate, readStatus, reportCellStatus } from '../../contracts/status/status.contract.ts';
import type { RouteHandlers } from '../../infra/http.infra.ts';
import type { StatusBoard } from '../../services/status/status.service.ts';
import { AppError } from '../../utils/errors.util.ts';

export function statusController(board: StatusBoard, selfCell: string): {
  reportCellStatus: RouteHandlers<typeof reportCellStatus>;
  putNotice: RouteHandlers<typeof putNotice>;
  putNoticeUpdate: RouteHandlers<typeof putNoticeUpdate>;
  readStatus: RouteHandlers<typeof readStatus>;
} {
  return {
    reportCellStatus: {
      handle: (input, ctx) => {
        if (ctx.callerCell !== selfCell && ctx.callerCell !== input.params.cellId) {
          throw new AppError('forbidden', 'a cell reports only for itself', { code: 'status.foreign_cell', details: { callerCell: ctx.callerCell } });
        }
        return board.report(input.params.cellId, input.body.reportedAt, input.body.components);
      },
    },
    putNotice: {
      handle: (input, ctx) => {
        ctx.logger.info('notice written', { event: 'status.notice_written', resourceType: 'operator', resourceId: input.body.postedBy });
        return board.putNotice(input.params.noticeId, input.body);
      },
    },
    putNoticeUpdate: {
      handle: (input, ctx) => {
        ctx.logger.info('notice update written', {
          event: 'status.notice_update_written', resourceType: 'operator', resourceId: input.body.postedBy,
        });
        return board.putNoticeUpdate(input.params.noticeId, input.params.updateId, input.body.state, input.body.message, input.body.postedBy);
      },
    },
    readStatus: {
      handle: () => board.document(),
    },
  };
}
