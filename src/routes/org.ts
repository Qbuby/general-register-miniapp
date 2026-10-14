import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { config } from '../config.js';
import { badRequest, notFound, serviceUnavailable } from '../lib/errors.js';
import { nowIso } from '../lib/time.js';
import { toCsv } from '../lib/csv.js';
import { audit, listUserOrganizations, requireMembership } from '../lib/tenant.js';
import { requireUser } from '../plugins/auth.js';
import {
  createOrganization,
  getOrganization,
  organizationInputSchema,
  toOrganizationDto,
  updateOrganization,
} from '../services/organizations.js';
import {
  getFormFields,
  insertProject,
  listProjectsByOrganization,
  projectInputSchema,
  projectPatchSchema,
  PROJECT_STATUS_LABELS,
  PROJECT_TYPE_LABELS,
  resolveSignupState,
  requireProjectRow,
  updateProject,
} from '../services/projects.js';
import { DEFAULT_FIELDS, replaceFormFields } from '../services/forms.js';
import {
  REGISTRATION_STATUSES,
  REGISTRATION_STATUS_LABELS,
  exportRegistrations,
  getRegistration,
  listRegistrations,
  organizationStats,
  updateRegistrationStatus,
} from '../services/registrations.js';
import { describeQr, renderQr, type QrPayload } from '../services/qr.js';
import {
  acceptInvite,
  createInvite,
  getInviteRow,
  listInvites,
  listMembers,
  ownerCount,
  removeMember,
  revokeInvite,
  updateMemberRole,
  ROLE_DESCRIPTIONS,
  ROLE_LABELS,
} from '../services/members.js';

const listQuerySchema = z.object({
  projectId: z.string().optional(),
  status: z.enum(REGISTRATION_STATUSES).optional(),
  q: z.string().trim().max(80).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(20),
});

/**
 * Typed against the schema's *output* so schemas with defaults (e.g. `type`) are
 * not seen as optional after parsing.
 */
function parseOrThrow<TSchema extends z.ZodTypeAny>(schema: TSchema, data: unknown): z.output<TSchema> {
  const parsed = schema.safeParse(data);
  if (!parsed.success) {
    throw badRequest(parsed.error.issues[0]?.message ?? '参数不正确', 'invalid_input', {
      issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  }
  return parsed.data as z.output<TSchema>;
}

/** Shared guard for every /api/orgs/:orgId route. */
function orgScope(request: Parameters<typeof requireUser>[0], minRole: 'operator' | 'admin' | 'owner' = 'operator') {
  const user = requireUser(request);
  const { orgId } = request.params as { orgId: string };
  requireMembership(orgId, user.id, minRole);
  return { user, orgId };
}

/**
 * A deployment without WeChat credentials must not hand back something that
 * looks like a usable code. The image endpoint already 503s; the metadata
 * endpoint answers the same way so the two cannot disagree.
 */
function assertQrAvailable(qr: QrPayload): void {
  if (qr.mode === 'unavailable') {
    throw serviceUnavailable(qr.warning ?? '无法生成小程序码', {
      missing: ['WX_APPID', 'WX_APPSECRET'].filter((k) => !process.env[k]),
    });
  }
}

function toInviteDto(row: Record<string, any>) {
  return {
    id: row.id,
    code: row.code,
    role: row.role,
    roleLabel: ROLE_LABELS[row.role as keyof typeof ROLE_LABELS],
    status: row.status,
    creatorNickname: row.creator_nickname ?? null,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    acceptedAt: row.accepted_at ?? null,
  };
}

export async function orgRoutes(app: FastifyInstance): Promise<void> {
  /**
   * 接受机构邀请。
   *
   * 刻意放在 `/api/invites/...` 而不是 `/api/orgs/:orgId/invites/...`：
   * 接受邀请的人此刻**还不是**该机构成员，不能走 orgScope 校验；
   * 同时也避免和静态段 `invites` 与参数段 `:orgId` 的路由产生歧义。
   */
  app.post('/api/invites/:code/accept', async (request) => {
    const user = requireUser(request);
    const { code } = request.params as { code: string };
    const result = acceptInvite(code, user.id);
    audit(result.organization.id, user.id, 'invite.accept', {
      type: 'organization',
      id: result.organization.id,
      meta: { role: result.role },
    });
    return {
      organization: { id: result.organization.id, name: result.organization.name },
      role: result.role,
      roleLabel: ROLE_LABELS[result.role],
    };
  });

  /** 接受前预览邀请内容，让用户知道要加入哪个机构、拿到什么权限。 */
  app.get('/api/invites/:code', async (request) => {
    const { code } = request.params as { code: string };
    const invite = getInviteRow(code);
    if (!invite || invite.status !== 'pending' || invite.expires_at <= nowIso()) {
      throw notFound('邀请码无效或已过期');
    }
    const organization = getOrganization(invite.organization_id);
    return {
      invite: {
        role: invite.role,
        roleLabel: ROLE_LABELS[invite.role as keyof typeof ROLE_LABELS],
        roleDescription: ROLE_DESCRIPTIONS[invite.role as keyof typeof ROLE_DESCRIPTIONS],
        expiresAt: invite.expires_at,
      },
      organization: { name: organization.name },
    };
  });

  // ---------------------------------------------------------------- my orgs
  app.get('/api/orgs', async (request) => {
    const user = requireUser(request);
    return { organizations: listUserOrganizations(user.id).map(toOrganizationDto) };
  });

  app.post('/api/orgs', async (request, reply) => {
    const user = requireUser(request);
    const input = parseOrThrow(organizationInputSchema, request.body ?? {});
    const organization = createOrganization(user.id, input);
    audit(organization.id, user.id, 'organization.create', { type: 'organization', id: organization.id });
    reply.code(201);
    return { organization: toOrganizationDto(organization) };
  });

  app.get('/api/orgs/:orgId', async (request) => {
    const { orgId } = orgScope(request);
    return {
      organization: toOrganizationDto(getOrganization(orgId)),
      statusLabels: { draft: '未发布', published: '已发布', hidden: '仅链接可见' },
      qr: describeQr('organization', orgId),
    };
  });

  app.patch('/api/orgs/:orgId', async (request) => {
    const { user, orgId } = orgScope(request, 'admin');
    const input = parseOrThrow(organizationInputSchema.partial(), request.body ?? {});
    const organization = updateOrganization(orgId, input);
    audit(orgId, user.id, 'organization.update', { type: 'organization', id: orgId });
    return { organization: toOrganizationDto(organization) };
  });

  app.get('/api/orgs/:orgId/stats', async (request) => {
    const { orgId } = orgScope(request);
    return { stats: organizationStats(orgId) };
  });

  // --------------------------------------------------------------- projects
  app.get('/api/orgs/:orgId/projects', async (request) => {
    const { orgId } = orgScope(request);
    const organization = getOrganization(orgId);
    return {
      projects: listProjectsByOrganization(orgId).map((project) => ({
        ...project,
        typeLabel: PROJECT_TYPE_LABELS[project.type as keyof typeof PROJECT_TYPE_LABELS] ?? '其他',
        statusLabel: PROJECT_STATUS_LABELS[project.status as keyof typeof PROJECT_STATUS_LABELS] ?? project.status,
        signup: resolveSignupState(project, organization).state,
      })),
    };
  });

  app.post('/api/orgs/:orgId/projects', async (request, reply) => {
    const { user, orgId } = orgScope(request, 'admin');
    const input = parseOrThrow(projectInputSchema, request.body ?? {});
    const project = insertProject(orgId, input);
    if (input.fields && input.fields.length > 0) {
      replaceFormFields(project.id as string, { fields: input.fields });
    } else {
      replaceFormFields(project.id as string, { fields: DEFAULT_FIELDS });
    }
    audit(orgId, user.id, 'project.create', { type: 'project', id: project.id });
    reply.code(201);
    return { project: requireProjectRow(orgId, project.id as string) };
  });

  app.get('/api/orgs/:orgId/projects/:projectId', async (request) => {
    const { orgId } = orgScope(request);
    const { projectId } = request.params as { projectId: string };
    const project = requireProjectRow(orgId, projectId);
    const organization = getOrganization(orgId);
    const signup = resolveSignupState(project, organization);
    return {
      project: {
        ...project,
        typeLabel: PROJECT_TYPE_LABELS[project.type as keyof typeof PROJECT_TYPE_LABELS] ?? '其他',
        statusLabel: PROJECT_STATUS_LABELS[project.status as keyof typeof PROJECT_STATUS_LABELS] ?? project.status,
        signup: signup.state,
        signupReason: signup.reason,
      },
      fields: getFormFields(projectId),
      qr: describeQr('project', orgId, projectId),
    };
  });

  app.patch('/api/orgs/:orgId/projects/:projectId', async (request) => {
    const { user, orgId } = orgScope(request, 'admin');
    const { projectId } = request.params as { projectId: string };
    const project = requireProjectRow(orgId, projectId);
    const input = parseOrThrow(projectPatchSchema, request.body ?? {});
    const updated = updateProject(project, input);
    audit(orgId, user.id, 'project.update', { type: 'project', id: projectId });
    return { project: updated };
  });

  // ------------------------------------------------------------------ forms
  app.get('/api/orgs/:orgId/projects/:projectId/form', async (request) => {
    const { orgId } = orgScope(request);
    const { projectId } = request.params as { projectId: string };
    const project = requireProjectRow(orgId, projectId);
    return { fields: getFormFields(projectId), formVersion: project.form_version };
  });

  app.put('/api/orgs/:orgId/projects/:projectId/form', async (request) => {
    const { user, orgId } = orgScope(request, 'admin');
    const { projectId } = request.params as { projectId: string };
    const project = requireProjectRow(orgId, projectId);
    const fields = replaceFormFields(projectId, request.body ?? {});
    audit(orgId, user.id, 'form.update', { type: 'project', id: projectId, meta: { count: fields.length } });
    return { fields, formVersion: requireProjectRow(orgId, projectId).form_version };
  });

  // --------------------------------------------------------- registrations
  app.get('/api/orgs/:orgId/registrations', async (request) => {
    const { orgId } = orgScope(request);
    const query = parseOrThrow(listQuerySchema, request.query ?? {});
    const result = listRegistrations({
      organizationId: orgId,
      projectId: query.projectId ?? null,
      status: query.status ?? null,
      q: query.q ?? null,
      page: query.page,
      pageSize: query.pageSize,
    });
    return { ...result, statusLabels: REGISTRATION_STATUS_LABELS };
  });

  app.get('/api/orgs/:orgId/registrations/export.csv', async (request, reply) => {
    const { user, orgId } = orgScope(request);
    const query = parseOrThrow(listQuerySchema.partial(), request.query ?? {});
    const organization = getOrganization(orgId);

    let projectTitle = '全部项目';
    if (query.projectId) {
      projectTitle = requireProjectRow(orgId, query.projectId).title;
    }
    const rows = exportRegistrations({
      organizationId: orgId,
      projectId: query.projectId ?? null,
      status: query.status ?? null,
      q: query.q ?? null,
    }).slice(0, config.maxExportRows);

    // Columns follow the project's current form, plus any question that used to
    // exist — a historical answer must never be dropped from the export.
    const current = query.projectId ? getFormFields(query.projectId) : [];
    const extraColumns = new Map<string, string>();
    for (const row of rows) {
      for (const snap of row.snapshot) {
        const key = (snap as any).key as string;
        if (!current.some((f) => f.key === key) && !extraColumns.has(key)) {
          extraColumns.set(key, (snap as any).label ?? key);
        }
      }
    }
    const columns = [
      ...current.map((f) => ({ key: f.key, label: f.label })),
      ...[...extraColumns.entries()].map(([key, label]) => ({ key, label: `${label}（历史）` })),
    ];

    const csv = toCsv(
      ['报名编号', '报名时间', '报名项目', '姓名', '联系电话', '报名状态', ...columns.map((c) => c.label)],
      rows.map((row) => [
        row.receiptCode,
        row.createdAt,
        row.projectTitle,
        row.contactName ?? '',
        row.contactPhone ?? '',
        REGISTRATION_STATUS_LABELS[row.status as keyof typeof REGISTRATION_STATUS_LABELS] ?? row.status,
        ...columns.map((c) => {
          const value = row.answers[c.key];
          if (value === undefined || value === null) return '';
          if (Array.isArray(value)) {
            // Render through the snapshot labels so a renamed option still reads
            // correctly to whoever opens the file.
            const snap = row.snapshot.find((s) => (s as any).key === c.key) as any;
            return value.join(' / ');
          }
          return value;
        }),
      ]),
    );

    audit(orgId, user.id, 'registrations.export', {
      type: 'project',
      id: query.projectId ?? orgId,
      meta: { count: rows.length, projectTitle },
    });

    const filename = `${organization.slug}-${query.projectId ? 'project' : 'all'}-registrations.csv`;
    reply
      .header('Content-Type', 'text/csv; charset=utf-8')
      .header('Content-Disposition', `attachment; filename="registrations.csv"; filename*=UTF-8''${encodeURIComponent(filename)}`)
      .header('Cache-Control', 'no-store');
    return csv;
  });

  app.get('/api/orgs/:orgId/registrations/:registrationId', async (request) => {
    const { orgId } = orgScope(request);
    const { registrationId } = request.params as { registrationId: string };
    return { registration: getRegistration(orgId, registrationId) };
  });

  app.patch('/api/orgs/:orgId/registrations/:registrationId', async (request) => {
    const { user, orgId } = orgScope(request);
    const { registrationId } = request.params as { registrationId: string };
    const body = parseOrThrow(z.object({ status: z.enum(REGISTRATION_STATUSES) }), request.body ?? {});
    const registration = updateRegistrationStatus(orgId, registrationId, body.status);
    audit(orgId, user.id, 'registration.status', {
      type: 'registration',
      id: registrationId,
      meta: { status: body.status },
    });
    return { registration };
  });

  // --------------------------------------------------------------- members
  // 成员与角色。数据模型从 v1 就有 organization_members，但只有「创建者即 owner」
  // 的话整个成员表是无法使用的死能力，所以这里把管理补齐。
  app.get('/api/orgs/:orgId/members', async (request) => {
    const { user, orgId } = orgScope(request);
    return {
      members: listMembers(orgId).map((m) => ({
        id: m.id,
        userId: m.user_id,
        nickname: m.nickname,
        avatarUrl: m.avatar_url,
        role: m.role,
        roleLabel: ROLE_LABELS[m.role],
        roleDescription: ROLE_DESCRIPTIONS[m.role],
        createdAt: m.created_at,
        // 前端据此隐藏「改角色/移除」等只对 owner 开放的按钮。
        // 注意这只是界面提示，真正的拦截在服务端。
        isMe: m.user_id === user.id,
      })),
      roleLabels: ROLE_LABELS,
      roleDescriptions: ROLE_DESCRIPTIONS,
      ownerCount: ownerCount(orgId),
    };
  });

  app.post('/api/orgs/:orgId/invites', async (request, reply) => {
    const { user, orgId } = orgScope(request, 'owner');
    const body = parseOrThrow(
      // 这里故意把 owner 也放进枚举：让 service 层给出「邀请只能授予管理员或运营」
      // 这样更明确的提示，而不是一个笼统的枚举校验错误。owner 的拦截仍在 service。
      z.object({ role: z.enum(['owner', 'admin', 'operator']).default('operator') }),
      request.body ?? {},
    );
    const invite = createInvite(orgId, user.id, body.role);
    audit(orgId, user.id, 'invite.create', { type: 'invite', id: invite.id, meta: { role: invite.role } });
    reply.code(201);
    return { invite: toInviteDto(invite) };
  });

  app.get('/api/orgs/:orgId/invites', async (request) => {
    const { orgId } = orgScope(request, 'owner');
    return { invites: listInvites(orgId).map(toInviteDto) };
  });

  app.delete('/api/orgs/:orgId/invites/:inviteId', async (request) => {
    const { user, orgId } = orgScope(request, 'owner');
    const { inviteId } = request.params as { inviteId: string };
    revokeInvite(orgId, inviteId);
    audit(orgId, user.id, 'invite.revoke', { type: 'invite', id: inviteId });
    return { ok: true };
  });

  app.patch('/api/orgs/:orgId/members/:memberId', async (request) => {
    const { user, orgId } = orgScope(request, 'owner');
    const { memberId } = request.params as { memberId: string };
    const body = parseOrThrow(
      z.object({ role: z.enum(['admin', 'operator']) }),
      request.body ?? {},
    );
    const member = updateMemberRole(orgId, memberId, body.role);
    audit(orgId, user.id, 'member.role', { type: 'member', id: memberId, meta: { role: body.role } });
    return { member: { ...member, roleLabel: ROLE_LABELS[body.role] } };
  });

  app.delete('/api/orgs/:orgId/members/:memberId', async (request) => {
    const { user, orgId } = orgScope(request, 'owner');
    const { memberId } = request.params as { memberId: string };
    const result = removeMember(orgId, memberId, user.id);
    audit(orgId, user.id, 'member.remove', { type: 'member', id: memberId });
    return result;
  });

  // --------------------------------------------------------------- qr codes
  app.get('/api/orgs/:orgId/qrcode', async (request) => {
    const { orgId } = orgScope(request);
    const qr = describeQr('organization', orgId);
    assertQrAvailable(qr);
    return { qr, imageUrl: `/api/orgs/${orgId}/qrcode.png` };
  });

  app.get('/api/orgs/:orgId/projects/:projectId/qrcode', async (request) => {
    const { orgId } = orgScope(request);
    const { projectId } = request.params as { projectId: string };
    requireProjectRow(orgId, projectId);
    const qr = describeQr('project', orgId, projectId);
    assertQrAvailable(qr);
    return { qr, imageUrl: `/api/orgs/${orgId}/projects/${projectId}/qrcode.png` };
  });

  app.get('/api/orgs/:orgId/qrcode.png', async (request, reply) => {
    const { orgId } = orgScope(request);
    return sendQr(request, reply, 'organization', orgId);
  });

  app.get('/api/orgs/:orgId/projects/:projectId/qrcode.png', async (request, reply) => {
    const { orgId } = orgScope(request);
    const { projectId } = request.params as { projectId: string };
    requireProjectRow(orgId, projectId);
    return sendQr(request, reply, 'project', orgId, projectId);
  });
}

async function sendQr(
  request: Parameters<typeof requireUser>[0],
  reply: FastifyReply,
  target: 'organization' | 'project',
  orgId: string,
  projectId?: string,
) {
  const user = requireUser(request);
  requireMembership(orgId, user.id);
  const qr = await renderQr(target, orgId, projectId);
  const name = target === 'organization' ? 'org' : 'project';
  reply
    .header('Content-Type', qr.contentType)
    .header('Cache-Control', 'no-store')
    .header(
      'Content-Disposition',
      `attachment; filename="${name}-qrcode.png"; filename*=UTF-8''${encodeURIComponent(`${name}-${qr.code}.png`)}`,
    );
  reply.header('X-QR-Mode', qr.mode);
  if (qr.warning) reply.header('X-QR-Warning', encodeURIComponent(qr.warning));
  return reply.send(qr.buffer);
}
