// A member's in-product notifications (spec 7.5 notify): listing them, marking one read,
// acknowledging one. Each reaches only the member's own items: the notify service scopes
// every read and change to the membership the gateway puts in the context, so no
// permission is asked.

import {
  acknowledgeNotification as acknowledge, listNotifications as list, listPushDevices as listDevices, markNotificationRead as markRead,
  readNotification as readOne,
  registerPushDevice as registerDevice, removePushDevice as removeDevice,
} from '../notify/notification.contract.ts';
import { z } from 'zod';
import { definePublicRoute } from './publicRoute.contract.ts';

export const listNotifications = definePublicRoute({
  name: 'listNotifications', method: 'GET', path: '/notifications', session: 'complete', ownRecords: true,
  query: list.query,
  response: list.response,
  forwards: list,
  // The query crosses again as text: unread goes back to the form the contract parses.
  call: ({ query: { unread, ...rest } }) => ({ query: { ...rest, ...(unread === undefined ? {} : { unread: String(unread) }) } }),
  reply: (output) => output,
});

/** One of the member's items: the page an emailed or pushed link opens. */
export const readNotification = definePublicRoute({
  name: 'readNotification', method: 'GET', path: '/notifications/:notificationId', session: 'complete', ownRecords: true,
  params: readOne.params,
  response: readOne.response,
  forwards: readOne,
  call: (input) => ({ params: input.params }),
  reply: (output) => output,
});

export const markNotificationRead = definePublicRoute({
  name: 'markNotificationRead', method: 'POST', path: '/notifications/:notificationId/read', session: 'complete', ownRecords: true,
  params: markRead.params,
  response: markRead.response,
  forwards: markRead,
  call: (input) => ({ params: input.params }),
  reply: (output) => output,
});

export const acknowledgeNotification = definePublicRoute({
  name: 'acknowledgeNotification', method: 'POST', path: '/notifications/:notificationId/acknowledgement', session: 'complete',
  ownRecords: true,
  params: acknowledge.params,
  response: acknowledge.response,
  forwards: acknowledge,
  call: (input) => ({ params: input.params }),
  reply: (output) => output,
});

// The member's own devices for mobile push (decision 2026-11-14): the token goes in, never comes back.
export const registerPushDevice = definePublicRoute({
  name: 'registerPushDevice', method: 'POST', path: '/push-devices', session: 'complete', ownRecords: true,
  body: registerDevice.body, response: registerDevice.response, status: 201, forwards: registerDevice,
  call: (input) => ({ body: input.body }), reply: (output) => output,
});

export const listPushDevices = definePublicRoute({
  name: 'listPushDevices', method: 'GET', path: '/push-devices', session: 'complete', ownRecords: true,
  response: listDevices.response, forwards: listDevices, call: () => ({}), reply: (output) => output,
});

export const removePushDevice = definePublicRoute({
  name: 'removePushDevice', method: 'DELETE', path: '/push-devices/:deviceId', session: 'complete', ownRecords: true,
  params: removeDevice.params, response: z.undefined(), forwards: removeDevice, call: (input) => ({ params: input.params }), reply: () => undefined,
});
