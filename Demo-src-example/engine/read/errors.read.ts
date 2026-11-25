import type { ErrorRuleV2, Meaning } from '../../schemas/manifest.schema';
import { parseRetryAfter } from '../../utils/backoff.util';
import { bounds, denial, limited, notFound, upstream } from '../../utils/error.util';
import { truth, value, type Scope } from '../expression/evaluate.expression';

/**
 * What a response MEANS, and the error the rest of the product understands.
 *
 * THE CONNECTOR'S RULES FIRST, THEN THE TRANSPORT'S FLOOR. Slack answers 200
 * with `ok: false`; a 404 on one API is an empty collection. The first rule
 * whose condition holds decides; when none does, the protocol's own meaning of
 * the status — a 401 is auth, a 429 is a rate limit — applies.
 */

export interface Judged {
  means: Meaning;
  rule: ErrorRuleV2 | null;
  retryAfterSeconds: number | null;
}

/** The first rule whose condition holds, with its retry-after worked out. */
export async function judge(rules: ErrorRuleV2[], scope: Scope, now: number): Promise<Judged | null> {
  for (const rule of rules) {
    if (!(await truth(rule.when, scope))) continue;
    return { means: rule.means, rule, retryAfterSeconds: await retryAfterOf(rule, scope, now) };
  }
  return null;
}

async function retryAfterOf(rule: ErrorRuleV2, scope: Scope, now: number): Promise<number | null> {
  if (rule.retryAfter === undefined) return null;
  if (typeof rule.retryAfter === 'string') {
    const seconds = Number(await value(rule.retryAfter, scope));
    return Number.isFinite(seconds) && seconds >= 0 ? Math.ceil(seconds) : null;
  }
  const raw = await value(rule.retryAfter.value, scope);
  if (raw === null || raw === undefined) return null;
  switch (rule.retryAfter.format) {
    case 'seconds': {
      const seconds = Number(raw);
      return Number.isFinite(seconds) ? Math.max(0, Math.ceil(seconds)) : null;
    }
    case 'epoch_seconds': {
      const at = Number(raw) * 1_000;
      return Number.isFinite(at) ? Math.max(0, Math.ceil((at - now) / 1_000)) : null;
    }
    case 'epoch_millis': {
      const at = Number(raw);
      return Number.isFinite(at) ? Math.max(0, Math.ceil((at - now) / 1_000)) : null;
    }
    case 'http_date': {
      const ms = parseRetryAfter(String(raw), new Date(now));
      return ms === null ? null : Math.ceil(ms / 1_000);
    }
  }
}

/** Throw what a meaning means. `empty` is not an error and is the caller's to handle. */
export function raise(
  judged: Judged,
  context: { protocol: string; status: number | null; code: string | null; excerpt: string; sourceMessage?: string | null },
): never {
  const said = judged.rule?.message ?? namedByTheSource(judged.means, context.sourceMessage ?? null);
  const detail = { status: context.status, code: context.code };

  switch (judged.means) {
    case 'auth':
      throw denial({
        message: said ?? 'The source refused this connection’s credentials. Reconnect it.',
        code: 'denial.source_credentials',
        detail,
      });
    case 'rate_limit':
      throw limited({
        message: said ?? 'The source is rate limiting Silo. It will be tried again shortly.',
        code: 'limited.source',
        detail: { ...detail, retryAfter: judged.retryAfterSeconds },
      });
    case 'not_found':
      throw notFound({
        message: said ?? 'The source does not have what this connector asked for. It needs re-checking.',
        code: 'missing.source_object',
        detail,
      });
    case 'bounds':
      throw bounds({
        message: said ?? 'That request was too large for the source. Narrow it.',
        code: 'bounds.source_request',
        detail,
      });
    case 'upstream':
    case 'empty':
      throw upstream({
        message: said ?? 'The source system refused the request.',
        code: `upstream.${context.protocol}`,
        detail: { ...detail, body: context.excerpt.slice(0, 300) },
      });
  }
}

/**
 * NAME THE THING THAT IS MISSING. A database says exactly which column or
 * table it could not find, and the identifier came from the connector rather
 * than from anybody's data — so passing it through turns "something is wrong"
 * into a field to go and fix.
 */
function namedByTheSource(means: Meaning, message: string | null): string | undefined {
  if (means !== 'not_found' || !message) return undefined;
  const named = /(column|relation|table|object|field)\s+["'`\[]?([^"'`\]\s]+)["'`\]]?/i.exec(message);
  if (!named) return undefined;
  const kind = named[1]!.toLowerCase() === 'column' || named[1]!.toLowerCase() === 'field' ? 'a field' : 'a table';
  return `This connector expects ${kind} called ${named[2]}, and the source does not have it.`;
}
