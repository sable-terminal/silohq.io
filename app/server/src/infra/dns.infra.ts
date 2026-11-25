// DNS TXT lookups, for proving an organisation controls an email domain (decision
// 2026-11-14). Through the system resolver; an absent name or record is no records, any
// other failure is the resolver's, reported as upstream.

import { resolveTxt } from 'node:dns/promises';
import { AppError } from '../utils/errors.util.ts';

export interface TxtResolver {
  /** The name's TXT records, each joined from its strings; none where the name has none. */
  txt(name: string): Promise<string[]>;
}

const ABSENT = new Set(['ENOTFOUND', 'ENODATA', 'ENONAME', 'NXDOMAIN']);

export const systemTxtResolver: TxtResolver = {
  async txt(name) {
    try {
      return (await resolveTxt(name)).map((record) => record.join(''));
    } catch (error) {
      if (ABSENT.has((error as { code?: string }).code ?? '')) return [];
      throw new AppError('upstream', 'the DNS lookup failed; try again', { code: 'dns.lookup_failed', retryable: true, cause: error });
    }
  },
};
