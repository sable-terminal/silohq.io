// The notify endpoints: contract to the service.

import type { sendAuthEmail, sendSignupEmail } from '../../contracts/notify/authEmail.contract.ts';
import type {
  acknowledgeNotification, listNotifications, listPushDevices, markNotificationRead, readNotification, raiseNotification, registerPushDevice, removePushDevice,
} from '../../contracts/notify/notification.contract.ts';
import type { HandlerContext, RouteHandlers } from '../../infra/http.infra.ts';
import type { Notify } from '../../services/notify/notify.service.ts';
import { AppError } from '../../utils/errors.util.ts';

// Items belong to a person: the gateway sends the membership of the session.
function recipient(ctx: HandlerContext): string {
  if (ctx.request.membershipId === undefined) {
    throw new AppError('forbidden', 'notifications belong to a member', { code: 'notify.member_required' });
  }
  return ctx.request.membershipId;
}

export function notifyController(notify: Notify): {
  sendAuthEmail: RouteHandlers<typeof sendAuthEmail>;
  sendSignupEmail: RouteHandlers<typeof sendSignupEmail>;
  raiseNotification: RouteHandlers<typeof raiseNotification>;
  listNotifications: RouteHandlers<typeof listNotifications>;
  registerPushDevice: RouteHandlers<typeof registerPushDevice>;
  listPushDevices: RouteHandlers<typeof listPushDevices>;
  removePushDevice: RouteHandlers<typeof removePushDevice>;
  markNotificationRead: RouteHandlers<typeof markNotificationRead>;
  readNotification: RouteHandlers<typeof readNotification>;
  acknowledgeNotification: RouteHandlers<typeof acknowledgeNotification>;
} {
  return {
    sendAuthEmail: {
      async handle(input, ctx) {
        await notify.sendAuthEmail(ctx.request.organisationId!, input.body);
        return undefined;
      },
    },
    sendSignupEmail: {
      async handle(input) {
        await notify.sendSignupEmail(input.body);
        return undefined;
      },
    },
    raiseNotification: { handle: (input, ctx) => notify.raise(ctx.request.organisationId!, input.body) },
    listNotifications: { handle: (input, ctx) => notify.list(ctx.request.organisationId!, recipient(ctx), input.query) },
    registerPushDevice: { handle: (input, ctx) => notify.registerPushDevice(ctx.request.organisationId!, recipient(ctx), input.body) },
    listPushDevices: { handle: (_input, ctx) => notify.listPushDevices(ctx.request.organisationId!, recipient(ctx)) },
    removePushDevice: {
      handle: async (input, ctx) => {
        await notify.removePushDevice(ctx.request.organisationId!, recipient(ctx), input.params.deviceId);
      },
    },
    readNotification: {
      handle: async (input, ctx) => ({ notification: await notify.read(ctx.request.organisationId!, recipient(ctx), input.params.notificationId) }),
    },
    markNotificationRead: {
      handle: async (input, ctx) => ({ notification: await notify.markRead(ctx.request.organisationId!, recipient(ctx), input.params.notificationId) }),
    },
    acknowledgeNotification: {
      handle: async (input, ctx) => ({ notification: await notify.acknowledge(ctx.request.organisationId!, recipient(ctx), input.params.notificationId) }),
    },
  };
}
