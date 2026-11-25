// Email addresses. The directory routes a login by a keyed hash of the lower-cased
// address (spec 6.2: "HMAC-SHA-256 of the lower-cased address under a directory key in
// KMS"); the HMAC itself runs in the KMS (src/infra/kms.infra.ts), so the key never
// enters the process. This module only fixes the normal form both sides hash.

export function normaliseEmail(address: string): string {
  return address.normalize('NFC').trim().toLowerCase();
}

// A cheap shape check before any lookup. Deliverability is proven by the email itself.
export function looksLikeEmail(address: string): boolean {
  const normal = normaliseEmail(address);
  return normal.length <= 320 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normal);
}

// What the directory hashes: a fixed label and the normal form, so the same key could
// never produce this hash for another purpose.
export function emailRoutingInput(address: string): Buffer {
  return Buffer.from(`silo.identity_routing.v1\u0000${normaliseEmail(address)}`, 'utf8');
}
