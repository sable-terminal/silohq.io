// SVG sanitisation (spec 41.4): an uploaded SVG is a stored cross-site scripting vector on every
// page that renders it, so it is rebuilt from an allowlist rather than cleaned of what is known
// to be dangerous. Pure.
//
// - Refused unread: a DOCTYPE or entity declaration (no entity of the file's is ever expanded),
//   and anything that does not parse or whose root is not <svg>.
// - Kept: shapes, paths, text, groups, gradients, patterns, clip paths, masks, markers and
//   symbols, with their geometry and presentation attributes. Dropped with everything inside
//   them: script, foreignObject, image, a, style, animation and every other element.
// - An attribute is kept only when allowlisted: no event handler, no style attribute; a link
//   (href, xlink:href) only to a fragment of the same document (#id); a paint or reference
//   value with url() only as url(#id). Values become escaped attribute text, names come from
//   the allowlist, and text is escaped: nothing from the file reaches the output as markup.

import { XMLParser } from 'fast-xml-parser';

const ELEMENTS = new Set([
  'svg', 'g', 'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'text', 'tspan', 'textPath', 'defs', 'linearGradient',
  'radialGradient', 'stop', 'title', 'desc', 'clipPath', 'mask', 'pattern', 'symbol', 'use', 'marker',
]);

const ATTRIBUTES = new Set([
  'id', 'class', 'x', 'y', 'x1', 'y1', 'x2', 'y2', 'cx', 'cy', 'r', 'rx', 'ry', 'fx', 'fy', 'dx', 'dy', 'width', 'height', 'd', 'points',
  'viewBox', 'preserveAspectRatio', 'transform', 'fill', 'fill-opacity', 'fill-rule', 'stroke', 'stroke-width', 'stroke-opacity',
  'stroke-linecap', 'stroke-linejoin', 'stroke-miterlimit', 'stroke-dasharray', 'stroke-dashoffset', 'opacity', 'font-family', 'font-size',
  'font-weight', 'font-style', 'text-anchor', 'dominant-baseline', 'letter-spacing', 'offset', 'stop-color', 'stop-opacity', 'gradientUnits',
  'gradientTransform', 'spreadMethod', 'clip-path', 'clip-rule', 'clipPathUnits', 'mask', 'maskUnits', 'maskContentUnits', 'marker-start',
  'marker-mid', 'marker-end', 'markerWidth', 'markerHeight', 'markerUnits', 'refX', 'refY', 'orient', 'patternUnits', 'patternContentUnits',
  'patternTransform', 'xmlns', 'xmlns:xlink', 'version', 'href', 'xlink:href', 'visibility', 'display', 'vector-effect',
]);

const LINKS = new Set(['href', 'xlink:href']);
const NAMESPACES: Readonly<Record<string, string>> = { xmlns: 'http://www.w3.org/2000/svg', 'xmlns:xlink': 'http://www.w3.org/1999/xlink' };
const FRAGMENT = /^#[A-Za-z_][A-Za-z0-9_.:-]*$/;
const URL_REF = /url\s*\(/i;
const LOCAL_URL = /^url\(\s*#[A-Za-z_][A-Za-z0-9_.:-]*\s*\)$/;
const NOT_XML = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/;

export class SvgRefused extends Error {
  readonly reason: 'dtd' | 'unreadable' | 'not_svg';

  constructor(reason: 'dtd' | 'unreadable' | 'not_svg') {
    super(`the SVG is refused: ${reason}`);
    this.reason = reason;
  }
}

/**
 * Whether bytes may be an SVG document: markup holding an <svg element anywhere near its start.
 * Generous on purpose (a DTD's internal subset, comments or a prolog may come first): whatever
 * might render as an SVG is sanitised, or refused.
 */
export function looksLikeSvg(bytes: Buffer): boolean {
  const head = bytes.subarray(0, 64 * 1024).toString('utf8').replace(/^\uFEFF/, '');
  return /^\s*</.test(head) && /<svg[\s>/]/i.test(head);
}

const escape = (text: string): string => text.replace(NOT_XML, '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;');

function keepValue(name: string, value: string): boolean {
  if (/javascript:|vbscript:|data:/i.test(value.replace(/\s+/g, ''))) return false;
  if (LINKS.has(name)) return FRAGMENT.test(value.trim());
  if (name in NAMESPACES) return value === NAMESPACES[name];
  if (URL_REF.test(value)) return LOCAL_URL.test(value.trim());
  return true;
}

type Node = Record<string, unknown>;

function render(nodes: readonly Node[]): string {
  let out = '';
  for (const node of nodes) {
    if ('#text' in node) { out += escape(String(node['#text'])); continue; }
    const name = Object.keys(node).find((k) => k !== ':@');
    if (name === undefined || !ELEMENTS.has(name)) continue;
    const attributes = (node[':@'] ?? {}) as Record<string, unknown>;
    const kept = Object.entries(attributes).filter(([a, v]) => ATTRIBUTES.has(a) && typeof v === 'string' && keepValue(a, v));
    const children = render((node[name] ?? []) as Node[]);
    out += `<${name}${kept.map(([a, v]) => ` ${a}="${escape(v as string)}"`).join('')}${children === '' ? '/>' : `>${children}</${name}>`}`;
  }
  return out;
}

/** The SVG rebuilt from the allowlist, as UTF-8 bytes. */
export function sanitiseSvg(bytes: Buffer): Buffer {
  const text = bytes.toString('utf8').replace(/^\uFEFF/, '');
  if (/<!DOCTYPE|<!ENTITY/i.test(text)) throw new SvgRefused('dtd');
  let parsed: Node[];
  try {
    parsed = new XMLParser({
      preserveOrder: true, ignoreAttributes: false, attributeNamePrefix: '', parseTagValue: false, parseAttributeValue: false,
      trimValues: false, processEntities: true, htmlEntities: true, commentPropName: '#comment',
    }).parse(text) as Node[];
  } catch {
    throw new SvgRefused('unreadable');
  }
  const roots = parsed.filter((n) => !('?xml' in n) && !('#comment' in n) && !('#text' in n && String(n['#text']).trim() === ''));
  if (roots.length !== 1 || !('svg' in roots[0]!)) throw new SvgRefused('not_svg');
  const root = roots[0]!;
  const attributes = { xmlns: NAMESPACES['xmlns'], ...(root[':@'] as Record<string, unknown> | undefined) };
  return Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>${render([{ svg: root['svg'], ':@': attributes }])}`, 'utf8');
}
