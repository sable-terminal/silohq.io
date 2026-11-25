// The client's address (spec 7.3 rate limits; auth's lockout and keyed hashes). Each
// proxy in front of a public listener appends the address it received from to
// X-Forwarded-For, so with n trusted proxies the client is the nth address from the
// right of [...X-Forwarded-For, the socket's peer]. Anything left of that was written by
// the client and is ignored, so a client cannot choose its own address.

import { isIP } from 'node:net';
import type { IncomingHttpHeaders } from 'node:http';
import type { EdgeClient } from '../contracts/gateway/publicRoute.contract.ts';

const MAPPED_V4 = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i;

function normalise(address: string): string | undefined {
  const trimmed = address.trim();
  const mapped = MAPPED_V4.exec(trimmed);
  const candidate = mapped ? mapped[1]! : trimmed;
  return isIP(candidate) === 0 ? undefined : candidate.toLowerCase();
}

export function clientAddress(peer: string | undefined, forwardedFor: string | string[] | undefined, trustedHops: number): string | undefined {
  const forwarded = (Array.isArray(forwardedFor) ? forwardedFor.join(',') : forwardedFor ?? '')
    .split(',').map((entry) => entry.trim()).filter((entry) => entry !== '');
  const chain = [...forwarded, peer ?? ''];
  const index = Math.max(0, chain.length - 1 - trustedHops);
  return normalise(chain[index]!) ?? (peer === undefined ? undefined : normalise(peer));
}

/** The client as the services see it: its address and user agent, nothing it could choose for identity. */
export function edgeClientOf(req: { socket: { remoteAddress?: string | undefined }; headers: IncomingHttpHeaders }, trustProxyHops: number)
  : EdgeClient {
  const userAgent = req.headers['user-agent'];
  return {
    address: clientAddress(req.socket.remoteAddress, req.headers['x-forwarded-for'], trustProxyHops),
    userAgent: typeof userAgent === 'string' && userAgent !== '' ? userAgent : undefined,
  };
}
