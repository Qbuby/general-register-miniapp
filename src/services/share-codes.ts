import { all, get, run } from '../db/index.js';
import { newId, newShareCode } from '../lib/ids.js';
import { nowIso } from '../lib/time.js';

export interface ShareCodeRow {
  code: string;
  kind: 'organization' | 'project';
  organization_id: string;
  project_id: string | null;
}

function insertCode(kind: 'organization' | 'project', organizationId: string, projectId: string | null) {
  // Retry on the astronomically unlikely code collision.
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const code = newShareCode(12);
    try {
      run(
        `INSERT INTO share_codes (code, kind, organization_id, project_id, created_at)
         VALUES (?, ?, ?, ?, ?)`,
        code,
        kind,
        organizationId,
        projectId,
        nowIso(),
      );
      return code;
    } catch (error) {
      if (!(error as Error).message.includes('UNIQUE constraint failed: share_codes.code')) throw error;
    }
  }
  throw new Error('无法生成分享码，请重试');
}

/**
 * Codes are created once and never rotated. That is the whole point: a QR code
 * printed on a poster in March must still resolve in September, so "refresh"
 * means "re-issue an image for the same code", never "mint a new code".
 */
export function getOrCreateOrgCode(organizationId: string): ShareCodeRow {
  const existing = get<ShareCodeRow>(
    `SELECT * FROM share_codes WHERE kind = 'organization' AND organization_id = ?`,
    organizationId,
  );
  if (existing) return existing;
  const code = insertCode('organization', organizationId, null);
  return get<ShareCodeRow>('SELECT * FROM share_codes WHERE code = ?', code)!;
}

export function getOrCreateProjectCode(projectId: string, organizationId: string): ShareCodeRow {
  const existing = get<ShareCodeRow>(
    `SELECT * FROM share_codes WHERE kind = 'project' AND project_id = ?`,
    projectId,
  );
  if (existing) return existing;
  const code = insertCode('project', organizationId, projectId);
  return get<ShareCodeRow>('SELECT * FROM share_codes WHERE code = ?', code)!;
}

export interface ResolvedTarget {
  organization: Record<string, any>;
  project: Record<string, any> | null;
  code: string;
}

/**
 * Public lookup by code. The code is an opaque lookup key only — it carries no
 * authority. Nothing here grants access to the organization workbench.
 */
export function resolveTarget(code: string): ResolvedTarget | null {
  const row = get<ShareCodeRow>('SELECT * FROM share_codes WHERE code = ?', (code || '').trim());
  if (!row) return null;
  const organization = get<Record<string, any>>(
    'SELECT * FROM organizations WHERE id = ?',
    row.organization_id,
  );
  if (!organization) return null;
  if (row.kind === 'project') {
    const project = get<Record<string, any>>(
      'SELECT * FROM projects WHERE id = ? AND organization_id = ?',
      row.project_id,
      row.organization_id,
    );
    return { organization, project: project ?? null, code: row.code };
  }
  return { organization, project: null, code: row.code };
}

export function listOrgCodes(organizationId: string) {
  return all<ShareCodeRow>(
    `SELECT * FROM share_codes WHERE organization_id = ? ORDER BY kind, created_at`,
    organizationId,
  );
}

/**
 * Read-only lookups. Public pages use these so that merely *viewing* an
 * institution home never mints codes; codes are created when the institution
 * asks for its first QR image.
 */
export function findOrgCode(organizationId: string): ShareCodeRow | undefined {
  return get<ShareCodeRow>(
    `SELECT * FROM share_codes WHERE kind = 'organization' AND organization_id = ?`,
    organizationId,
  );
}

export function findProjectCodes(projectIds: string[]): Map<string, string> {
  if (projectIds.length === 0) return new Map();
  const placeholders = projectIds.map(() => '?').join(',');
  const rows = all<ShareCodeRow>(
    `SELECT * FROM share_codes WHERE kind = 'project' AND project_id IN (${placeholders})`,
    ...projectIds,
  );
  return new Map(rows.map((r) => [r.project_id as string, r.code]));
}
