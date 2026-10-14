import { all, get, run } from '../db/index.js';
import { forbidden, notFound } from './errors.js';
import { newId } from './ids.js';
import { nowIso } from './time.js';

export type MemberRole = 'owner' | 'admin' | 'operator';

const ROLE_RANK: Record<MemberRole, number> = { operator: 1, admin: 2, owner: 3 };

export function roleAtLeast(role: MemberRole, min: MemberRole): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[min];
}

export interface MembershipRow {
  id: string;
  organization_id: string;
  user_id: string;
  role: MemberRole;
}

/**
 * The single tenant gate. Every organization-scoped read and write goes
 * through here.
 *
 * Membership is re-read from the database on every request rather than trusted
 * from the token, so revoking someone's role takes effect immediately. When
 * the caller has no membership we raise 404, not 403: a 403 would confirm that
 * the organization id exists, which is itself a leak.
 */
export function requireMembership(
  organizationId: string,
  userId: string,
  minRole: MemberRole = 'operator',
): MembershipRow {
  const row = get<MembershipRow>(
    'SELECT id, organization_id, user_id, role FROM organization_members WHERE organization_id = ? AND user_id = ?',
    organizationId,
    userId,
  );
  if (!row) throw notFound('机构不存在或无权访问');
  if (!roleAtLeast(row.role, minRole)) throw forbidden('当前角色没有该操作权限');
  return row;
}

/** Same check, but returns null instead of throwing. */
export function findMembership(
  organizationId: string,
  userId: string,
): MembershipRow | undefined {
  return get<MembershipRow>(
    'SELECT id, organization_id, user_id, role FROM organization_members WHERE organization_id = ? AND user_id = ?',
    organizationId,
    userId,
  );
}

export function listUserOrganizations(userId: string) {
  return all(
    `SELECT o.*, m.role AS member_role
       FROM organization_members m
       JOIN organizations o ON o.id = m.organization_id
      WHERE m.user_id = ?
      ORDER BY o.created_at DESC`,
    userId,
  );
}

/**
 * Loads a project **always** constrained by organization_id. The tenant filter
 * lives inside the query, so there is no window where a project is fetched
 * unscoped and checked afterwards.
 */
export function requireProject<T extends Record<string, any>>(
  organizationId: string,
  projectId: string,
): T {
  const row = get<T>('SELECT * FROM projects WHERE id = ? AND organization_id = ?', projectId, organizationId);
  if (!row) throw notFound('项目不存在或无权访问');
  return row;
}

export function requireRegistration<T extends Record<string, any>>(
  organizationId: string,
  registrationId: string,
): T {
  const row = get<T>(
    'SELECT * FROM registrations WHERE id = ? AND organization_id = ?',
    registrationId,
    organizationId,
  );
  if (!row) throw notFound('报名记录不存在或无权访问');
  return row;
}

export function audit(
  organizationId: string | null,
  userId: string | null,
  action: string,
  target?: { type: string; id: string; meta?: unknown },
): void {
  run(
    `INSERT INTO audit_logs (id, organization_id, user_id, action, target_type, target_id, meta, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    newId('log'),
    organizationId,
    userId,
    action,
    target?.type ?? null,
    target?.id ?? null,
    target?.meta ? JSON.stringify(target.meta) : null,
    nowIso(),
  );
}
