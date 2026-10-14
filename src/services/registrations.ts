import { all, get, isUniqueViolation, run, tx } from '../db/index.js';
import { conflict, badRequest, notFound } from '../lib/errors.js';
import { newId, newReceiptCode } from '../lib/ids.js';
import { nowIso } from '../lib/time.js';
import {
  pickContact,
  snapshotFields,
  validateAnswers,
  type FormField,
} from '../lib/form.js';
import { resolveSignupState } from './projects.js';
import { resolveTarget } from './share-codes.js';

export const REGISTRATION_STATUSES = ['pending', 'contacted', 'confirmed', 'rejected'] as const;
export type RegistrationStatus = (typeof REGISTRATION_STATUSES)[number];

export const REGISTRATION_STATUS_LABELS: Record<RegistrationStatus, string> = {
  pending: '待处理',
  contacted: '已联系',
  confirmed: '已确认',
  rejected: '已放弃',
};

/** Statuses that hold a seat. Rejecting a registration frees it. */
const OCCUPYING: RegistrationStatus[] = ['pending', 'contacted', 'confirmed'];

export function occupiesSeat(status: string): boolean {
  return OCCUPYING.includes(status as RegistrationStatus);
}

export interface SubmitParams {
  code: string;
  answers: unknown;
  userId: string | null;
  idempotencyKey: string | null;
  submitIp?: string | null;
}

export interface SubmitResult {
  registration: Record<string, any>;
  project: Record<string, any>;
  organization: Record<string, any>;
  duplicated: boolean;
}

/**
 * Creates a registration.
 *
 * The whole decision runs inside a BEGIN IMMEDIATE transaction, so the seat
 * count we compare against cannot change between the check and the insert.
 * (On Postgres this is the same shape as SELECT ... FOR UPDATE on the project
 * row followed by the insert.) A unique index on (project_id, user_id) is the
 * second line of defence for the "one WeChat user, one seat" rule.
 */
export function submitRegistration(params: SubmitParams): SubmitResult {
  const target = resolveTarget(params.code);
  if (!target || !target.project) {
    throw notFound('报名链接无效或已失效，请向机构确认最新二维码');
  }
  const projectId = target.project.id as string;
  const organizationId = target.organization.id as string;

  return tx(() => {
    // Re-read inside the transaction: state is decided against the row we lock,
    // not against anything a caller saw a moment ago.
    const project = get<Record<string, any>>(
      'SELECT * FROM projects WHERE id = ? AND organization_id = ?',
      projectId,
      organizationId,
    );
    if (!project) throw notFound('项目不存在或已删除');

    // Same key from a double-tap or a retry returns the original record instead
    // of writing a second row.
    if (params.idempotencyKey) {
      const existing = get<Record<string, any>>(
        'SELECT * FROM registrations WHERE project_id = ? AND idempotency_key = ?',
        projectId,
        params.idempotencyKey,
      );
      if (existing) {
        return {
          registration: existing,
          project,
          organization: target.organization,
          duplicated: true,
        };
      }
    }

    const signup = resolveSignupState(project, target.organization);
    if (!signup.canSubmit) {
      const codeByState: Record<string, string> = {
        unlisted: 'project_unlisted',
        disabled: 'signup_disabled',
        not_started: 'signup_not_started',
        ended: 'signup_ended',
        full: 'project_full',
        org_hidden: 'org_unpublished',
      };
      throw conflict(signup.reason ?? '当前不可报名', codeByState[signup.state] ?? 'signup_closed');
    }

    const fields: FormField[] = all<Record<string, any>>(
      'SELECT * FROM form_fields WHERE project_id = ? ORDER BY sort_order ASC',
      projectId,
    ).map((row) => {
      let options: string[] = [];
      if (row.options) {
        try {
          const parsed = JSON.parse(row.options);
          if (Array.isArray(parsed)) options = parsed;
        } catch {
          options = [];
        }
      }
      return {
        id: row.id,
        projectId: row.project_id,
        key: row.field_key,
        label: row.label,
        type: row.type,
        required: Boolean(row.required),
        sortOrder: row.sort_order,
        placeholder: row.placeholder ?? null,
        hint: row.hint ?? null,
        options,
        minLength: row.min_length ?? null,
        maxLength: row.max_length ?? null,
        minValue: row.min_value ?? null,
        maxValue: row.max_value ?? null,
      };
    });

    const validation = validateAnswers(fields, params.answers);
    if (!validation.ok) {
      const firstKey = Object.keys(validation.errors)[0];
      const message = (firstKey !== undefined && validation.errors[firstKey]) || '报名资料填写不完整';
      throw badRequest(message, 'invalid_answers', { errors: validation.errors });
    }

    const { contactName, contactPhone } = pickContact(fields, validation.values);
    const id = newId('reg');
    const receiptCode = newReceiptCode();
    const timestamp = nowIso();
    // Anonymous submissions (e.g. an H5 preview) have no stable identity, so the
    // uniqueness slot stays empty and idempotency is the only guard.
    const uniqueSlot = !project.allow_duplicate && params.userId ? params.userId : null;

    try {
      run(
        `INSERT INTO registrations (
            id, organization_id, project_id, user_id, form_version, form_snapshot, answers,
            status, contact_name, contact_phone, receipt_code, idempotency_key, unique_slot,
            created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?)`,
        id,
        organizationId,
        projectId,
        params.userId,
        project.form_version,
        snapshotFields(fields),
        JSON.stringify(validation.values),
        contactName,
        contactPhone,
        receiptCode,
        params.idempotencyKey,
        uniqueSlot,
        timestamp,
        timestamp,
      );
    } catch (error) {
      if (isUniqueViolation(error)) {
        if (params.idempotencyKey) {
          const existing = get<Record<string, any>>(
            'SELECT * FROM registrations WHERE project_id = ? AND idempotency_key = ?',
            projectId,
            params.idempotencyKey,
          );
          if (existing) {
            return { registration: existing, project, organization: target.organization, duplicated: true };
          }
        }
        throw conflict('您已经报名过该项目，请勿重复提交', 'duplicate_registration');
      }
      throw error;
    }

    run(
      `UPDATE projects SET registered_count = registered_count + 1, updated_at = ?
        WHERE id = ?`,
      timestamp,
      projectId,
    );

    const registration = get<Record<string, any>>('SELECT * FROM registrations WHERE id = ?', id)!;
    return { registration, project, organization: target.organization, duplicated: false };
  });
}

/**
 * 转义 LIKE 通配符。
 *
 * 用户在搜索框里输入的 % 和 _ 在 SQL LIKE 里是通配符，不转义的话
 * 搜一个「%」会把该机构的全部报名记录都列出来——既不符合直觉，
 * 也相当于把筛选功能绕过去了。配合 ESCAPE '\' 使用。
 */
function escapeLike(term: string): string {
  return term.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

export interface ListParams {
  organizationId: string;
  projectId?: string | null;
  status?: string | null;
  q?: string | null;
  page: number;
  pageSize: number;
}

export function listRegistrations(params: ListParams) {
  const where: string[] = ['r.organization_id = ?'];
  const args: (string | number)[] = [params.organizationId];
  if (params.projectId) {
    where.push('r.project_id = ?');
    args.push(params.projectId);
  }
  if (params.status) {
    where.push('r.status = ?');
    args.push(params.status);
  }
  if (params.q) {
    where.push(
      `(r.contact_name LIKE ? ESCAPE '\\'
        OR r.contact_phone LIKE ? ESCAPE '\\'
        OR r.answers LIKE ? ESCAPE '\\'
        OR r.id = ?)`,
    );
    const like = `%${escapeLike(params.q)}%`;
    args.push(like, like, like, params.q);
  }
  const whereSql = where.join(' AND ');

  const total =
    get<{ n: number }>(`SELECT COUNT(*) AS n FROM registrations r WHERE ${whereSql}`, ...args)?.n ?? 0;
  const rows = all<Record<string, any>>(
    `SELECT r.*, p.title AS project_title
       FROM registrations r
       JOIN projects p ON p.id = r.project_id
      WHERE ${whereSql}
      ORDER BY r.created_at DESC
      LIMIT ? OFFSET ?`,
    ...args,
    params.pageSize,
    (params.page - 1) * params.pageSize,
  );
  return { total, rows: rows.map(toListItem) };
}

export function exportRegistrations(params: Omit<ListParams, 'page' | 'pageSize'>) {
  return listRegistrations({ ...params, page: 1, pageSize: 100000 }).rows;
}

function toListItem(row: Record<string, any>) {
  let answers: Record<string, unknown> = {};
  let snapshot: any[] = [];
  try {
    answers = JSON.parse(row.answers ?? '{}');
  } catch {
    answers = {};
  }
  try {
    snapshot = JSON.parse(row.form_snapshot ?? '[]');
  } catch {
    snapshot = [];
  }
  return {
    id: row.id,
    receiptCode: row.receipt_code,
    projectId: row.project_id,
    projectTitle: row.project_title ?? null,
    contactName: row.contact_name,
    contactPhone: row.contact_phone,
    status: row.status,
    statusLabel: REGISTRATION_STATUS_LABELS[row.status as RegistrationStatus] ?? row.status,
    createdAt: row.created_at,
    formVersion: row.form_version,
    answers,
    snapshot,
  };
}

export function getRegistration(organizationId: string, registrationId: string) {
  const row = get<Record<string, any>>(
    `SELECT r.*, p.title AS project_title
       FROM registrations r JOIN projects p ON p.id = r.project_id
      WHERE r.id = ? AND r.organization_id = ?`,
    registrationId,
    organizationId,
  );
  if (!row) throw notFound('报名记录不存在或无权访问');
  return toListItem(row);
}

export function updateRegistrationStatus(
  organizationId: string,
  registrationId: string,
  status: RegistrationStatus,
) {
  return tx(() => {
    const row = get<Record<string, any>>(
      'SELECT * FROM registrations WHERE id = ? AND organization_id = ?',
      registrationId,
      organizationId,
    );
    if (!row) throw notFound('报名记录不存在或无权访问');

    const wasOccupying = occupiesSeat(row.status);
    const willOccupy = occupiesSeat(status);
    if (wasOccupying !== willOccupy) {
      const delta = willOccupy ? 1 : -1;
      run(
        `UPDATE projects SET registered_count = MAX(0, registered_count + ?), updated_at = ?
          WHERE id = ?`,
        delta,
        nowIso(),
        row.project_id,
      );
    }
    run('UPDATE registrations SET status = ?, updated_at = ? WHERE id = ?', status, nowIso(), registrationId);
    return getRegistration(organizationId, registrationId);
  });
}

export interface OrganizationStats {
  projectCount: number;
  publishedCount: number;
  registrationCount: number;
  pendingCount: number;
  perProject: {
    projectId: string;
    title: string;
    status: string;
    capacity: number | null;
    registeredCount: number;
    pendingCount: number;
    confirmedCount: number;
  }[];
}

export function organizationStats(organizationId: string): OrganizationStats {
  const projects = all<Record<string, any>>(
    `SELECT p.id, p.title, p.status, p.capacity, p.registered_count,
            (SELECT COUNT(*) FROM registrations r WHERE r.project_id = p.id AND r.status = 'pending') AS pending_count,
            (SELECT COUNT(*) FROM registrations r WHERE r.project_id = p.id AND r.status = 'confirmed') AS confirmed_count
       FROM projects p WHERE p.organization_id = ?
      ORDER BY p.sort_order ASC, p.created_at DESC`,
    organizationId,
  );
  const registrationCount =
    get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM registrations WHERE organization_id = ? AND status != 'rejected'`,
      organizationId,
    )?.n ?? 0;
  const pendingCount =
    get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM registrations WHERE organization_id = ? AND status = 'pending'`,
      organizationId,
    )?.n ?? 0;
  return {
    projectCount: projects.length,
    publishedCount: projects.filter((p) => p.status === 'published').length,
    registrationCount,
    pendingCount,
    perProject: projects.map((p) => ({
      projectId: p.id,
      title: p.title,
      status: p.status,
      capacity: p.capacity,
      registeredCount: p.registered_count,
      pendingCount: p.pending_count,
      confirmedCount: p.confirmed_count,
    })),
  };
}
