import type { FastifyReply, FastifyRequest } from 'fastify';
import { verifyToken } from '../lib/token.js';
import { unauthorized } from '../lib/errors.js';
import { getUser, type UserRow } from '../services/users.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** Present when a valid session token was supplied. */
    user?: UserRow;
  }
}

export function extractToken(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  if (header && header.startsWith('Bearer ')) return header.slice(7).trim();
  const query = request.query as Record<string, string | undefined> | undefined;
  return query?.token ?? null;
}

/** Attaches `request.user` when a valid token is present, otherwise stays anonymous. */
export async function attachUser(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
  const token = extractToken(request);
  if (!token) return;
  const payload = verifyToken(token);
  if (!payload) return;
  const user = getUser(payload.uid);
  // token_version is re-read on every request, so a revoked session dies at once.
  if (!user || user.token_version !== payload.ver) return;
  request.user = user;
}

export function requireUser(request: FastifyRequest): UserRow {
  if (!request.user) throw unauthorized();
  return request.user;
}
