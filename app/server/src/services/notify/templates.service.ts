// The text of notify's emails. Plain text and HTML of the same words. The organisation's
// name is the only text that comes from a tenant; it is escaped in HTML and stripped of
// control characters everywhere. Links put the token in the fragment, so it reaches the
// web client and never a server log or a Referer header. Each link is one of the web client's
// fixed pages (a static export has no page per organisation), naming the organisation in the
// query.

import type { NOTIFICATION_KINDS } from '../../contracts/notify/notification.contract.ts';
import type { MailMessage } from './mailer.service.ts';

const escapeHtml = (text: string): string =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const plain = (text: string): string => text.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, 200);
const when = (iso: string): string => `${new Date(iso).toISOString().slice(0, 16).replace('T', ' ')} UTC`;

export interface LinkTarget {
  baseUrl: string;
  organisation: { name: string; slug: string };
}

export function link(target: LinkTarget, path: 'reset-password' | 'accept-invitation', token: string): string {
  return `${target.baseUrl}/${path}/?organisation=${encodeURIComponent(target.organisation.slug)}#token=${encodeURIComponent(token)}`;
}

function message(to: string, subject: string, paragraphs: (string | { href: string })[]): MailMessage {
  const text = paragraphs.map((p) => (typeof p === 'string' ? p : p.href)).join('\n\n');
  const html = `<!doctype html><html><body style="font-family: sans-serif; line-height: 1.5">${paragraphs
    .map((p) => (typeof p === 'string' ? `<p>${escapeHtml(p)}</p>` : `<p><a href="${escapeHtml(p.href)}">${escapeHtml(p.href)}</a></p>`))
    .join('')}</body></html>`;
  return { to, subject, text, html };
}

export function passwordResetEmail(to: string, target: LinkTarget, token: string, expiresAt: string): MailMessage {
  const organisation = plain(target.organisation.name);
  return message(to, `Reset your Silo password for ${organisation}`, [
    `Someone asked to reset the password of your account at ${organisation} on Silo.`,
    `To choose a new password, open this link before ${when(expiresAt)}. It works once.`,
    { href: link(target, 'reset-password', token) },
    'If you did not ask for this, ignore this email: your password has not changed.',
  ]);
}

/** A self-serve sign-up's verification link (decision 2026-11-14): no organisation exists yet. */
export function signupEmail(to: string, baseUrl: string, organisationName: string, token: string, expiresAt: string): MailMessage {
  const organisation = plain(organisationName);
  return message(to, `Confirm your email to create ${organisation} on Silo`, [
    `Someone used this address to create ${organisation} on Silo.`,
    `To confirm it is yours and finish, open this link before ${when(expiresAt)}. It works once.`,
    { href: `${baseUrl}/sign-up/complete/#token=${encodeURIComponent(token)}` },
    'If you did not sign up, ignore this email: nothing is created until the link is opened.',
  ]);
}

export function invitationEmail(to: string, target: LinkTarget, token: string, expiresAt: string): MailMessage {
  const organisation = plain(target.organisation.name);
  return message(to, `You are invited to join ${organisation} on Silo`, [
    `You have been invited to join ${organisation} on Silo.`,
    `To accept, open this link before ${when(expiresAt)}. It works once.`,
    { href: link(target, 'accept-invitation', token) },
    'If you were not expecting this invitation, you can ignore this email.',
  ]);
}

/** What an item is about, in words: its email's subject and first line. Never a value. */
const ABOUT: Readonly<Record<(typeof NOTIFICATION_KINDS)[number], string>> = {
  cron_notify: 'A Cron has fired',
  cron_escalate: 'A Cron escalation needs your acknowledgement',
  approval_waiting: 'An approval is waiting for you',
  finding_new: 'There is a new finding',
  scenario_run_complete: 'A scenario run has finished',
  operator_access_waiting: 'A Silo operator access request is waiting for you',
  operator_access_emergency: 'A Silo operator has opened emergency access',
  action_completed: 'An Action has completed',
  action_event_dead_lettered: 'An Action event subscription has stopped delivering',
  object_view_layout_invalidated: 'An object view layout you made no longer fits the ontology',
  element_deprecated: 'Something you own uses a deprecated part of the ontology',
  element_retiring: 'Something you own uses a part of the ontology that retires in seven days',
  pipeline_run_failed: 'A scheduled run of a pipeline you own failed',
  support_replied: 'Silo support replied to your ticket',
};

/** A notification by email: what it is about and a link to it in the product, nothing more. */
export function notificationEmail(to: string, target: LinkTarget, kind: (typeof NOTIFICATION_KINDS)[number], notificationId: string): MailMessage {
  const organisation = plain(target.organisation.name);
  return message(to, `${ABOUT[kind]} in ${organisation}`, [
    `${ABOUT[kind]} in ${organisation} on Silo.`,
    'Open it in Silo to see the details:',
    { href: `${target.baseUrl}/notifications/?organisation=${encodeURIComponent(target.organisation.slug)}&id=${encodeURIComponent(notificationId)}` },
  ]);
}
