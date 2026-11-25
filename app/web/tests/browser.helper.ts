// What every browser test shares: whether it can run here, the export built once, Chrome
// started headless, a page whose problems are collected (a script or style the policy blocks,
// a script error, a page or asset that did not load), signing in through the real page, and
// screenshots when SCREENSHOTS_DIR is set.

import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { createConnection, createServer } from 'node:net';
import path from 'node:path';
import { promisify } from 'node:util';
import { chromium, type Browser, type Page } from 'playwright-core';
import { LOCAL } from '../../server/tests/infra/services.helper.ts';
import { PASSWORD } from '../../server/tests/services/connect.helper.ts';

export const WEB_DIR = path.resolve(import.meta.dirname, '..');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const reachable = (port: number): Promise<boolean> => new Promise((resolve) => {
  const socket = createConnection({ host: '127.0.0.1', port }, () => {
    socket.destroy();
    resolve(true);
  });
  socket.on('error', () => resolve(false));
});

/** Why the browser tests cannot run here, or false. */
export const skip: string | false = !existsSync(CHROME) && process.env['CHROME_PATH'] === undefined ? 'no Chrome here'
  : !(await reachable(55432)) ? 'no local Postgres (npm run db:up in app/server)' : false;

let built: Promise<unknown> | undefined;
/** The export the gateway serves, built as a release builds it: once per test process. */
export function buildExport(): Promise<unknown> {
  built ??= promisify(execFile)('npx', ['next', 'build'], { cwd: WEB_DIR, env: { ...process.env, NEXT_TELEMETRY_DISABLED: '1' } });
  return built;
}

export const freePort = (): Promise<number> => new Promise((resolve) => {
  const server = createServer();
  server.listen(0, '127.0.0.1', () => {
    const { port } = server.address() as { port: number };
    server.close(() => resolve(port));
  });
});

/** The gateway's settings to serve the export at http://localhost:port (a secure context, so the __Host- cookie is kept). */
export async function gatewayAt(): Promise<{ origin: string; env: Record<string, string> }> {
  const port = await freePort();
  const origin = `http://localhost:${port}`;
  return {
    origin,
    env: {
      NATS_LIVE_URL: LOCAL.natsUrl, IDENTIFIER_HASH_KEY: randomBytes(32).toString('base64'),
      GATEWAY_PUBLIC_ORIGIN: origin, GATEWAY_PUBLIC_HOST: '127.0.0.1', GATEWAY_PUBLIC_PORT: String(port), TRUST_PROXY_HOPS: '0',
      GATEWAY_WEB_ROOT: path.join(WEB_DIR, 'out'),
    },
  };
}

export const launch = (): Promise<Browser> => chromium.launch({ executablePath: process.env['CHROME_PATH'] ?? CHROME, headless: true });

/** A page in a fresh context, its problems collected into the list given. */
export async function open(browser: Browser, problems: string[]): Promise<Page> {
  const page = await (await browser.newContext({ locale: 'en-GB' })).newPage();
  page.on('console', (message) => {
    if (message.type() === 'error' && !message.text().startsWith('Failed to load resource')) problems.push(`${page.url()}: ${message.text()}`);
  });
  page.on('pageerror', (error) => problems.push(`${page.url()}: ${error.message}`));
  // The API's refusals are answers the pages handle (401: not signed in); a page or asset that did not load is a problem.
  page.on('response', (response) => {
    if (!new URL(response.url()).pathname.startsWith('/api/') && response.status() >= 400) problems.push(`${response.status()} ${response.url()}`);
  });
  return page;
}

export async function signIn(page: Page, email: string, password: string = PASSWORD): Promise<void> {
  await page.getByLabel('Organisation').fill('acme');
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
}

/** With SCREENSHOTS_DIR set, the page as a person sees it, for a look by eye. */
export async function shot(page: Page, name: string): Promise<void> {
  const dir = process.env['SCREENSHOTS_DIR'];
  if (dir !== undefined) await page.screenshot({ path: path.join(dir, `${name}.png`), fullPage: false });
}
