import { createHash } from 'node:crypto';
import type { ManifestV2 } from '../../schemas/manifest.schema';
import { credentialOrigins } from './context.read';

/**
 * What a connection's admin confirms when they connect, and re-confirms when
 * it moves to another version of its connector (MANIFEST-V2 §9.2, F19, F20).
 *
 * TWO THINGS ONLY, BECAUSE THEY ARE THE TWO A DOCUMENT COULD TURN AGAINST ITS
 * OWN CUSTOMER: where the credential goes, and — for a database — a statement
 * the connector runs verbatim. Everything else a document says runs inside
 * bounds that hold whatever it says.
 */

export interface Pins {
  origins: string[];
  /** SHA-256 of each statement's text. */
  statements: string[];
}

export const statementHash = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

/** Every `statement` a document's reads and writes carry, as written. */
export function statementsOf(manifest: ManifestV2): string[] {
  const found = new Set<string>();
  const walk = (value: unknown, depth: number): void => {
    if (depth > 12 || value === null || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      for (const one of value) walk(one, depth + 1);
      return;
    }
    for (const [key, one] of Object.entries(value as Record<string, unknown>)) {
      if (key === 'statement' && typeof one === 'string') found.add(one);
      else walk(one, depth + 1);
    }
  };
  for (const object of manifest.objects) {
    walk(object.read, 0);
    walk((object as { write?: unknown }).write, 0);
  }
  return [...found];
}

/** What this connection's document, with these parameters, would have an admin confirm. */
export async function pinsFor(manifest: ManifestV2, params: Record<string, string>): Promise<Pins> {
  return {
    origins: [...(await credentialOrigins(manifest, params))].sort(),
    statements: statementsOf(manifest).map(statementHash).sort(),
  };
}

/** What changed between two sets of pins: what a re-confirmation is asked about. */
export function pinChanges(before: Pins, after: Pins): { originsAdded: string[]; originsRemoved: string[]; statementsChanged: boolean } {
  const had = new Set(before.origins);
  const has = new Set(after.origins);
  return {
    originsAdded: after.origins.filter((o) => !had.has(o)),
    originsRemoved: before.origins.filter((o) => !has.has(o)),
    statementsChanged: before.statements.join() !== after.statements.join(),
  };
}
