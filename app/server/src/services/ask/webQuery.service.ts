// The outside-context query (spec 36.7): built from the question's own wording, after a
// literal pass that drops what the person typed as a literal (quoted text, addresses,
// links, dates, numbers and anything holding a digit, which is where identifiers live), so
// it carries no record value or placeholder. Words of two or more letters only; at most 200
// characters; none when fewer than two words remain.

export const MAX_WEB_QUERY = 200;

export function webQueryOf(question: string): string | null {
  const stripped = question
    .replace(/"[^"]*"|“[^”]*”|‘[^’]*’/g, ' ')
    .replace(/\bhttps?:\/\/\S+/gi, ' ')
    .replace(/\S+@\S+/g, ' ')
    .replace(/\b\d{4}-\d{2}-\d{2}(?:[T ][\d:.]+Z?)?\b/g, ' ')
    .replace(/[^\s]*\d[^\s]*/g, ' ')
    .replace(/[^\p{L}\p{M}\s'-]/gu, ' ');
  const words = stripped.split(/\s+/).map((w) => w.replace(/^['-]+|['-]+$/g, '')).filter((w) => [...w].length >= 2);
  if (words.length < 2) return null;
  let query = '';
  for (const word of words) {
    if ((query.length === 0 ? word.length : query.length + 1 + word.length) > MAX_WEB_QUERY) break;
    query = query.length === 0 ? word : `${query} ${word}`;
  }
  return query;
}
