// Scoring a vocabulary match (spec 24.5 ontology search). Pure, so it is tested on its own.
//
// Names are compared case- and accent-insensitively, with api_name underscores read as
// spaces. Best first: an exact name, a name that starts with the text, a word that starts
// with it, every word of the text starting a word of the name, the text inside the name,
// a near spelling (trigram overlap, for a typo), and last the description.

const normalise = (text: string): string =>
  text.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[_\s]+/g, ' ').trim();

const words = (text: string): string[] => text.split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 0);

function trigrams(text: string): Set<string> {
  const padded = `  ${text} `;
  const grams = new Set<string>();
  for (let i = 0; i + 3 <= padded.length; i += 1) grams.add(padded.slice(i, i + 3));
  return grams;
}

/** Jaccard overlap of trigrams, 0 to 1, as pg_trgm's similarity. */
export function similarity(a: string, b: string): number {
  const x = trigrams(a);
  const y = trigrams(b);
  let shared = 0;
  for (const g of x) if (y.has(g)) shared += 1;
  const union = x.size + y.size - shared;
  return union === 0 ? 0 : shared / union;
}

export interface Scored {
  names: readonly (string | null | undefined)[];
  description?: string | null | undefined;
}

/** 0 when the text does not match. */
export function score(query: string, candidate: Scored): number {
  const q = normalise(query);
  if (q.length === 0) return 0;
  const qWords = words(q);
  let best = 0;
  for (const raw of candidate.names) {
    if (raw === null || raw === undefined) continue;
    const name = normalise(raw);
    if (name.length === 0) continue;
    const nWords = words(name);
    let s = 0;
    if (name === q) s = 1;
    else if (name.startsWith(q)) s = 0.9;
    else if (nWords.some((w) => w.startsWith(q))) s = 0.8;
    else if (qWords.length > 1 && qWords.every((qw) => nWords.some((w) => w.startsWith(qw)))) s = 0.7;
    else if (name.includes(q)) s = 0.6;
    else {
      const near = similarity(q, name);
      if (near >= 0.3) s = 0.25 + 0.3 * near;
    }
    best = Math.max(best, s);
  }
  if (best === 0 && candidate.description) {
    const d = normalise(candidate.description);
    const dWords = words(d);
    if (qWords.every((qw) => dWords.some((w) => w.startsWith(qw)))) best = 0.2;
  }
  return Math.round(best * 1000) / 1000;
}
