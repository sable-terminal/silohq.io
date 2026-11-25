import type { Grounding } from '../infra/model.infra';

/**
 * A web-grounded answer, with its sources numbered where they are used.
 *
 * ── EVERY OUTSIDE CLAIM CARRIES ITS SOURCE ────────────────────────────────
 *
 * The model's text says nothing about where it came from; the grounding says
 * which passage rests on which pages. A marker is put after each passage that
 * rests on something, numbered in the order sources are first used, so a
 * reader can go from any sentence to what it was read from. A source nothing
 * rests on is still listed — it was read — but carries no number in the text.
 *
 * PLAIN TEXT OUT. Markdown emphasis is dropped rather than rendered: the
 * Console shows sentences, and a stray `**` is noise in every one.
 */

export type Source = { n: number; title: string; url: string };

export function cite(text: string, grounding: Grounding | undefined): { paragraphs: string[]; sources: Source[] } {
  const numbered = new Map<number, number>();
  const inserts = new Map<number, number[]>();
  const usable = (index: number) => Boolean(grounding?.sources[index]?.url);

  for (const support of grounding?.supports ?? []) {
    const at = text.indexOf(support.text);
    const indices = support.sources.filter(usable);
    if (at < 0 || indices.length === 0) continue;

    const end = at + support.text.length;
    for (const index of indices) if (!numbered.has(index)) numbered.set(index, numbered.size + 1);
    inserts.set(end, [...new Set([...(inserts.get(end) ?? []), ...indices.map((index) => numbered.get(index)!)])]);
  }

  let marked = text;
  for (const end of [...inserts.keys()].sort((a, b) => b - a)) {
    const markers = inserts.get(end)!.sort((a, b) => a - b).map((n) => `[${n}]`).join('');
    marked = `${marked.slice(0, end)}${markers}${marked.slice(end)}`;
  }

  /* Sources read but cited by nothing follow the cited ones. */
  (grounding?.sources ?? []).forEach((_, index) => {
    if (usable(index) && !numbered.has(index)) numbered.set(index, numbered.size + 1);
  });

  const sources = [...numbered]
    .sort((a, b) => a[1] - b[1])
    .map(([index, n]) => ({ n, title: grounding!.sources[index]!.title, url: grounding!.sources[index]!.url }));

  const paragraphs = marked
    .replace(/\*\*|__/g, '')
    .split(/\n\s*\n/)
    .map((one) => one.replace(/^\s*(?:[*-]|#+)\s+/gm, '').trim())
    .filter(Boolean);

  return { paragraphs, sources };
}
