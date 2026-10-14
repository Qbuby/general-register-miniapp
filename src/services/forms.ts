import { all, run, tx } from '../db/index.js';
import { newId, newShareCode } from '../lib/ids.js';
import { nowIso } from '../lib/time.js';
import { badRequest } from '../lib/errors.js';
import type { FormField } from '../lib/form.js';
import { getFormFields } from './projects.js';
import { formDefinitionSchema } from '../lib/form.js';

export interface FieldInput {
  key?: string;
  label: string;
  type: string;
  required: boolean;
  placeholder?: string | null;
  hint?: string | null;
  options?: string[];
  minLength?: number | null;
  maxLength?: number | null;
  minValue?: number | null;
  maxValue?: number | null;
}

function mintFieldKey(used: Set<string>): string {
  let key = `fld_${newShareCode(8)}`;
  while (used.has(key)) key = `fld_${newShareCode(8)}`;
  return key;
}

/**
 * Replaces a project's form definition wholesale.
 *
 * Identity lives in `field_key`, never in the label and never in the row id.
 * The client may keep sending the keys it already knows, so reordering or
 * renaming a question keeps every historical answer attached to the right
 * question; fields the client drops are removed from *future* forms only,
 * because each registration carries its own snapshot.
 *
 * Runs in one transaction together with the form_version bump so a concurrent
 * public read can never observe fields and version disagreeing.
 */
export function replaceFormFields(projectId: string, input: unknown): FormField[] {
  const parsed = formDefinitionSchema.safeParse(input);
  if (!parsed.success) {
    throw badRequest(parsed.error.issues[0]?.message ?? '报名表配置不正确', 'invalid_form', {
      issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  }
  const fields = parsed.data.fields;

  return tx(() => {
    const existing = all<Record<string, any>>(
      'SELECT field_key FROM form_fields WHERE project_id = ?',
      projectId,
    );
    const known = new Set(existing.map((r) => r.field_key as string));
    const used = new Set<string>();

    run('DELETE FROM form_fields WHERE project_id = ?', projectId);

    fields.forEach((field, index) => {
      const key = field.key && known.has(field.key) ? field.key : field.key ?? mintFieldKey(used);
      if (used.has(key)) {
        throw badRequest(`字段标识重复：${key}`, 'duplicate_field_key');
      }
      used.add(key);
      run(
        `INSERT INTO form_fields (
            id, project_id, field_key, label, type, required, sort_order, placeholder, hint,
            options, min_length, max_length, min_value, max_value, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        newId('fld'),
        projectId,
        key,
        field.label,
        field.type,
        field.required ? 1 : 0,
        index,
        field.placeholder ?? null,
        field.hint ?? null,
        field.options && field.options.length > 0 ? JSON.stringify(field.options) : null,
        field.minLength ?? null,
        field.maxLength ?? null,
        field.minValue ?? null,
        field.maxValue ?? null,
        nowIso(),
      );
    });

    run(
      'UPDATE projects SET form_version = form_version + 1, updated_at = ? WHERE id = ?',
      nowIso(),
      projectId,
    );
    return getFormFields(projectId);
  });
}

/** A ready-to-use starter form so a brand-new project is not a dead end. */
export const DEFAULT_FIELDS: FieldInput[] = [
  { label: '姓名', type: 'text', required: true, key: 'name', maxLength: 30 },
  { label: '手机号', type: 'phone', required: true, key: 'phone' },
  { label: '备注', type: 'textarea', required: false, key: 'remark', maxLength: 500 },
];
