/**
 * Making untrusted input safe to store, render and put in a path.
 *
 * EVERYTHING HERE RUNS BEFORE THE VALUE REACHES ANYTHING ELSE. A sanitiser called
 * on the way out is a sanitiser somebody forgets to call on one of the three
 * places the value is rendered.
 */

/** HTML entity escaping for anything interpolated into markup. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * An SVG stripped of everything that can execute.
 *
 * AN UNSANITISED SVG IS STORED XSS ON EVERY PAGE THAT RENDERS IT. It is XML with
 * a full scripting surface: `<script>`, `on*` handlers, `<foreignObject>` holding
 * arbitrary HTML, `javascript:` URLs, `<use href="http://…">` pulling in remote
 * content, and entity declarations that can read local files.
 *
 * AN ALLOWLIST OF ELEMENTS AND ATTRIBUTES, NOT A DENYLIST. A denylist is a
 * promise to have thought of everything, renewed with every SVG specification
 * change. This drops anything not explicitly permitted, so an unknown element is
 * removed rather than passed through.
 *
 * A FULL XML PARSER WOULD BE BETTER. This is regex-based, which is a compromise:
 * it is conservative — it removes rather than rewrites, and rejects outright when
 * it sees something it cannot reason about — but a customer logo is worth a
 * proper parser eventually. Noted here rather than in a ticket nobody reads.
 */
const SVG_ALLOWED_ELEMENTS = new Set([
  'svg', 'g', 'path', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'rect',
  'text', 'tspan', 'defs', 'title', 'desc', 'linearGradient', 'radialGradient',
  'stop', 'clipPath', 'mask',
]);

const SVG_ALLOWED_ATTRIBUTES = new Set([
  'd', 'cx', 'cy', 'r', 'rx', 'ry', 'x', 'y', 'x1', 'y1', 'x2', 'y2', 'points',
  'width', 'height', 'viewBox', 'fill', 'fill-opacity', 'fill-rule', 'stroke',
  'stroke-width', 'stroke-linecap', 'stroke-linejoin', 'stroke-dasharray',
  'stroke-opacity', 'opacity', 'transform', 'offset', 'stop-color', 'stop-opacity',
  'gradientUnits', 'gradientTransform', 'clip-path', 'mask', 'id', 'class',
  'xmlns', 'version', 'preserveAspectRatio', 'font-family', 'font-size',
  'text-anchor', 'dominant-baseline',
]);

export interface SanitiseResult {
  ok: boolean;
  svg?: string;
  reason?: string;
}

export function sanitiseSvg(source: string): SanitiseResult {
  /*
   * REJECTED OUTRIGHT, NOT STRIPPED. A DOCTYPE can declare entities that expand
   * exponentially or read local files, and an XML processing instruction can
   * pull in a stylesheet. Removing them and continuing means reasoning about
   * what the rest of the document meant with them in place; refusing does not.
   */
  if (/<!DOCTYPE/i.test(source)) {
    return { ok: false, reason: 'SVG contains a DOCTYPE declaration.' };
  }
  if (/<!ENTITY/i.test(source)) {
    return { ok: false, reason: 'SVG contains entity declarations.' };
  }
  if (/<\?xml-stylesheet/i.test(source)) {
    return { ok: false, reason: 'SVG references an external stylesheet.' };
  }

  let svg = source;

  // Whole elements that can execute or fetch, with their contents.
  svg = svg.replace(/<script[\s\S]*?<\/script\s*>/gi, '');
  svg = svg.replace(/<style[\s\S]*?<\/style\s*>/gi, '');
  svg = svg.replace(/<foreignObject[\s\S]*?<\/foreignObject\s*>/gi, '');
  svg = svg.replace(/<(script|style|foreignObject|iframe|embed|object|animate|set)\b[^>]*\/?>/gi, '');

  // Every element not on the allowlist, tags only, keeping their text.
  svg = svg.replace(/<\/?([a-zA-Z][a-zA-Z0-9-]*)\b[^>]*>/g, (tag, name: string) =>
    SVG_ALLOWED_ELEMENTS.has(name) ? tag : '',
  );

  // Event handlers, in any spelling.
  svg = svg.replace(/\son[a-zA-Z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '');

  // Every attribute not on the allowlist. `xlink:href` and `href` go with them,
  // which is what stops `<use href="http://…">` and `javascript:` URLs.
  svg = svg.replace(/\s([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/g, (attr, name: string) =>
    SVG_ALLOWED_ATTRIBUTES.has(name) ? attr : '',
  );

  if (!/<svg[\s>]/i.test(svg)) {
    return { ok: false, reason: 'No <svg> element survived sanitisation.' };
  }

  return { ok: true, svg };
}

/**
 * A filename safe to store and to put in a header.
 *
 * PATH TRAVERSAL IS THE OBVIOUS ONE. `../../etc/passwd` as a key walks out of the
 * bucket prefix. Less obvious: a newline in a filename splits a
 * `Content-Disposition` header, and a null byte truncates a path in some
 * filesystem calls so `evil.svg\0.png` passes an extension check and lands as an
 * svg.
 */
export function safeFilename(name: string): string {
  const base = name.split(/[/\\]/).pop() ?? 'file';
  return base
    .replace(/\0/g, '')
    .replace(/[\r\n]/g, '')
    // Leading dots would produce a hidden file, and `..` is traversal.
    .replace(/^\.+/, '')
    .replace(/[^A-Za-z0-9._-]/g, '_')
    .slice(0, 200) || 'file';
}

/** An object-store key scoped to one tenant, so a leaked key cannot be walked. */
export function scopedObjectKey(organisationId: string, kind: string, filename: string): string {
  if (!/^[0-9a-f-]{36}$/i.test(organisationId)) {
    throw new Error('scopedObjectKey requires a uuid organisation id');
  }
  return `org/${organisationId}/${safeFilename(kind)}/${safeFilename(filename)}`;
}

/**
 * Import §7 — where an imported file sits. Scoped by organisation, then by the
 * source and the file, so purging a file is deleting one key and purging a
 * source is deleting one prefix.
 */
export function importObjectKey(
  organisationId: string,
  sourceId: string,
  fileId: string,
  filename: string,
): string {
  for (const id of [organisationId, sourceId, fileId]) {
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error('importObjectKey requires uuids');
  }
  return `org/${organisationId}/silo-import/${sourceId}/${fileId}/${safeFilename(filename)}`;
}

