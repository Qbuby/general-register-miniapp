import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { config } from '../config.js';
import { notFound, badRequest } from '../lib/errors.js';
import { resolveTarget, getOrCreateProjectCode } from '../services/share-codes.js';
import {
  getFormFields,
  listPublishedProjects,
  resolveSignupState,
  toPublicProject,
} from '../services/projects.js';
import { submitRegistration } from '../services/registrations.js';
import { toPublicOrganization } from '../services/organizations.js';
import { get } from '../db/index.js';

const registrationBodySchema = z.object({
  answers: z.record(z.any()),
  // Client-generated per submission attempt. A double-tap replays the same key
  // and the server returns the original receipt instead of a second row.
  idempotencyKey: z.string().trim().min(8).max(80).optional(),
});

export async function publicRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Institution home, reached by scanning the institution QR or tapping a
   * shared page path. `code` is a public lookup key only.
   */
  app.get('/api/public/organizations/:code', async (request) => {
    const { code } = request.params as { code: string };
    const target = resolveTarget(code);
    if (!target || target.project) throw notFound('链接无效或已失效');
    const organization = target.organization;
    if (organization.status === 'draft') {
      throw notFound('该机构主页尚未发布');
    }
    // Each card carries the project's own share code, so tapping it opens the
    // detail page directly instead of making the visitor search the home page.
    // Codes are created lazily and are stable once minted.
    const projects = listPublishedProjects(organization.id as string).map((project) => ({
      ...toPublicProject(project, resolveSignupState(project, organization)),
      shareCode: getOrCreateProjectCode(project.id as string, organization.id as string).code,
    }));
    return {
      code: target.code,
      organization: toPublicOrganization(organization),
      projects,
    };
  });

  /** Project detail. Works for unlisted/closed projects so the visitor sees why. */
  app.get('/api/public/projects/:code', async (request) => {
    const { code } = request.params as { code: string };
    const target = resolveTarget(code);
    if (!target || !target.project) throw notFound('链接无效或已失效');
    if (target.organization.status === 'draft') throw notFound('该机构主页尚未发布');

    const project = target.project;
    const signup = resolveSignupState(project, target.organization);
    return {
      code: target.code,
      organization: toPublicOrganization(target.organization),
      project: toPublicProject(project, signup),
      // The form is returned even when signups are closed: it lets the page show
      // what the applicant would have had to fill in, and the state reason is
      // shown above it.
      fields: getFormFields(project.id as string),
    };
  });

  /** Submit a registration. Every rule is re-checked here, not just on the page. */
  app.post('/api/public/projects/:code/registrations', async (request, reply) => {
    const { code } = request.params as { code: string };
    const body = registrationBodySchema.safeParse(request.body ?? {});
    if (!body.success) throw badRequest(body.error.issues[0]?.message ?? '提交内容不正确');

    const payloadSize = JSON.stringify(body.data.answers ?? {}).length;
    if (payloadSize > config.maxAnswerBytes) throw badRequest('报名资料内容过大');

    const result = submitRegistration({
      code,
      answers: body.data.answers,
      userId: request.user?.id ?? null,
      idempotencyKey: body.data.idempotencyKey ?? null,
      submitIp: request.ip,
    });

    reply.code(result.duplicated ? 200 : 201);
    return {
      receipt: {
        id: result.registration.id,
        receiptCode: result.registration.receipt_code,
        createdAt: result.registration.created_at,
        status: result.registration.status,
        contactName: result.registration.contact_name,
        submitted: !result.duplicated,
      },
      project: {
        id: result.project.id,
        title: result.project.title,
      },
      organization: {
        name: result.organization.name,
        contactName: result.organization.contact_name,
        contactPhone: result.organization.contact_phone,
        wechatId: result.organization.wechat_id,
        address: result.organization.address,
      },
    };
  });

  /**
   * Receipt lookup for the success screen. Only the institution's own contact
   * details come back — never the submitted answers.
   */
  app.get('/api/public/receipts/:receiptCode', async (request) => {
    const { receiptCode } = request.params as { receiptCode: string };
    const row = get<Record<string, any>>(
      `SELECT r.id, r.receipt_code, r.status, r.created_at, r.contact_name,
              p.title AS project_title, o.name AS organization_name,
              o.contact_name AS org_contact_name, o.contact_phone AS org_contact_phone,
              o.wechat_id AS org_wechat_id
         FROM registrations r
         JOIN projects p ON p.id = r.project_id
         JOIN organizations o ON o.id = r.organization_id
        WHERE r.receipt_code = ?`,
      receiptCode.toUpperCase(),
    );
    if (!row) throw notFound('未找到该报名记录');
    return {
      receipt: {
        receiptCode: row.receipt_code,
        status: row.status,
        createdAt: row.created_at,
        projectTitle: row.project_title,
        organizationName: row.organization_name,
        contactName: row.contact_name,
      },
      contact: {
        name: row.org_contact_name,
        phone: row.org_contact_phone,
        wechatId: row.org_wechat_id,
      },
    };
  });
}
