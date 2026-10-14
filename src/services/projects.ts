import { z } from 'zod';
import { all, get, run } from '../db/index.js';
import { fieldInputSchema, rowToField, type FormField } from '../lib/form.js';
import { newId } from '../lib/ids.js';
import { toIsoOrNull } from '../lib/time.js';
import { notFound } from '../lib/errors.js';

export const PROJECT_TYPES = [
  'course',
  'camp',
  'study_tour',
  'competition',
  'vocational',
  'other',
] as const;
export type ProjectType = (typeof PROJECT_TYPES)[number];

export const PROJECT_TYPE_LABELS: Record<ProjectType, string> = {
  course: '课程培训',
  camp: '训练营/夏令营',
  study_tour: '研学/旅行',
  competition: '比赛/活动',
  vocational: '职业培训',
  other: '其他',
};

export const PROJECT_STATUSES = ['draft', 'published', 'unlisted'] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

export const PROJECT_STATUS_LABELS: Record<ProjectStatus, string> = {
  draft: '草稿',
  published: '已发布',
  unlisted: '已下架',
};

const dateish = z.string().trim().max(40).nullish();

const projectBaseShape = {
  title: z.string().trim().min(1, '请填写项目名称').max(80),
  type: z.enum(PROJECT_TYPES).default('other'),
  coverUrl: z.string().trim().max(500).nullish(),
  summary: z.string().trim().max(200).nullish(),
  description: z.string().max(20000).nullish(),
  location: z.string().trim().max(200).nullish(),
  startAt: dateish,
  endAt: dateish,
  signupStartAt: dateish,
  signupEndAt: dateish,
  capacity: z.number().int().positive().max(1000000).nullish(),
  status: z.enum(PROJECT_STATUSES).optional(),
  signupEnabled: z.boolean().optional(),
  allowDuplicate: z.boolean().optional(),
  sortOrder: z.number().int().min(-9999).max(9999).optional(),
  /** Initial registration form; only honoured when creating a project. */
  fields: z.array(fieldInputSchema).max(40).optional(),
} as const;

/** Cross-field date rules, shared by the create and patch schemas. */
function refineDates(
  value: { startAt?: unknown; endAt?: unknown; signupStartAt?: unknown; signupEndAt?: unknown },
  ctx: z.RefinementCtx,
): void {
  const start = toIsoOrNull(value.startAt);
  const end = toIsoOrNull(value.endAt);
  if (start && end && end < start) {
    ctx.addIssue({ code: 'custom', path: ['endAt'], message: '结束时间不能早于开始时间' });
  }
  const sStart = toIsoOrNull(value.signupStartAt);
  const sEnd = toIsoOrNull(value.signupEndAt);
  if (sStart && sEnd && sEnd < sStart) {
    ctx.addIssue({ code: 'custom', path: ['signupEndAt'], message: '报名截止时间不能早于报名开始时间' });
  }
}

export const projectInputSchema = z.object(projectBaseShape).superRefine(refineDates);

/** Updates accept a subset of the same fields. */
export const projectPatchSchema = z
  .object(projectBaseShape)
  .partial()
  .superRefine(refineDates);

export type ProjectInput = z.infer<typeof projectInputSchema>;

export interface SignupState {
  state: 'open' | 'not_started' | 'ended' | 'disabled' | 'full' | 'unlisted' | 'org_hidden';
  reason: string | null;
  canSubmit: boolean;
}

/**
 * Resolves whether a project currently accepts registrations.
 *
 * Evaluated fresh on every request — including when a QR code is scanned — so a
 * poster printed before the deadline still lands the visitor on a page that
 * explains the project is closed, instead of a form that silently fails.
 */
export function resolveSignupState(
  project: Record<string, any>,
  organization: Record<string, any> | null = null,
  now: Date = new Date(),
): SignupState {
  const orgStatus = organization?.status;
  if (orgStatus === 'draft') {
    return { state: 'org_hidden', reason: '该机构主页尚未发布', canSubmit: false };
  }
  if (project.status === 'draft') {
    return { state: 'unlisted', reason: '该项目尚未发布', canSubmit: false };
  }
  if (project.status === 'unlisted') {
    return { state: 'unlisted', reason: '该项目已下架', canSubmit: false };
  }
  if (!project.signup_enabled) {
    return { state: 'disabled', reason: '机构已暂停该项目报名', canSubmit: false };
  }
  const nowIso = now.toISOString();
  if (project.signup_start_at && project.signup_start_at > nowIso) {
    return { state: 'not_started', reason: '报名尚未开始', canSubmit: false };
  }
  if (project.signup_end_at && project.signup_end_at <= nowIso) {
    return { state: 'ended', reason: '报名已截止', canSubmit: false };
  }
  if (project.capacity != null && project.registered_count >= project.capacity) {
    return { state: 'full', reason: '报名人数已满', canSubmit: false };
  }
  return { state: 'open', reason: null, canSubmit: true };
}

export function getFormFields(projectId: string): FormField[] {
  return all<Record<string, any>>(
    'SELECT * FROM form_fields WHERE project_id = ? ORDER BY sort_order ASC',
    projectId,
  ).map(rowToField);
}

export function listProjectsByOrganization(organizationId: string) {
  return all<Record<string, any>>(
    `SELECT * FROM projects WHERE organization_id = ?
      ORDER BY sort_order ASC, created_at DESC`,
    organizationId,
  );
}

/** Only published projects are ever visible on a public institution home. */
export function listPublishedProjects(organizationId: string) {
  return all<Record<string, any>>(
    `SELECT * FROM projects
      WHERE organization_id = ? AND status = 'published'
      ORDER BY sort_order ASC, created_at DESC`,
    organizationId,
  );
}

export function projectById(projectId: string) {
  return get<Record<string, any>>('SELECT * FROM projects WHERE id = ?', projectId);
}

export function insertProject(organizationId: string, input: ProjectInput): Record<string, any> {
  const id = newId('prj');
  run(
    `INSERT INTO projects (
        id, organization_id, title, type, cover_url, summary, description, location,
        start_at, end_at, signup_start_at, signup_end_at, capacity, status,
        signup_enabled, allow_duplicate, sort_order, form_version, registered_count,
        created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0, ?, ?)`,
    id,
    organizationId,
    input.title,
    input.type,
    input.coverUrl ?? null,
    input.summary ?? '',
    input.description ?? '',
    input.location ?? null,
    toIsoOrNull(input.startAt),
    toIsoOrNull(input.endAt),
    toIsoOrNull(input.signupStartAt),
    toIsoOrNull(input.signupEndAt),
    input.capacity ?? null,
    input.status ?? 'draft',
    input.signupEnabled === false ? 0 : 1,
    input.allowDuplicate ? 1 : 0,
    input.sortOrder ?? 0,
    new Date().toISOString(),
    new Date().toISOString(),
  );
  return projectById(id)!;
}

export function updateProject(project: Record<string, any>, input: Partial<ProjectInput>) {
  const sets: string[] = [];
  const params: (string | number | null)[] = [];
  const put = (column: string, value: string | number | null) => {
    sets.push(`${column} = ?`);
    params.push(value);
  };

  if (input.title !== undefined) put('title', input.title);
  if (input.type !== undefined) put('type', input.type);
  if (input.coverUrl !== undefined) put('cover_url', input.coverUrl ?? null);
  if (input.summary !== undefined) put('summary', input.summary ?? '');
  if (input.description !== undefined) put('description', input.description ?? '');
  if (input.location !== undefined) put('location', input.location ?? null);
  if (input.startAt !== undefined) put('start_at', toIsoOrNull(input.startAt));
  if (input.endAt !== undefined) put('end_at', toIsoOrNull(input.endAt));
  if (input.signupStartAt !== undefined) put('signup_start_at', toIsoOrNull(input.signupStartAt));
  if (input.signupEndAt !== undefined) put('signup_end_at', toIsoOrNull(input.signupEndAt));
  if (input.capacity !== undefined) put('capacity', input.capacity ?? null);
  if (input.status !== undefined) put('status', input.status);
  if (input.signupEnabled !== undefined) put('signup_enabled', input.signupEnabled ? 1 : 0);
  if (input.allowDuplicate !== undefined) put('allow_duplicate', input.allowDuplicate ? 1 : 0);
  if (input.sortOrder !== undefined) put('sort_order', input.sortOrder);

  if (sets.length === 0) return project;
  put('updated_at', new Date().toISOString());
  run(`UPDATE projects SET ${sets.join(', ')} WHERE id = ?`, ...params, project.id);
  return projectById(project.id)!;
}

/** Public DTO — never exposes internal counters the client has no use for. */
export function toPublicProject(project: Record<string, any>, signup: SignupState) {
  return {
    id: project.id,
    organizationId: project.organization_id,
    title: project.title,
    type: project.type,
    typeLabel: PROJECT_TYPE_LABELS[project.type as ProjectType] ?? '其他',
    coverUrl: project.cover_url,
    summary: project.summary,
    description: project.description,
    location: project.location,
    startAt: project.start_at,
    endAt: project.end_at,
    signupStartAt: project.signup_start_at,
    signupEndAt: project.signup_end_at,
    capacity: project.capacity,
    remaining: project.capacity == null ? null : Math.max(0, project.capacity - project.registered_count),
    registeredCount: project.registered_count,
    signupEnabled: Boolean(project.signup_enabled),
    allowDuplicate: Boolean(project.allow_duplicate),
    sortOrder: project.sort_order,
    status: project.status,
    signup: signup.state,
    signupReason: signup.reason,
    canSubmit: signup.canSubmit,
  };
}

export function requireProjectRow(organizationId: string, projectId: string) {
  const row = get<Record<string, any>>(
    'SELECT * FROM projects WHERE id = ? AND organization_id = ?',
    projectId,
    organizationId,
  );
  if (!row) throw notFound('项目不存在或无权访问');
  return row;
}
