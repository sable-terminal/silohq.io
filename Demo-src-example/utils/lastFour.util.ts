/**
 * The only fragment of a credential permitted in clear text.
 *
 * IT EXISTS SO A PERSON CAN TELL TWO KEYS APART. "Which of these three Salesforce
 * connections is the one that broke" is unanswerable when every row reads
 * `••••••••`, and the alternative people reach for — storing a nickname — drifts
 * from reality the moment somebody rotates a key without renaming it.
 *
 * FOUR CHARACTERS, FROM THE END. The end because prefixes are shared: every
 * Stripe key starts `sk_live_`, so leading characters identify the vendor and not
 * the key. Four because it is enough to disambiguate a handful of credentials and
 * not enough to matter if the display leaks.
 *
 * SHORT SECRETS RETURN NOTHING. A four-character fragment of an eight-character
 * secret is half of it. Anything under sixteen gets no hint at all, because a
 * display convenience must never become a meaningful disclosure.
 */

const FRAGMENT = 4;
const MINIMUM_LENGTH = 16;

export function lastFour(secret: string): string | null {
  const trimmed = secret.trim();
  if (trimmed.length < MINIMUM_LENGTH) return null;
  return trimmed.slice(-FRAGMENT);
}

/**
 * A display string: a fixed number of dots and the fragment.
 *
 * THE DOTS DO NOT ENCODE THE LENGTH. Rendering one per character tells anybody
 * looking how long the secret is, which narrows a brute force and identifies the
 * credential type. It is always four.
 */
export function maskedDisplay(secret: string): string {
  const fragment = lastFour(secret);
  return fragment ? `••••${fragment}` : '••••••••';
}
