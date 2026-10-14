import { z } from 'zod';
import { get, run, tx, all } from '../db/index.js';
import { newId, newShareCode, slugify } from '../lib/ids.js';
import { nowIso } from '../lib/time.js';
import { notFound } from '../lib/errors.js';
import { findMembership } from '../lib/tenant.js';

export const ORG_STATUSES = ['draft', 'published', 'hidden'] as const;
export type OrgStatus = (typeof ORG_STATUSES)[number];

export const ORG_STATUS_LABELS: Record<OrgStatus, string> = {
  draft: '未发布',
  published: '已发布',
  hidden: '仅链接可见',
};

export const organizationInputSchema = z.object({
  name: z.string().trim().min(2, '机构名称至少 2 个字').max(60),
  logoUrl: z.string().trim().max(500).nullish(),
  coverUrl: z.string().trim().max(500).nullish(),
  intro: z.string().trim().max(2000).nullish(),
  contactName: z.string().trim().max(40).nullish(),
  contactPhone: z.string().trim().max(40).nullish(),
  wechatId: z.string().trim().max(60).nullish(),
  address: z.string().trim().max(200).nullish(),
  status: z.enum(ORG_STATUSES).optional(),
});

export type OrganizationInput = z.infer<typeof organizationInputSchema>;

function uniqueSlug(name: string): string {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const slug = `${slugify(name)}-${newShareCode(5)}`;
    const clash = get('SELECT id FROM organizations WHERE slug = ?', slug);
    if (!clash) return slug;
  }
  return `${slugify(name)}-${newShareCode(10)}`;
}

/**
 * Creates an institution together with its first member.
 *
 * There is no global administrator account in this system: every capability
 * hangs off an organization_members row, so the first version already has the
 * right shape for multiple staff later.
 */
export function createOrganization(userId: string, input: OrganizationInput) {
  const id = newId('org');
  return tx(() => {
    const now = nowIso();
    run(
      `INSERT INTO organizations (
          id, name, slug, logo_url, cover_url, intro, contact_name, contact_phone,
          wechat_id, address, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      input.name,
      uniqueSlug(input.name),
      input.logoUrl ?? null,
      input.coverUrl ?? null,
      input.intro ?? '',
      input.contactName ?? null,
      input.contactPhone ?? null,
      input.wechatId ?? null,
      input.address ?? null,
      input.status ?? 'draft',
      now,
      now,
    );
    run(
      `INSERT INTO organization_members (id, organization_id, user_id, role, created_at)
       VALUES (?, ?, ?, 'owner', ?)`,
      newId('mem'),
      id,
      userId,
      now,
    );
    return getOrganization(id)!;
  });
}

export function updateOrganization(organizationId: string, input: Partial<OrganizationInput>) {
  const sets: string[] = [];
  const params: (string | null)[] = [];
  const put = (column: string, value: string | null) => {
    sets.push(`${column} = ?`);
    params.push(value);
  };
  if (input.name !== undefined) put('name', input.name);
  if (input.logoUrl !== undefined) put('logo_url', input.logoUrl ?? null);
  if (input.coverUrl !== undefined) put('cover_url', input.coverUrl ?? null);
  if (input.intro !== undefined) put('intro', input.intro ?? '');
  if (input.contactName !== undefined) put('contact_name', input.contactName ?? null);
  if (input.contactPhone !== undefined) put('contact_phone', input.contactPhone ?? null);
  if (input.wechatId !== undefined) put('wechat_id', input.wechatId ?? null);
  if (input.address !== undefined) put('address', input.address ?? null);
  if (input.status !== undefined) put('status', input.status);
  if (sets.length === 0) return getOrganization(organizationId)!;
  put('updated_at', nowIso());
  run(`UPDATE organizations SET ${sets.join(', ')} WHERE id = ?`, ...params, organizationId);
  return getOrganization(organizationId)!;
}

export function getOrganization(organizationId: string) {
  const row = get<Record<string, any>>('SELECT * FROM organizations WHERE id = ?', organizationId);
  if (!row) throw notFound('机构不存在或无权访问');
  return row;
}

export interface OrganizationDto {
  id: string;
  name: string;
  slug: string;
  logoUrl: string | null;
  coverUrl: string | null;
  intro: string;
  contactName: string | null;
  contactPhone: string | null;
  wechatId: string | null;
  address: string | null;
  status: OrgStatus;
  createdAt: string;
  role?: string;
}

export function toOrganizationDto(row: Record<string, any>): OrganizationDto {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    logoUrl: row.logo_url,
    coverUrl: row.cover_url,
    intro: row.intro,
    contactName: row.contact_name,
    contactPhone: row.contact_phone,
    wechatId: row.wechat_id,
    address: row.address,
    status: row.status,
    createdAt: row.created_at,
    ...(row.member_role ? { role: row.member_role } : {}),
  };
}

/** Public view: hides internal ids other than the ones needed for contact. */
export function toPublicOrganization(row: Record<string, any>) {
  return {
    name: row.name,
    logoUrl: row.logo_url,
    coverUrl: row.cover_url,
    intro: row.intro,
    contactName: row.contact_name,
    contactPhone: row.contact_phone,
    wechatId: row.wechat_id,
    address: row.address,
    status: row.status,
  };
}

export function memberCount(organizationId: string): number {
  return (
    all<{ n: number }>(
      'SELECT COUNT(*) AS n FROM organization_members WHERE organization_id = ?',
      organizationId,
    )[0]?.n ?? 0
  );
}

export { findMembership };
