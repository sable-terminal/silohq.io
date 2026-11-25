// The notify service (spec 7.5): email, in-product items and push, carrying references
// only, never record values.
//
// Auth emails: the reset or invitation link is rendered from the token auth sends, given
// to the relay, and dropped. Nothing about the email is stored; the log line names the
// kind and the organisation, never the address or the token. A transient relay failure is
// retried twice within the call.
//
// In-product items: raised by the service that owns the source, read and acknowledged by
// their recipient only. An in-product item is delivered when it is raised.
//
// Not built yet:
// - email and push for items: the recipient's address is in iam.users, which only auth
//   reads (user-keyed RLS), and push needs device registrations, which have no table yet;
// - telling the recipient's open clients at once (bus-live to the gateway).

import type { PushDevice } from '../../models/workspace/pushDevice.model.ts';
import type { PushOutcome, PushSender } from '../../infra/push.infra.ts';
import { membershipRepo } from '../../repos/iam/index.repo.ts';
import { inTransaction, type Databases } from '../../infra/postgres.infra.ts';
import type { Logger } from '../../infra/logger.infra.ts';
import type { NotifyConfig } from '../../config/notify.config.ts';
import type { Notification } from '../../models/workspace/notification.model.ts';
import { organisationRepo } from '../../repos/iam/index.repo.ts';
import { notificationRepo, pushDeviceRepo } from '../../repos/workspace/index.repo.ts';
import { AppError, isAppError } from '../../utils/errors.util.ts';
import { uuidv7 } from '../../utils/id.util.ts';
import { retry } from '../../utils/retry.util.ts';
import type { Mailer } from './mailer.service.ts';
import { notificationEmail } from './templates.service.ts';
import { invitationEmail, passwordResetEmail, signupEmail, type LinkTarget } from './templates.service.ts';

export interface NotifyDeps {
  config: NotifyConfig;
  databases: Databases;
  mailer: Mailer;
  logger: Logger;
  /** Mobile push (decision 2026-11-14); absent where the cell has no provider. */
  push?: PushSender | undefined;
}

/** A device as its owner sees it: never the token. */
const pushView = (d: PushDevice) => ({ id: d.id, platform: d.platform as 'fcm' | 'apns', registeredAt: d.registeredAt, lastSentAt: d.lastSentAt });

export type AuthEmail =
  | { kind: 'password_reset'; to: string; token: string; expiresAt: string }
  | { kind: 'invitation'; to: string; token: string; expiresAt: string; invitationId: string };

export type NotificationSource =
  | { automationRunActionId: string } | { approvalChainId: string } | { findingId: string } | { simulationRunId: string }
  | { operatorAccessSessionId: string } | { receiptId: string } | { actionEventSubscriptionId: string } | { objectViewLayoutId: string }
  | { ontologyElementId: string } | { pipelineRunId: string } | { supportTicketMessageId: string; supportTicketId: string };

const SOURCE_OF_KIND: Record<Notification['kind'], string> = {
  cron_notify: 'automationRunActionId',
  cron_escalate: 'automationRunActionId',
  approval_waiting: 'approvalChainId',
  finding_new: 'findingId',
  scenario_run_complete: 'simulationRunId',
  operator_access_waiting: 'operatorAccessSessionId',
  operator_access_emergency: 'operatorAccessSessionId',
  action_completed: 'receiptId',
  action_event_dead_lettered: 'actionEventSubscriptionId',
  object_view_layout_invalidated: 'objectViewLayoutId',
  element_deprecated: 'ontologyElementId',
  element_retiring: 'ontologyElementId',
  pipeline_run_failed: 'pipelineRunId',
  support_replied: 'supportTicketMessageId',
};

const encodeCursor = (n: { createdAt: string; id: string }): string => Buffer.from(`${n.createdAt}|${n.id}`, 'utf8').toString('base64url');
function decodeCursor(cursor: string | undefined): { createdAt: string; id: string } | undefined {
  if (cursor === undefined) return undefined;
  const [createdAt, id] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
  if (!createdAt || !id || Number.isNaN(Date.parse(createdAt)) || !/^[0-9a-f-]{36}$/.test(id)) {
    throw new AppError('validation', 'the cursor is not one this service issued', { code: 'notify.cursor_invalid' });
  }
  return { createdAt, id };
}

const notYours = (): AppError => new AppError('not_found', 'no such notification', { code: 'notify.notification_not_found' });

export function createNotify(deps: NotifyDeps) {
  const control = deps.databases.pool('control');
  const baseUrl = deps.config.linkBaseUrl;
  if (baseUrl === undefined) throw new AppError('configuration', 'notify needs NOTIFY_LINK_BASE_URL', { code: 'config.notify.links' });

  /**
   * Sends an item by email to the member's address: what it is about and a link, never a value.
   * A member with no active address, or a relay that refuses three times, leaves the item
   * undelivered (delivered_at null) and is logged; the item in the product stands.
   */
  async function email(organisationId: string, notification: Notification): Promise<void> {
    const found = await inTransaction(control, { organisationId }, async (db) => ({
      organisation: await organisationRepo.findById(db, organisationId), to: await membershipRepo.activeEmail(db, notification.recipientMembershipId),
    }), { readOnly: true });
    if (found.organisation === undefined || found.to === undefined) {
      deps.logger.warn('a notification email has no address to go to', { event: 'email.skipped', organisationId, reason: notification.kind });
      return;
    }
    const target: LinkTarget = { baseUrl: baseUrl!, organisation: { name: found.organisation.name, slug: found.organisation.slug } };
    try {
      await retry(() => deps.mailer.send(notificationEmail(found.to!, target, notification.kind, notification.id)), { attempts: 3, baseDelayMs: 200, maxDelayMs: 2_000 });
      await inTransaction(control, { organisationId }, (db) => notificationRepo.update(db, notification.id, { deliveredAt: new Date().toISOString() }));
      deps.logger.info('email sent', { event: 'email.sent', organisationId, reason: notification.kind, resourceType: 'notification', resourceId: notification.id });
    } catch (error) {
      deps.logger.failure('a notification email was not sent', error, { event: 'email.failed', organisationId, resourceType: 'notification', resourceId: notification.id });
    }
  }

  /**
   * Mobile push (decision 2026-11-14): to each of the recipient's live devices on the cell's
   * platform, a count and a link only. Delivered when one device took it; a device the
   * provider reports gone is revoked. With no provider the item waits undelivered.
   */
  async function pushTo(organisationId: string, notification: Notification): Promise<void> {
    if (deps.push === undefined) {
      deps.logger.warn('a push was asked for, and this cell has no push provider', { event: 'push.unconfigured', organisationId });
      return;
    }
    const sender = deps.push;
    const scope = { organisationId, membershipId: notification.recipientMembershipId };
    const { devices, unread } = await inTransaction(control, scope, async (db) => ({
      devices: await pushDeviceRepo.liveFor(db, notification.recipientMembershipId, sender.platform),
      unread: await notificationRepo.unreadCount(db, notification.recipientMembershipId),
    }), { readOnly: true });
    const badge = Math.max(unread, 1);
    const message = { title: 'Silo', body: `${badge} new in Silo`, link: `${baseUrl}/notifications/`, badge };
    let sent = 0;
    for (const device of devices) {
      const outcome = await sender.send(device.token, message).catch((): PushOutcome => 'failed');
      await inTransaction(control, scope, async (db) => {
        if (outcome === 'sent') await pushDeviceRepo.markSent(db, device.id);
        if (outcome === 'gone') await pushDeviceRepo.revoke(db, device.id);
      });
      if (outcome === 'sent') sent += 1;
    }
    if (sent > 0) await inTransaction(control, scope, (db) => notificationRepo.markDelivered(db, notification.id));
    deps.logger.info('push sent', { event: 'push.sent', organisationId, resourceType: 'notification', resourceId: notification.id, count: sent });
  }

  return {
    /** A member's device for push: re-registering a live token returns it. */
    async registerPushDevice(organisationId: string, membershipId: string, input: { platform: 'fcm' | 'apns'; token: string }) {
      if (deps.push !== undefined && deps.push.platform !== input.platform) {
        throw new AppError('validation', `this cell sends push through ${deps.push.platform}`, { code: 'push.platform_unserved' });
      }
      return inTransaction(control, { organisationId, membershipId }, async (db) => {
        const existing = await pushDeviceRepo.findLive(db, input.platform, input.token);
        if (existing !== undefined && existing.membershipId === membershipId) return pushView(existing);
        if (existing !== undefined) await pushDeviceRepo.revoke(db, existing.id);
        return pushView(await pushDeviceRepo.insert(db, { id: uuidv7(), organisationId, membershipId, platform: input.platform, token: input.token }));
      });
    },

    async listPushDevices(organisationId: string, membershipId: string) {
      return { devices: (await inTransaction(control, { organisationId, membershipId }, (db) => pushDeviceRepo.listLive(db, membershipId), { readOnly: true }))
        .map(pushView) };
    },

    async removePushDevice(organisationId: string, membershipId: string, id: string): Promise<void> {
      await inTransaction(control, { organisationId, membershipId }, async (db) => {
        const device = await pushDeviceRepo.findById(db, id);
        if (!device || device.membershipId !== membershipId) throw new AppError('not_found', 'no such device', { code: 'push.device_not_found' });
        await pushDeviceRepo.revoke(db, id);
      });
    },

    async sendAuthEmail(organisationId: string, email: AuthEmail): Promise<void> {
      const organisation = await inTransaction(control, { organisationId }, (db) => organisationRepo.findById(db, organisationId),
        { readOnly: true });
      if (!organisation) throw new AppError('not_found', 'no such organisation in this cell', { code: 'notify.organisation_unknown' });
      const target: LinkTarget = { baseUrl, organisation: { name: organisation.name, slug: organisation.slug } };
      const message = email.kind === 'password_reset'
        ? passwordResetEmail(email.to, target, email.token, email.expiresAt)
        : invitationEmail(email.to, target, email.token, email.expiresAt);
      const started = performance.now();
      await retry(() => deps.mailer.send(message), {
        attempts: 3, baseDelayMs: 200, maxDelayMs: 2_000,
        onRetry: (attempt, delayMs, error) => deps.logger.warn('the mail relay failed; retrying', {
          event: 'email.retried', organisationId, reason: email.kind, attempt, durationMs: delayMs,
          ...(isAppError(error) ? { errorCode: error.code } : {}),
        }),
      });
      deps.logger.info('email sent', {
        event: 'email.sent', organisationId, reason: email.kind, durationMs: Math.round(performance.now() - started),
        ...(email.kind === 'invitation' ? { resourceType: 'invitation', resourceId: email.invitationId } : {}),
      });
    },

    async sendSignupEmail(email: { to: string; token: string; expiresAt: string; organisationName: string }): Promise<void> {
      const message = signupEmail(email.to, baseUrl, email.organisationName, email.token, email.expiresAt);
      await retry(() => deps.mailer.send(message), { attempts: 3, baseDelayMs: 200, maxDelayMs: 2_000 });
      deps.logger.info('email sent', { event: 'email.sent', reason: 'signup' });
    },

    async raise(organisationId: string, input: {
      recipientMembershipId: string; kind: Notification['kind']; source: NotificationSource; acknowledgeDueAt?: string | undefined;
      channels?: ('in_app' | 'email' | 'mobile_push')[] | undefined;
    }): Promise<{ notification: Notification; created: boolean }> {
      // The one source field; a support reply's ticket rides beside it and is not a second source.
      const sourceField = Object.keys(input.source).find((key) => key !== 'supportTicketId');
      if (sourceField !== SOURCE_OF_KIND[input.kind]) {
        throw new AppError('validation', `a ${input.kind} item is about a ${SOURCE_OF_KIND[input.kind]}`, { code: 'notify.source_mismatch' });
      }
      if ((input.kind === 'cron_escalate') !== (input.acknowledgeDueAt !== undefined)) {
        throw new AppError('validation', 'an escalation, and only an escalation, has an acknowledgement deadline', { code: 'notify.acknowledge_due' });
      }
      // One item per channel. In the product it is delivered when written; by email when the relay takes it.
      let first: { notification: Notification; created: boolean } | undefined;
      for (const channel of [...new Set<'in_app' | 'email' | 'mobile_push'>(input.channels ?? ['in_app'])]) {
        let out: { notification: Notification; created: boolean };
        try {
          out = await inTransaction(control, { organisationId }, (db) => notificationRepo.insertOnce(db, {
            id: uuidv7(), organisationId, recipientMembershipId: input.recipientMembershipId, kind: input.kind, channel,
            ...input.source, deliveredAt: channel === 'in_app' ? new Date().toISOString() : null, acknowledgeDueAt: input.acknowledgeDueAt ?? null,
          }));
        } catch (error) {
          if (isAppError(error) && error.details['sqlstate'] === '23503') {
            throw new AppError('validation', 'the recipient or the source is not in this organisation', { code: 'notify.reference_unknown' });
          }
          throw error;
        }
        if (channel === 'email' && out.created) await email(organisationId, out.notification);
        if (channel === 'mobile_push' && out.created) await pushTo(organisationId, out.notification);
        first ??= out;
      }
      return first!;
    },

    async list(organisationId: string, membershipId: string, query: { unread?: boolean | undefined; cursor?: string | undefined; limit: number }) {
      const rows = await inTransaction(control, { organisationId, membershipId }, (db) => notificationRepo.listForRecipient(db, {
        organisationId, membershipId, unread: query.unread === true, before: decodeCursor(query.cursor), limit: query.limit + 1,
      }), { readOnly: true });
      const page = rows.slice(0, query.limit);
      return { notifications: page, nextCursor: rows.length > query.limit ? encodeCursor(page.at(-1)!) : null };
    },

    async read(organisationId: string, membershipId: string, id: string): Promise<Notification> {
      const row = await inTransaction(control, { organisationId, membershipId }, (db) => notificationRepo.findById(db, id), { readOnly: true });
      if (row === undefined || row.recipientMembershipId !== membershipId) throw notYours();
      return row;
    },

    async markRead(organisationId: string, membershipId: string, id: string): Promise<Notification> {
      const row = await inTransaction(control, { organisationId, membershipId }, (db) =>
        notificationRepo.markRead(db, { organisationId, id, membershipId }));
      if (!row) throw notYours();
      return row;
    },

    async acknowledge(organisationId: string, membershipId: string, id: string): Promise<Notification> {
      const row = await inTransaction(control, { organisationId, membershipId }, async (db) => {
        const acknowledged = await notificationRepo.acknowledge(db, { organisationId, id, membershipId });
        if (acknowledged) return acknowledged;
        const existing = await notificationRepo.findById(db, id);
        if (existing && existing.recipientMembershipId === membershipId) {
          throw new AppError('validation', 'only an escalation is acknowledged', { code: 'notify.not_an_escalation' });
        }
        return undefined;
      });
      if (!row) throw notYours();
      return row;
    },
  };
}

export type Notify = ReturnType<typeof createNotify>;
