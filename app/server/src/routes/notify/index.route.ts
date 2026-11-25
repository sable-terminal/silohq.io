// The notify service (spec 7.5): email through the cell's SMTP relay and in-product items,
// and outbound Action events (48.3) taken from bus-durable and delivered, signed, to the
// customer systems that subscribe. References only, never record values. Its login is a
// member of silo_app.

import { listPushDevices, registerPushDevice, removePushDevice } from '../../contracts/notify/notification.contract.ts';
import { createPushSender, type PushSender } from '../../infra/push.infra.ts';
import { createWebhookDelivery, type WebhookDelivery } from '../../services/notify/webhooks.service.ts';
import { sendAuthEmail, sendSignupEmail } from '../../contracts/notify/authEmail.contract.ts';
import {
  acknowledgeNotification, listNotifications, markNotificationRead, raiseNotification, readNotification,
} from '../../contracts/notify/notification.contract.ts';
import { notifyController } from '../../controllers/notify/notify.controller.ts';
import { createEgress, type Egress } from '../../infra/egress.infra.ts';
import { route } from '../../infra/http.infra.ts';
import { defineService, type ServiceDefinition, type Worker } from '../../infra/service.infra.ts';
import { createActionEventDelivery, type ActionEventDelivery } from '../../services/notify/actionEvents.service.ts';
import { actionEventConsumerWorker, actionEventDeliveryWorker } from '../../workers/notify/actionEvents.worker.ts';
import { createSmtpMailer, type Mailer } from '../../services/notify/mailer.service.ts';
import { createNotify } from '../../services/notify/notify.service.ts';
import { AppError } from '../../utils/errors.util.ts';

export interface NotifyOptions {
  /** In place of the SMTP relay. */
  mailer?: Mailer;
  /** Take executed Actions' events from bus-durable (it needs the bus). The deployed service does; a test drives intake itself. */
  consumeActionEvents?: boolean;
  /** Deliver due Action events on a timer (default true); a test runs the sweep itself. */
  sweep?: boolean;
  /** In place of the egress (a test's endpoint). */
  egress?: Egress;
  /** In place of the configured push provider (a test's sender). */
  push?: PushSender;
  onActionEvents?: (delivery: ActionEventDelivery) => void;
  onWebhooks?: (delivery: WebhookDelivery) => void;
}

/** How often due Action event deliveries are attempted. */
const DELIVERY_SWEEP_MS = 15_000;

export function createNotifyService(options: NotifyOptions = {}): ServiceDefinition {
  return defineService({
    name: 'notify',
    needs: { postgres: ['control'], ...(options.consumeActionEvents ? { bus: ['durable'] as const } : {}) },
    create(deps) {
      const config = deps.config.notify;
      if (!config) throw new AppError('configuration', 'notify is not configured', { code: 'config.notify' });
      const mailer = options.mailer ?? createSmtpMailer(config);
      const push = options.push ?? (config.push === undefined ? undefined : createPushSender(config.push));
      const notify = createNotify({ config, databases: deps.databases, mailer, logger: deps.logger, push });
      const controller = notifyController(notify);
      const actionEvents = createActionEventDelivery({
        databases: deps.databases, services: deps.services, egress: options.egress ?? createEgress(deps.config.connect), notify, logger: deps.logger,
      });
      options.onActionEvents?.(actionEvents);
      const webhooks = createWebhookDelivery({
        databases: deps.databases, services: deps.services, egress: options.egress ?? createEgress(deps.config.connect), logger: deps.logger,
      });
      options.onWebhooks?.(webhooks);
      const workers: Worker[] = [];
      if (options.consumeActionEvents) {
        if (!deps.durableBus) throw new AppError('configuration', 'notify needs bus-durable for Action events', { code: 'config.bus.durable' });
        workers.push(actionEventConsumerWorker(deps.durableBus, actionEvents, 'notify'));
      }
      if (options.sweep !== false) {
        workers.push(actionEventDeliveryWorker(actionEvents, DELIVERY_SWEEP_MS, deps.logger));
        workers.push(actionEventDeliveryWorker(webhooks, DELIVERY_SWEEP_MS, deps.logger, 'notify-webhook-delivery'));
        workers.push(actionEventDeliveryWorker({ deliverDue: (id: string) => webhooks.checkEffectsDue(id) }, DELIVERY_SWEEP_MS, deps.logger, 'notify-webhook-effects'));
      }
      return {
        workers,
        routes: [
          route(sendAuthEmail, controller.sendAuthEmail),
          route(sendSignupEmail, controller.sendSignupEmail),
          route(raiseNotification, controller.raiseNotification),
          route(listNotifications, controller.listNotifications),
          route(registerPushDevice, controller.registerPushDevice), route(listPushDevices, controller.listPushDevices),
          route(removePushDevice, controller.removePushDevice),
          route(markNotificationRead, controller.markNotificationRead), route(readNotification, controller.readNotification),
          route(acknowledgeNotification, controller.acknowledgeNotification),
        ],
        close: async () => mailer.close(),
      };
    },
  });
}

/** The deployed service: it consumes Action events from bus-durable. */
export const service = createNotifyService({ consumeActionEvents: true });
