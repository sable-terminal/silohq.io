// Change windows and freezes (spec 11.5): "Sovereign, on-premises and dedicated customers set
// change windows and freezes. During a freeze Fleet applies only a security fix the
// customer's named change authority approves in writing. Every change is notified in advance
// with its SBOM difference."
//
// A dedicated cell's release starts only when all of these hold:
// - the notice has stood its time (FLEET_CHANGE_NOTICE_HOURS from when the cell was told; a
//   security fix needs only to have been notified);
// - the moment falls inside one of the customer's windows, in their time zone (no windows:
//   any time);
// - no freeze is in force, or the release is a security fix and the customer's change
//   authority approved it for that freeze.
// The customer's policy reaches fleet-control from their cell (putCellChangePolicy); until it
// has, the cell takes a release after its notice, at any time.

import { parsePurl, purlIdentity } from '../../utils/purl.util.ts';

export interface ChangeWindow { day: number; start: string; end: string }
export interface ChangeFreeze { id: string; startsAt: string; endsAt: string; reason: string }
export interface FreezeException { releaseId: string; freezeId: string; approvedBy: string; approvedAt: string; statement: string }
export interface ChangePolicy {
  timeZone: string;
  windows: ChangeWindow[];
  changeAuthorityMembershipId: string | null;
  freezes: ChangeFreeze[];
  exceptions: FreezeException[];
}

const WEEKDAYS: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
const minutes = (hhmm: string): number => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

/** The weekday (1 Monday to 7 Sunday) and minute of the day at a moment, in a time zone. */
export function localTime(timeZone: string, at: number): { day: number; minute: number } {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(new Date(at));
  const get = (type: string): string => parts.find((p) => p.type === type)!.value;
  return { day: WEEKDAYS[get('weekday')]!, minute: Number(get('hour')) * 60 + Number(get('minute')) };
}

/** Whether a moment falls inside one of the windows; a window whose end is not after its start runs past midnight. */
export function inWindow(policy: Pick<ChangePolicy, 'timeZone' | 'windows'>, at: number): boolean {
  if (policy.windows.length === 0) return true;
  const { day, minute } = localTime(policy.timeZone, at);
  const yesterday = day === 1 ? 7 : day - 1;
  return policy.windows.some((w) => {
    const start = minutes(w.start);
    const end = minutes(w.end);
    if (end > start) return w.day === day && minute >= start && minute < end;
    return (w.day === day && minute >= start) || (w.day === yesterday && minute < end);
  });
}

export const freezeAt = (policy: Pick<ChangePolicy, 'freezes'>, at: number): ChangeFreeze | undefined =>
  policy.freezes.find((f) => Date.parse(f.startsAt) <= at && at < Date.parse(f.endsAt));

export type Hold = 'notice' | 'window' | 'freeze' | null;

/** Why a dedicated cell's release may not start now, or null when it may. */
export function holdOf(policy: ChangePolicy | undefined, release: { releaseId: string; securityFix: boolean }, noticedAt: number,
  noticeMs: number, at: number): Hold {
  if (at < noticedAt + (release.securityFix ? 0 : noticeMs)) return 'notice';
  if (policy === undefined) return null;
  const freeze = freezeAt(policy, at);
  if (freeze !== undefined) {
    const approved = release.securityFix && policy.changeAuthorityMembershipId !== null && policy.exceptions.some((e) =>
      e.releaseId === release.releaseId && e.freezeId === freeze.id && e.approvedBy === policy.changeAuthorityMembershipId);
    if (!approved) return 'freeze';
  }
  return inWindow(policy, at) ? null : 'window';
}

// ----------------------------------------------------------------------------- the SBOM difference

export interface SbomDifference {
  /** False when either release lacks an image's SBOM: the lists then say only what is known. */
  complete: boolean;
  added: { subject: string; purl: string }[];
  removed: { subject: string; purl: string }[];
  changed: { subject: string; package: string; from: string; to: string }[];
  truncated: boolean;
}

const LIMIT = 500;

/** What a cell's images gain, lose and change between the release it runs and the one coming. */
export function sbomDifference(before: readonly { subject: string; purl: string; version: string }[] | undefined,
  after: readonly { subject: string; purl: string; version: string }[] | undefined): SbomDifference {
  const byPackage = (rows: readonly { subject: string; purl: string; version: string }[]) => {
    const out = new Map<string, { subject: string; purl: string; version: string }>();
    for (const row of rows) {
      const parsed = parsePurl(row.purl);
      const key = `${row.subject} ${parsed === undefined ? row.purl : purlIdentity(parsed, false)}`;
      out.set(key, row);
    }
    return out;
  };
  const old = byPackage(before ?? []);
  const next = byPackage(after ?? []);
  const added: SbomDifference['added'] = [];
  const removed: SbomDifference['removed'] = [];
  const changed: SbomDifference['changed'] = [];
  for (const [key, row] of next) {
    const was = old.get(key);
    if (was === undefined) added.push({ subject: row.subject, purl: row.purl });
    else if (was.version !== row.version) changed.push({ subject: row.subject, package: key.slice(row.subject.length + 1), from: was.version, to: row.version });
  }
  for (const [key, row] of old) if (!next.has(key)) removed.push({ subject: row.subject, purl: row.purl });
  const order = <T extends { subject: string }>(list: T[], key: (t: T) => string): T[] =>
    list.sort((a, b) => a.subject.localeCompare(b.subject) || key(a).localeCompare(key(b)));
  order(added, (a) => a.purl);
  order(removed, (r) => r.purl);
  order(changed, (c) => c.package);
  const truncated = added.length > LIMIT || removed.length > LIMIT || changed.length > LIMIT;
  return {
    complete: before !== undefined && after !== undefined,
    added: added.slice(0, LIMIT), removed: removed.slice(0, LIMIT), changed: changed.slice(0, LIMIT), truncated,
  };
}
