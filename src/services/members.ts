import { all, get, run, tx } from '../db/index.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { newId, newShareCode } from '../lib/ids.js';
import { nowIso } from '../lib/time.js';
import type { MemberRole } from '../lib/tenant.js';

const GRANTABLE_ROLES: MemberRole[] = ['admin', 'operator'];
const INVITE_TTL_DAYS = 7;

export const ROLE_LABELS: Record<MemberRole, string> = {
  owner: '所有者',
  admin: '管理员',
  operator: '运营',
};

export const ROLE_DESCRIPTIONS: Record<MemberRole, string> = {
  owner: '全部权限，可管理成员与二维码',
  admin: '可编辑机构资料、项目与报名表',
  operator: '可查看报名记录、处理报名与查看二维码',
};

export interface MemberRow {
  id: string;
  organization_id: string;
  user_id: string;
  role: MemberRole;
  nickname: string;
  avatar_url: string | null;
  created_at: string;
}

export function listMembers(organizationId: string): MemberRow[] {
  return all<MemberRow>(
    `SELECT m.id, m.organization_id, m.user_id, m.role, m.created_at,
            COALESCE(u.nickname, '') AS nickname, u.avatar_url
       FROM organization_members m
       JOIN users u ON u.id = m.user_id
      WHERE m.organization_id = ?
      ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END, m.created_at ASC`,
    organizationId,
  );
}

export function ownerCount(organizationId: string): number {
  return (
    get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM organization_members WHERE organization_id = ? AND role = 'owner'`,
      organizationId,
    )?.n ?? 0
  );
}

export function memberCountOf(organizationId: string): number {
  return (
    get<{ n: number }>(
      'SELECT COUNT(*) AS n FROM organization_members WHERE organization_id = ?',
      organizationId,
    )?.n ?? 0
  );
}

export function createInvite(organizationId: string, createdBy: string, role: MemberRole) {
  if (!GRANTABLE_ROLES.includes(role)) {
    throw badRequest('邀请只能授予「管理员」或「运营」角色', 'invalid_role');
  }
  const id = newId('inv');
  const code = newShareCode(10);
  const expiresAt = new Date(Date.now() + INVITE_TTL_DAYS * 86400000).toISOString();
  run(
    `INSERT INTO organization_invites
       (id, organization_id, code, role, status, created_by, expires_at, created_at)
     VALUES (?, ?, ?, ?, 'pending', ?, ?, ?)`,
    id,
    organizationId,
    code,
    role,
    createdBy,
    expiresAt,
    nowIso(),
  );
  return getInviteRow(code)!;
}

export function getInviteRow(code: string) {
  return get<Record<string, any>>('SELECT * FROM organization_invites WHERE code = ?', (code || '').trim());
}

export function listInvites(organizationId: string) {
  return all<Record<string, any>>(
    `SELECT i.*, u.nickname AS creator_nickname
       FROM organization_invites i
       JOIN users u ON u.id = i.created_by
      WHERE i.organization_id = ?
      ORDER BY i.created_at DESC
      LIMIT 50`,
    organizationId,
  );
}

/**
 * 接受邀请。
 *
 * 在一个事务里完成三件事，保证并发下不会出现「同一个码被两个人同时接受」：
 * 条件更新把这一行抢占掉（status 必须是 pending 且未过期），
 * 再插入成员关系。
 */
export function acceptInvite(code: string, userId: string) {
  return tx(() => {
    const invite = getInviteRow(code);
    if (!invite) throw notFound('邀请码无效或已失效');
    if (invite.status === 'accepted') throw conflict('该邀请码已被使用', 'invite_used');
    if (invite.status === 'revoked') throw conflict('该邀请码已被撤销', 'invite_revoked');
    if (invite.expires_at <= nowIso()) throw conflict('邀请码已过期，请让机构重新生成', 'invite_expired');

    const existing = get<{ id: string; role: MemberRole }>(
      'SELECT id, role FROM organization_members WHERE organization_id = ? AND user_id = ?',
      invite.organization_id,
      userId,
    );
    if (existing) {
      throw conflict('你已经是该机构的成员', 'already_member');
    }

    const claimed = run(
      `UPDATE organization_invites
          SET status = 'accepted', accepted_by = ?, accepted_at = ?
        WHERE code = ? AND status = 'pending'`,
      userId,
      nowIso(),
      invite.code,
    );
    // 条件更新影响 0 行 = 别人先一步接受了
    if (claimed.changes === 0) throw conflict('该邀请码已被使用', 'invite_used');

    run(
      `INSERT INTO organization_members (id, organization_id, user_id, role, created_at)
       VALUES (?, ?, ?, ?, ?)`,
      newId('mem'),
      invite.organization_id,
      userId,
      invite.role,
      nowIso(),
    );

    const organization = get<Record<string, any>>(
      'SELECT id, name FROM organizations WHERE id = ?',
      invite.organization_id,
    );
    // 外键保证机构存在；这里只是让类型与错误信息都明确。
    if (!organization) throw notFound('机构不存在');
    return { organization, role: invite.role as MemberRole };
  });
}

export function revokeInvite(organizationId: string, inviteId: string) {
  const result = run(
    `UPDATE organization_invites SET status = 'revoked'
      WHERE id = ? AND organization_id = ? AND status = 'pending'`,
    inviteId,
    organizationId,
  );
  if (result.changes === 0) throw notFound('邀请不存在或已被使用');
}

/**
 * 调整成员角色。
 *
 * 唯一不能做的事是把最后一个 owner 降级或移除——否则机构会变成无人可管理的
 * 状态，只能直接改数据库才能救回来。
 */
export function updateMemberRole(organizationId: string, memberId: string, role: MemberRole) {
  if (role === 'owner') {
    throw badRequest('不支持直接把成员设为所有者', 'unsupported_role_change');
  }
  return tx(() => {
    const member = get<MemberRow>(
      'SELECT id, organization_id, user_id, role FROM organization_members WHERE id = ? AND organization_id = ?',
      memberId,
      organizationId,
    );
    if (!member) throw notFound('成员不存在');
    if (member.role === role) return member;

    if (member.role === 'owner' && ownerCount(organizationId) <= 1) {
      throw conflict('该机构至少需要保留一名所有者，无法降级', 'last_owner');
    }
    run('UPDATE organization_members SET role = ? WHERE id = ?', role, memberId);
    return { ...member, role };
  });
}

export function removeMember(organizationId: string, memberId: string, actingUserId: string) {
  return tx(() => {
    const member = get<MemberRow>(
      'SELECT id, organization_id, user_id, role FROM organization_members WHERE id = ? AND organization_id = ?',
      memberId,
      organizationId,
    );
    if (!member) throw notFound('成员不存在');
    if (member.user_id === actingUserId) {
      throw badRequest('不能移除自己，请让其他所有者操作', 'cannot_remove_self');
    }
    if (member.role === 'owner' && ownerCount(organizationId) <= 1) {
      throw conflict('该机构至少需要保留一名所有者，无法移除', 'last_owner');
    }
    run('DELETE FROM organization_members WHERE id = ?', memberId);
    return { removed: memberId };
  });
}
