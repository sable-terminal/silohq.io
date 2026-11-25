// The information architecture (guarantee 1): every capability a browser may call has exactly
// one home (a sidebar section, a settings or account page, the workspace frame, or the pages
// before sign-in); places are unique; the sidebar keeps spec 33.3's eleven areas in order; every
// + item names a real route.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ROUTES } from '../src/api/routes.generated.ts';
import type { RouteName } from '../src/api/client.api.ts';
import { AREAS } from '../src/navigation/areas.navigation.ts';
import { CREATE } from '../src/navigation/create.navigation.ts';
import { PLACES, homesOf, placeOf } from '../src/navigation/places.navigation.ts';
import { SUPPORT_ROUTES } from '../src/navigation/support.navigation.ts';

test('every route has exactly one home, and every home names a real route', () => {
  const homes = homesOf({ support: SUPPORT_ROUTES });
  const routes = Object.keys(ROUTES) as RouteName[];
  const homeless = routes.filter((r) => !homes.has(r));
  const twice = [...homes].filter(([, h]) => h.length > 1).map(([r, h]) => `${r} (${h.length})`);
  const unknown = [...homes.keys()].filter((r) => !(r in ROUTES));
  assert.deepEqual(homeless, [], 'routes with no home');
  assert.deepEqual(twice, [], 'routes with two homes');
  assert.deepEqual(unknown, [], 'homes naming routes that do not exist');
});

test('the sidebar keeps spec 33.3\'s eleven areas in their fixed order', () => {
  assert.deepEqual(AREAS.map((a) => a.label), ['Home', 'Explorer', 'Clones', 'Studio', 'Ask', 'Scenarios', 'Governance', 'Connect', 'Ontology', 'Files', 'Siloes']);
});

test('places are unique and each page path resolves to its own place', () => {
  const hrefs = PLACES.map((w) => w.place.href);
  assert.equal(new Set(hrefs).size, hrefs.length, 'one place per page');
  for (const where of PLACES) {
    assert.equal(placeOf(where.place.href)?.place, where.place, where.place.href);
    assert.ok(where.place.href.startsWith('/') && where.place.href.endsWith('/'), `${where.place.href}: absolute, with the trailing slash the export uses`);
    assert.ok(where.place.purpose.endsWith('.'), `${where.place.label}: its purpose is a sentence`);
    assert.ok(where.place.does.length > 0, `${where.place.label}: says what can be done`);
  }
  assert.equal(placeOf('/connect/connections/?id=x')?.place.id, 'connections');
  assert.equal(placeOf('/connect/connections/view/')?.place.id, 'connections', 'a page under a section belongs to it');
});

test('every + item makes something through a real route, from a real place', () => {
  for (const item of CREATE.flatMap((g) => g.items)) {
    assert.ok(item.route in ROUTES, `${item.label}: ${item.route}`);
    assert.ok(placeOf(item.href.split('?')[0]!) !== undefined, `${item.label}: ${item.href}`);
  }
});

test('every help guide points at real places and has steps', async () => {
  const { GUIDES } = await import('../src/help/guides.help.ts');
  const ids = new Set<string>();
  for (const guide of GUIDES) {
    assert.ok(!ids.has(guide.id), `${guide.id} is unique`);
    ids.add(guide.id);
    assert.ok(guide.steps.length > 0, `${guide.id} has steps`);
    for (const href of guide.places) assert.ok(href === '/help/' || PLACES.some((w) => w.place.href === href), `${guide.id}: ${href} is a place`);
  }
});
