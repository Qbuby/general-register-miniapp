import crypto from 'node:crypto';
import { config } from '../config.js';

export interface TokenPayload {
  /** user id */
  uid: string;
  /** user.token_version — bumping it invalidates every issued token */
  ver: number;
  /** issued at, epoch seconds */
  iat: number;
  /** expiry, epoch seconds */
  exp: number;
}

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

function sign(data: string): string {
  return crypto.createHmac('sha256', config.tokenSecret).update(data).digest('base64url');
}

export function signToken(uid: string, ver: number): string {
  const now = Math.floor(Date.now() / 1000);
  const payload: TokenPayload = { uid, ver, iat: now, exp: now + config.tokenTtlSeconds };
  const body = b64url(JSON.stringify(payload));
  return `${body}.${sign(body)}`;
}

export function verifyToken(token: string): TokenPayload | null {
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [body, signature] = parts as [string, string];
  const expected = sign(body);
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as TokenPayload;
    if (typeof payload.exp !== 'number' || payload.exp * 1000 < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}
