// Every page, opened in a real browser (guarantee 6; U16): one main landmark holding one page
// heading; every control and every link or button with a name a screen reader can say; every
// image with alternative text; no id used twice and no ARIA reference to an id that is not there;
// nothing pulled out of the keyboard's order by a positive tabindex. A page whose service is not
// running here shows its error state, which must meet the same bar. No script or style is
// blocked anywhere (the browser helper collects console errors and failed loads).

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import type { Browser, Page } from 'playwright-core';
import { createAskService } from '../../server/src/routes/ask/index.route.ts';
import { createGatewayService } from '../../server/src/routes/gateway/index.route.ts';
import { createSiloesCaptureService } from '../../server/src/routes/siloes-capture/index.route.ts';
import { createWorkspaceService } from '../../server/src/routes/workspace/index.route.ts';
import { unavailableEngine } from '../../server/src/services/workspace/queryEngine.service.ts';
import { createConnectCell, type ConnectCell } from '../../server/tests/services/connect.helper.ts';
import { PLACES } from '../src/navigation/places.navigation.ts';
import { buildExport, gatewayAt, launch, open, signIn, skip } from './browser.helper.ts';

let cell: ConnectCell;
let browser: Browser;
let origin: string;
let page: Page;
const problems: string[] = [];

/** What is wrong with the page as it stands, each a sentence naming the element. */
function audit(): string[] {
  const found: string[] = [];
  const describe = (e: Element) => `<${e.tagName.toLowerCase()}${e.id !== '' ? `#${e.id}` : ''}${e.getAttribute('class') !== null ? `.${e.getAttribute('class')!.split(' ')[0]}` : ''}>`;
  const visible = (e: Element) => {
    const box = (e as HTMLElement).getBoundingClientRect();
    return box.width > 0 && box.height > 0 && getComputedStyle(e).visibility !== 'hidden';
  };
  const byIds = (ids: string | null) => (ids ?? '').split(/\s+/).filter(Boolean).map((id) => document.getElementById(id));
  const textOf = (ids: string | null) => byIds(ids).map((e) => e?.textContent ?? '').join(' ').trim();
  const nameOf = (e: Element): string => {
    const labelled = textOf(e.getAttribute('aria-labelledby'));
    if (labelled !== '') return labelled;
    const label = e.getAttribute('aria-label')?.trim() ?? '';
    if (label !== '') return label;
    if (e instanceof HTMLInputElement || e instanceof HTMLSelectElement || e instanceof HTMLTextAreaElement) {
      const labels = [...(e.labels ?? [])].map((l) => l.textContent ?? '').join(' ').trim();
      if (labels !== '') return labels;
      return e.getAttribute('title')?.trim() ?? '';
    }
    const own = [...e.querySelectorAll('img[alt], svg[aria-label]')].map((i) => i.getAttribute('alt') ?? i.getAttribute('aria-label') ?? '').join(' ');
    return `${e.textContent ?? ''} ${own}`.trim() || (e.getAttribute('title')?.trim() ?? '');
  };

  const mains = document.querySelectorAll('main');
  if (mains.length !== 1) found.push(`${mains.length} main landmarks, not one`);
  const headings = [...document.querySelectorAll('main h1')].filter(visible);
  if (headings.length !== 1) found.push(`${headings.length} page headings (h1) in main, not one; it showed "${(mains[0] as HTMLElement | undefined)?.innerText.replace(/\s+/g, ' ').slice(0, 160) ?? ''}"`);

  for (const e of document.querySelectorAll('input:not([type=hidden]), select, textarea, [role=switch], [role=combobox], [role=checkbox], [role=radio], [role=slider], [role=textbox]')) {
    if (visible(e) && nameOf(e) === '') found.push(`${describe(e)}: a control with no name`);
  }
  for (const e of document.querySelectorAll('button, a[href], [role=button], [role=link], [role=menuitem], [role=tab]')) {
    if (visible(e) && nameOf(e) === '') found.push(`${describe(e)}: a ${e.tagName === 'A' ? 'link' : 'button'} with no name`);
  }
  for (const e of document.querySelectorAll('img')) {
    if (!e.hasAttribute('alt')) found.push(`${describe(e)}: an image with no alt`);
  }
  for (const e of document.querySelectorAll('table')) {
    if (visible(e) && nameOf(e) === '' && e.querySelector('caption') === null) found.push(`${describe(e)}: a table with no name`);
  }
  const seen = new Map<string, number>();
  for (const e of document.querySelectorAll('[id]')) seen.set(e.id, (seen.get(e.id) ?? 0) + 1);
  for (const [id, n] of seen) if (n > 1) found.push(`id "${id}" used ${n} times`);
  for (const attr of ['aria-labelledby', 'aria-describedby', 'aria-controls']) {
    for (const e of document.querySelectorAll(`[${attr}]`)) {
      for (const [i, target] of byIds(e.getAttribute(attr)).entries()) {
        if (target === null) found.push(`${describe(e)}: ${attr} names "${e.getAttribute(attr)!.split(/\s+/).filter(Boolean)[i]}", which is not on the page`);
      }
    }
  }
  for (const e of document.querySelectorAll('[tabindex]')) {
    if (Number(e.getAttribute('tabindex')) > 0) found.push(`${describe(e)}: tabindex ${e.getAttribute('tabindex')} takes it out of the keyboard's order`);
  }
  return found;
}

describe('Every page, for everyone (guarantee 6)', { skip }, () => {
  before(async () => {
    await buildExport();
    const gateway = await gatewayAt();
    origin = gateway.origin;
    cell = await createConnectCell();
    await cell.start(createSiloesCaptureService({ schedule: false }), 'siloes-capture', 'test_app',
      { SILOES_POSTGRES_PRICE_PER_GIB_MONTH: '0.20', SILOES_STORAGE_PRICE_PER_GIB_MONTH: '0.02' });
    await cell.start(createWorkspaceService(), 'workspace', 'test_app');
    await cell.start(createAskService({ engine: unavailableEngine, webSearch: { search: async () => [] } }), 'ask', 'test_app');
    // A person opens a page or two a minute; this opens every page in two, so the per-session limit is raised here (it is tested in the gateway's own suite).
    await cell.start(createGatewayService(), 'gateway', 'test_app', { ...gateway.env, GATEWAY_REQUESTS_PER_SESSION: '100000' });
    await cell.signIn('root@acme.example');
    browser = await launch();
    page = await open(browser, problems);
    await page.goto(`${origin}/`);
    await page.waitForURL(/\/sign-in\//);
    await signIn(page, 'root@acme.example');
    await page.waitForURL(`${origin}/`);
  });

  after(async () => {
    await browser?.close();
    await cell?.close();
  });

  test('home, every section, every settings page and every account page', async () => {
    const failures: string[] = [];
    for (const href of ['/', ...PLACES.map((w) => w.place.href)]) {
      problems.length = 0;
      await page.goto(`${origin}${href}`);
      await page.locator('main h1').first().waitFor({ timeout: 15_000 }).catch(() => undefined);
      // Settled: nothing in the page still says it is loading (or, at worst, ten seconds on).
      await page.waitForFunction(() => ![...document.querySelectorAll('main [role=status]')].some((e) => /^(Loading|Running|Reading|Opening)/.test(e.textContent?.trim() ?? '')),
        undefined, { timeout: 10_000 }).catch(() => undefined);
      const found = [...await page.evaluate(audit), ...problems];
      if (found.length > 0) failures.push(`${href}\n  ${found.join('\n  ')}`);
    }
    assert.deepEqual(failures, [], `pages that fall short:\n${failures.join('\n')}`);
  });
});
