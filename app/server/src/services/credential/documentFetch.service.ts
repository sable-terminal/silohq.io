// Reading a public document for the AI builder (spec 16.3): GET through the egress, with no
// credential, following at most three redirects (each hop checked by the egress as any
// request is), text only, bounded. A missing document is an answer, not a failure.

import { MAX_DOCUMENT_BYTES } from '../../contracts/credential/documentFetch.contract.ts';
import type { Egress } from '../../infra/egress.infra.ts';
import { AppError, isAppError } from '../../utils/errors.util.ts';

const REDIRECTS = 3;
const TEXT = /^(text\/|application\/(json|xml|yaml|x-yaml|graphql|[a-z.+-]*\+(json|xml)))/i;

export async function fetchPublicDocument(egress: Egress, url: string)
  : Promise<{ outcome: 'fetched'; url: string; contentType: string; text: string } | { outcome: 'absent'; status: number }> {
  let at = new URL(url);
  for (let hop = 0; hop <= REDIRECTS; hop += 1) {
    let response;
    try {
      response = await egress.send({ url: at, method: 'GET', headers: { accept: 'application/json, application/yaml, application/xml, text/html, text/plain;q=0.9, */*;q=0.1' }, timeoutMs: 15_000 });
    } catch (error) {
      if (isAppError(error) && error.code === 'egress.response_too_large') return { outcome: 'absent', status: 413 };
      throw error;
    }
    if (response.status >= 300 && response.status < 400 && response.headers['location'] !== undefined) {
      at = new URL(response.headers['location'], at);
      if (at.protocol !== 'https:' && at.protocol !== 'http:') return { outcome: 'absent', status: response.status };
      continue;
    }
    if (response.status === 404 || response.status === 410) return { outcome: 'absent', status: response.status };
    if (response.status !== 200) {
      throw new AppError('unavailable', 'the document could not be read', { code: 'document.unreadable', details: { status: response.status } });
    }
    const contentType = (response.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();
    if (response.body.length > MAX_DOCUMENT_BYTES || (contentType !== '' && !TEXT.test(contentType))) return { outcome: 'absent', status: 415 };
    return { outcome: 'fetched', url: at.toString(), contentType, text: response.body.toString('utf8') };
  }
  return { outcome: 'absent', status: 310 };
}
