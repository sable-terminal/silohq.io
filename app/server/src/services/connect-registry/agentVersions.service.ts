// Silo Agent versions (spec 10.7): which are older, and the floor below which an agent is
// outdated. "An agent older than the last three minor releases is flagged and refused after
// 90 days": the last three minor releases are the three newest major.minor among the agent
// releases this cell has received; an agent on an older minor is outdated.

import { compareSemver } from '../../utils/versions.util.ts';

export const OUTDATED_AFTER_MINORS = 3;
export const REFUSED_AFTER_DAYS = 90;

export interface VersionParts { major: number; minor: number; patch: number }

export function versionParts(version: string): VersionParts {
  const [major, minor, rest] = version.split('.');
  return { major: Number(major), minor: Number(minor), patch: Number.parseInt(rest ?? '0', 10) };
}

/** Whether a is a later version than b (Semantic Versioning precedence). */
export const isNewer = (a: string, b: string): boolean => (compareSemver(a, b) ?? 0) > 0;

/** The oldest minor release still supported, when the cell has received at least three. */
export function outdatedFloor(versions: readonly string[]): { major: number; minor: number } | undefined {
  const minors = [...new Set(versions.map((v) => {
    const p = versionParts(v);
    return `${p.major}.${p.minor}`;
  }))].map((m) => ({ major: Number(m.split('.')[0]), minor: Number(m.split('.')[1]) }))
    .sort((a, b) => b.major - a.major || b.minor - a.minor);
  return minors.length < OUTDATED_AFTER_MINORS ? undefined : minors[OUTDATED_AFTER_MINORS - 1];
}
