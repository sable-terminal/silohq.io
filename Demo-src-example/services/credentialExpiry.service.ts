import type { Executor } from '../infra/db.infra';
import { generateId } from '../utils/tokens.util';
import * as connectionRepo from '../repos/connection.repo';
import * as notificationRepo from '../repos/notification.repo';
import { log as writeAudit } from './audit.service';

/**
 * Telling people a credential is about to stop working, before it does.
 *
 * ── THREE WARNINGS, EACH ONCE ─────────────────────────────────────────────
 *
 * Two weeks out, one week out, the day before, and on the day. A sweep that runs daily
 * sends each at most once — the stage reached is recorded — because a warning
 * repeated every morning is one people learn to ignore, and this one matters
 * on exactly one morning.
 *
 * ── TO THE PERSON WHO CAN FIX IT ──────────────────────────────────────────
 *
 * Whoever gave the credential, and everyone who may replace one. A lapse
 * nobody with the permission hears about is still a lapse.
 */

const STAGES = ['upcoming', 'week', 'imminent', 'expired'] as const;
type Stage = (typeof STAGES)[number];

export function stageOf(expiresAt: Date, now: Date): Stage | null {
  const days = (expiresAt.getTime() - now.getTime()) / 86_400_000;
  if (days <= 0) return 'expired';
  if (days <= 1) return 'imminent';
  if (days <= 7) return 'week';
  if (days <= 14) return 'upcoming';
  return null;
}

const SOURCE: Record<connectionRepo.LapsingCredential['source'], string> = {
  certificate: 'Its certificate',
  token: 'The token',
  declared: 'Keys from this system',
};

const WHEN: Record<Exclude<Stage, 'expired'>, string> = { upcoming: 'in two weeks', week: 'this week', imminent: 'tomorrow' };

function message(credential: connectionRepo.LapsingCredential, stage: Stage): { title: string; body: string } {
  const date = credential.expiresAt.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
  /* The connector's own words on how to get a new one, where it has them (§3.7). */
  const how = credential.rotation ? ` ${credential.rotation}` : '';
  if (stage === 'expired') {
    return {
      title: `${credential.connectionName}'s credential has expired`,
      body: `${SOURCE[credential.source]} stopped being valid on ${date}. Questions that use it will fail until it is replaced.${how}`,
    };
  }
  return {
    title: `${credential.connectionName}'s credential expires ${WHEN[stage]}`,
    body: `${SOURCE[credential.source]} ${credential.source === 'declared' ? 'last' : 'is valid'} until ${date}. Replace it before then so nothing stops.${how}`,
  };
}

/** One pass over every organisation. Run as the migrator by `sweep:credentials`. */
export async function sweep(db: Executor, now: Date = new Date()): Promise<{ warned: number; notified: number }> {
  let warned = 0;
  let notified = 0;
  const managers = new Map<string, string[]>();
  for (const credential of await connectionRepo.lapsingCredentials(db, 14)) {
    const stage = stageOf(credential.expiresAt, now);
    if (!stage) continue;
    if (credential.stage && STAGES.indexOf(credential.stage) >= STAGES.indexOf(stage)) continue;

    if (!managers.has(credential.organisationId)) managers.set(credential.organisationId, await connectionRepo.credentialManagers(db, credential.organisationId));
    const recipients = new Set(managers.get(credential.organisationId));
    if (credential.sealedBy) recipients.add(credential.sealedBy);

    const { title, body } = message(credential, stage);
    for (const membershipId of recipients) {
      await notificationRepo.create(db, {
        id: generateId(),
        organisationId: credential.organisationId,
        membershipId,
        kind: 'connection',
        title: title.slice(0, 200),
        body: body.slice(0, 500),
        href: `/connections/${credential.connectionId}`,
      });
      notified += 1;
    }
    await connectionRepo.markExpiryStage(db, credential.connectionId, credential.strategy, stage);
    await writeAudit(db, {
      event: 'credential_expiry_warned',
      organisationId: credential.organisationId,
      membershipId: null,
      userId: null,
      detail: { connectionId: credential.connectionId, stage, expiresAt: credential.expiresAt.toISOString(), source: credential.source },
    });
    warned += 1;
  }
  return { warned, notified };
}
