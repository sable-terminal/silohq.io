/**
 * What a file actually is, decided from its bytes.
 *
 * THE CLIENT-DECLARED CONTENT TYPE IS A SUGGESTION FROM A STRANGER. An upload
 * form sends whatever the browser was told, and a script sends whatever it likes.
 * Trusting it means a `.svg` announced as `image/png` is stored, served with the
 * declared type, and then rendered — which is how a logo upload becomes stored
 * cross-site scripting on every page that shows it.
 *
 * SNIFFED FIRST, THEN CHECKED AGAINST AN ALLOWLIST. Not "reject known-bad": a
 * denylist of dangerous formats is a list somebody has to keep complete forever.
 */

export type SniffedType =
  | 'image/png'
  | 'image/jpeg'
  | 'image/webp'
  | 'image/gif'
  | 'image/svg+xml'
  | 'application/pdf'
  | 'application/zip'
  | 'unknown';

/**
 * Magic bytes.
 *
 * `application/zip` MATTERS EVEN THOUGH NOBODY UPLOADS A ZIP. Every modern Office
 * format — xlsx, docx, pptx — is a zip, so this is how they present. Treating an
 * unrecognised zip as "unknown" would reject the spreadsheet uploads the product
 * depends on; treating it as safe without looking inside would accept anything.
 */
const SIGNATURES: ReadonlyArray<{ type: SniffedType; bytes: readonly number[]; offset?: number }> = [
  { type: 'image/png', bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { type: 'image/jpeg', bytes: [0xff, 0xd8, 0xff] },
  { type: 'image/gif', bytes: [0x47, 0x49, 0x46, 0x38] },
  { type: 'application/pdf', bytes: [0x25, 0x50, 0x44, 0x46] },
  { type: 'application/zip', bytes: [0x50, 0x4b, 0x03, 0x04] },
];

function matches(buffer: Buffer, bytes: readonly number[], offset = 0): boolean {
  if (buffer.length < offset + bytes.length) return false;
  return bytes.every((b, i) => buffer[offset + i] === b);
}

export function sniff(buffer: Buffer): SniffedType {
  for (const signature of SIGNATURES) {
    if (matches(buffer, signature.bytes, signature.offset)) return signature.type;
  }

  // WebP is RIFF with a WEBP marker at byte 8. The RIFF header alone is also
  // used by wav and avi, so both halves have to match.
  if (matches(buffer, [0x52, 0x49, 0x46, 0x46]) && matches(buffer, [0x57, 0x45, 0x42, 0x50], 8)) {
    return 'image/webp';
  }

  /*
   * SVG HAS NO MAGIC BYTES BECAUSE IT IS XML. It has to be detected by content,
   * and only the leading bytes are examined — reading the whole file to find an
   * `<svg` a megabyte in would mean a crafted file could make this expensive.
   * Leading whitespace, a BOM, an XML declaration and comments are all legal
   * before the root element.
   */
  const head = buffer.subarray(0, 1024).toString('utf8').trimStart();
  const withoutBom = head.replace(/^﻿/, '');
  if (/^<\?xml[\s\S]*?\?>/.test(withoutBom) || withoutBom.startsWith('<')) {
    if (/<svg[\s>]/i.test(head)) return 'image/svg+xml';
  }

  return 'unknown';
}

/**
 * Whether the sniffed type is permitted, and whether the client lied.
 *
 * A MISMATCH IS REPORTED, NOT SILENTLY CORRECTED. Storing the sniffed type and
 * moving on hides that somebody sent a file announcing itself as something else,
 * which is a signal worth an audit row even when the file turns out to be fine.
 */
export function verifyUpload(
  buffer: Buffer,
  declared: string | undefined,
  allowed: readonly SniffedType[],
): { ok: boolean; sniffed: SniffedType; mismatch: boolean; reason?: string } {
  const sniffed = sniff(buffer);
  const mismatch = declared !== undefined && declared.split(';')[0]!.trim() !== sniffed;

  if (!allowed.includes(sniffed)) {
    return {
      ok: false,
      sniffed,
      mismatch,
      reason:
        sniffed === 'unknown'
          ? 'The file type could not be identified from its contents.'
          : `${sniffed} is not an accepted format.`,
    };
  }

  return { ok: true, sniffed, mismatch };
}
