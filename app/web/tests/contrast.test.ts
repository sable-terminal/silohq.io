// The design tokens meet WCAG 2.2 AA in both themes (spec 29.9): text and state colours 4.5:1
// on every surface they sit on, control outlines 3:1; the dark theme the device asks for and
// the one a person chooses are the same.

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';

const css = await readFile(path.resolve(import.meta.dirname, '../src/app/globals.css'), 'utf8');

function block(selector: string): Record<string, string> {
  const start = css.indexOf(`${selector} {`);
  assert.ok(start >= 0, `no ${selector} block`);
  const body = css.slice(start, css.indexOf('}', start));
  return Object.fromEntries([...body.matchAll(/(--[a-z-]+):\s*(#[0-9a-f]{6})/g)].map((m) => [m[1]!, m[2]!]));
}

const luminance = (hex: string): number => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
};
const ratio = (a: string, b: string): number => {
  const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (high! + 0.05) / (low! + 0.05);
};

const SURFACES = ['--bg', '--surface', '--surface-raised', '--surface-sunken', '--accent-soft'];
const TEXT = ['--text', '--text-muted', '--accent', '--ok', '--warn', '--danger'];

for (const [theme, tokens] of [['light', block(':root')], ['dark', block(':root[data-theme="dark"]')]] as const) {
  test(`${theme}: text and state colours read at 4.5:1 on every surface; outlines at 3:1`, () => {
    for (const fg of TEXT) {
      for (const bg of SURFACES) {
        assert.ok(ratio(tokens[fg]!, tokens[bg]!) >= 4.5, `${theme} ${fg} on ${bg}: ${ratio(tokens[fg]!, tokens[bg]!).toFixed(2)}`);
      }
    }
    for (const bg of SURFACES) {
      assert.ok(ratio(tokens['--border-strong']!, tokens[bg]!) >= 3, `${theme} --border-strong on ${bg}`);
    }
    assert.ok(ratio(tokens['--accent-text']!, tokens['--accent']!) >= 4.5, `${theme} --accent-text on --accent`);
    assert.ok(ratio(tokens['--danger-text']!, tokens['--danger']!) >= 4.5, `${theme} --danger-text on --danger`);
    assert.ok(ratio(tokens['--marking-text']!, tokens['--marking-bg']!) >= 4.5, `${theme} the marking banner`);
    for (const [fg, bg] of [['--ok', '--ok-soft'], ['--warn', '--warn-soft'], ['--danger', '--danger-soft'], ['--accent', '--info-soft'],
      ['--text', '--ok-soft'], ['--text', '--warn-soft'], ['--text', '--danger-soft'], ['--text-muted', '--ok-soft'], ['--text-muted', '--warn-soft'], ['--text-muted', '--danger-soft']]) {
      assert.ok(ratio(tokens[fg!]!, tokens[bg!]!) >= 4.5, `${theme} ${fg} on ${bg}: ${ratio(tokens[fg!]!, tokens[bg!]!).toFixed(2)}`);
    }
    for (const fg of ['--nav-text', '--nav-muted', '--nav-accent']) {
      for (const bg of ['--nav-bg', '--nav-hover', '--nav-active']) {
        assert.ok(ratio(tokens[fg]!, tokens[bg]!) >= 4.5, `${theme} ${fg} on ${bg}: ${ratio(tokens[fg]!, tokens[bg]!).toFixed(2)}`);
      }
    }
  });
}

test('the dark theme the device asks for is the one a person chooses', () => {
  const start = css.indexOf(':root:not([data-theme="light"]) {');
  const body = css.slice(start, css.indexOf('}', start));
  const asked = Object.fromEntries([...body.matchAll(/(--[a-z-]+):\s*(#[0-9a-f]{6})/g)].map((m) => [m[1]!, m[2]!]));
  assert.deepEqual(asked, block(':root[data-theme="dark"]'));
});

// --accent-text and --danger-text are text on a filled accent or danger background: white in the
// light theme. A rule that sets one as its colour without that fill puts white text on a light
// surface, which the token checks above cannot see; every stylesheet is read for it.
test('text on a fill only: --accent-text and --danger-text only where the rule fills with --accent or --danger', async () => {
  const { readdir } = await import('node:fs/promises');
  const root = path.resolve(import.meta.dirname, '../src');
  const files = (await readdir(root, { recursive: true })).filter((f) => f.endsWith('.css') && !f.endsWith('globals.css'));
  const misuse: string[] = [];
  for (const file of files) {
    const text = await readFile(path.join(root, file), 'utf8');
    for (const m of text.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
      const body = m[2]!;
      for (const [token, fill] of [['--accent-text', '--accent'], ['--danger-text', '--danger']] as const) {
        if (new RegExp(`(^|[^-])color:\\s*var\\(${token}\\)`).test(body) && !new RegExp(`background(-color)?:\\s*var\\(${fill}\\)`).test(body)) {
          misuse.push(`${file}: ${m[1]!.trim()}`);
        }
      }
    }
  }
  assert.deepEqual(misuse, []);
});
