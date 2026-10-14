import crypto from 'node:crypto';

const BASE32 = 'abcdefghijkmnpqrstuvwxyz23456789'; // Crockford-ish, no ambiguous glyphs

/** Sortable-ish unique id: 8 hex chars of time + 12 random chars. */
export function newId(prefix = ''): string {
  const time = Date.now().toString(36).padStart(9, '0');
  const rand = crypto.randomBytes(8).toString('hex');
  return prefix ? `${prefix}_${time}${rand}` : `${time}${rand}`;
}

/**
 * Public share code used inside printed QR codes.
 *
 * Must stay short (WeChat caps the `scene` parameter of getUnlimited at 32
 * characters) and must not encode an organization id — a code is an opaque
 * lookup key, never an authorization token.
 */
export function newShareCode(length = 12): string {
  const bytes = crypto.randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i += 1) out += BASE32[bytes[i]! % BASE32.length];
  return out;
}

/** Human-facing receipt code shown to the registrant. */
export function newReceiptCode(): string {
  return newShareCode(8).toUpperCase();
}

export function slugify(input: string): string {
  const base = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return base || 'org';
}
