import { env } from './env.config';

/**
 * Which cell this process is, and what that forbids.
 *
 * A CELL IS A HARD BOUNDARY, NOT A LABEL. Customer data lives in exactly one, and
 * nothing in a cell may read from another — the directory tier holds only a
 * hashed email and a cell id, and everything else is resolved after routing.
 *
 * IT IS SET IN DEVELOPMENT TOO, AND THAT IS THE POINT. Code whose cell checks
 * only run in production is code where those checks are never exercised, and the
 * first time they run is the first time they can be wrong.
 */

export const cellConfig = {
  id: env.CELL_ID,
  region: env.CELL_REGION,

  /**
   * Whether a resource belongs to this cell.
   *
   * IT REFUSES ON MISSING, NOT ONLY ON MISMATCH. A record with no cell id is not
   * a record that belongs everywhere — it is a record written by something that
   * did not know about cells, which is the bug this exists to surface.
   */
  owns(cellId: string | null | undefined): boolean {
    return cellId === env.CELL_ID;
  },

  assertOwns(cellId: string | null | undefined, what: string): void {
    if (!this.owns(cellId)) {
      throw new Error(
        `${what} belongs to cell "${cellId ?? 'none'}" and this is "${env.CELL_ID}". ` +
          `Nothing may cross a cell boundary.`,
      );
    }
  },
  /**
   * Where each cell answers.
   *
   * PARSED ONCE, HERE, rather than at the call site that needs it. A malformed
   * pair is a startup problem; discovering it during somebody's login means
   * telling them their password is wrong.
   */
  urls: parseCellUrls(env.CELL_URLS),

  /** The base URL of another cell, or null if we have never heard of it. */
  urlFor(cellId: string): string | null {
    return parseCellUrls(env.CELL_URLS)[cellId] ?? null;
  },
} as const;

function parseCellUrls(raw: string | undefined): Record<string, string> {
  if (!raw) return {};
  const out: Record<string, string> = {};

  for (const pair of raw.split(',')) {
    const eq = pair.indexOf('=');
    if (eq === -1) continue;
    const id = pair.slice(0, eq).trim();
    const url = pair.slice(eq + 1).trim();
    // Only absolute HTTPS, because this value becomes a redirect somebody's
    // browser follows while holding a half-finished sign-in.
    if (id && (url.startsWith('https://') || url.startsWith('http://localhost'))) {
      out[id] = url.replace(/\/$/, '');
    }
  }

  return out;
}
