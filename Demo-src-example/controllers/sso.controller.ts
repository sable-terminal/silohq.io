import type { Request, Response } from 'express';
import * as ssoService from '../services/sso.service';
import { actorOf } from '../middleware/authorise.middleware';
import { body, query } from '../middleware/validate.middleware';
import { authConfig } from '../config/auth.config';
import { SESSION_TTL_SECONDS } from '../config/constants.config';
import { env } from '../config/env.config';

export async function listProviders(req: Request, res: Response): Promise<void> {
  res.status(200).json({ providers: await ssoService.list(actorOf(req)) });
}

export async function configure(req: Request, res: Response): Promise<void> {
  const input = body<{
    name: string; issuer: string; clientId: string; clientSecret: string; domains: string[];
  }>(req);
  res.status(201).json({ provider: await ssoService.configure(actorOf(req), input) });
}

/**
 * Where a sign-in starts.
 *
 * ANSWERS THE SAME WAY WHETHER OR NOT A DIRECTORY EXISTS FOR THE ADDRESS —
 * `{ sso: false }` and a redirect are both 200. A 404 for "no provider" would
 * tell an anonymous caller which domains a Silo customer has configured, which
 * is a list of who buys this product.
 */
export async function begin(req: Request, res: Response): Promise<void> {
  const { email, returnTo } = body<{ email: string; returnTo?: string }>(req);
  const started = await ssoService.begin({ email, returnTo });

  res.status(200).json(started ? { sso: true, redirectTo: started.redirectTo } : { sso: false });
}

/**
 * Where the directory sends them back.
 *
 * A REDIRECT, NOT JSON. The browser arrives here by navigation, so the response
 * has to be somewhere to be — a JSON body would leave the person looking at a
 * page of braces. Failures go to the sign-in page carrying a code the page can
 * explain, rather than rendering an error the person cannot act on.
 */
export async function callback(req: Request, res: Response): Promise<void> {
  const params = query<{ state?: string; code?: string; error?: string }>(req);

  if (params.error || !params.state || !params.code) {
    res.redirect(`${env.APP_URL}/sign-in?sso=failed`);
    return;
  }

  try {
    const outcome = await ssoService.complete({ state: params.state, code: params.code });

    res.cookie(authConfig.cookie.name, outcome.token, {
      ...authConfig.cookie,
      maxAge: SESSION_TTL_SECONDS * 1000,
    });

    // `returnTo` was validated as a local path before it was stored, so it
    // cannot send somebody off this origin.
    res.redirect(`${env.APP_URL}${outcome.returnTo ?? '/'}`);
  } catch (error) {
    req.log.warn({ err: error }, 'SSO callback failed');
    const code =
      typeof error === 'object' && error !== null && 'code' in error
        ? String((error as { code: unknown }).code)
        : 'unknown';
    res.redirect(`${env.APP_URL}/sign-in?sso=failed&reason=${encodeURIComponent(code)}`);
  }
}
