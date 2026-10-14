import { z } from 'zod';

export const FIELD_TYPES = [
  'text',
  'textarea',
  'phone',
  'number',
  'radio',
  'checkbox',
  'select',
  'date',
] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

/** Field types that need a non-empty option list. */
export const CHOICE_TYPES: FieldType[] = ['radio', 'checkbox', 'select'];

export interface FormField {
  id: string;
  projectId: string | null;
  key: string;
  label: string;
  type: FieldType;
  required: boolean;
  sortOrder: number;
  placeholder: string | null;
  hint: string | null;
  options: string[];
  minLength: number | null;
  maxLength: number | null;
  minValue: number | null;
  maxValue: number | null;
}

export type AnswerValue = string | number | string[] | null;
export type Answers = Record<string, AnswerValue>;

export const fieldInputSchema = z
  .object({
    // The client may supply `key` for an existing field, or omit it and let the
    // server mint a stable one. Keys are never derived from the label.
    key: z.string().trim().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/).optional(),
    label: z.string().trim().min(1).max(60),
    type: z.enum(FIELD_TYPES),
    required: z.boolean().optional().default(false),
    placeholder: z.string().trim().max(120).nullish(),
    hint: z.string().trim().max(200).nullish(),
    options: z.array(z.string().trim().min(1).max(80)).max(50).optional(),
    minLength: z.number().int().min(0).max(5000).nullish(),
    maxLength: z.number().int().min(0).max(5000).nullish(),
    minValue: z.number().nullish(),
    maxValue: z.number().nullish(),
  })
  .superRefine((value, ctx) => {
    if (CHOICE_TYPES.includes(value.type as FieldType)) {
      if (!value.options || value.options.length === 0) {
        ctx.addIssue({ code: 'custom', path: ['options'], message: '选择类字段必须配置选项' });
      } else if (new Set(value.options).size !== value.options.length) {
        ctx.addIssue({ code: 'custom', path: ['options'], message: '选项内容不能重复' });
      }
    } else if (value.options && value.options.length > 0) {
      ctx.addIssue({ code: 'custom', path: ['options'], message: '非选择类字段不能配置选项' });
    }
    if (value.minLength != null && value.maxLength != null && value.minLength > value.maxLength) {
      ctx.addIssue({ code: 'custom', path: ['minLength'], message: '最小长度不能大于最大长度' });
    }
    if (value.minValue != null && value.maxValue != null && value.minValue > value.maxValue) {
      ctx.addIssue({ code: 'custom', path: ['minValue'], message: '最小值不能大于最大值' });
    }
  });

export const formDefinitionSchema = z.object({
  fields: z.array(fieldInputSchema).max(40),
});

export interface FieldErrors {
  [fieldKey: string]: string;
}

export interface ValidationResult {
  ok: boolean;
  values: Answers;
  errors: FieldErrors;
}

const CN_MOBILE = /^1[3-9]\d{9}$/;

function isBlank(value: AnswerValue | undefined): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === 'string') return value.trim() === '';
  if (Array.isArray(value)) return value.length === 0;
  return false;
}

/**
 * Normalizes the raw DB row into the API shape used by the mini program.
 */
export function rowToField(row: Record<string, any>): FormField {
  let options: string[] = [];
  if (row.options) {
    try {
      const parsed = JSON.parse(row.options);
      if (Array.isArray(parsed)) options = parsed.filter((o) => typeof o === 'string');
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
}

/**
 * Server-side answer validation. The mini program runs the same rules for
 * instant feedback, but nothing here trusts the client: this is the copy that
 * decides whether a row is written.
 */
export function validateAnswers(fields: FormField[], raw: unknown): ValidationResult {
  const errors: FieldErrors = {};
  const values: Answers = {};

  if (raw === null || raw === undefined || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, values, errors: { _form: '报名资料格式不正确' } };
  }
  const input = raw as Record<string, unknown>;

  const known = new Set(fields.map((f) => f.key));
  for (const key of Object.keys(input)) {
    if (!known.has(key)) {
      errors[key] = '包含该报名表不存在的字段';
    }
  }

  for (const field of fields) {
    const value = input[field.key];
    if (isBlank(value as AnswerValue)) {
      if (field.required) errors[field.key] = `请填写${field.label}`;
      else values[field.key] = null;
      continue;
    }

    switch (field.type) {
      case 'text':
      case 'textarea': {
        const str = String(value).trim();
        const min = field.minLength ?? 0;
        const max = field.maxLength ?? (field.type === 'textarea' ? 2000 : 100);
        if (str.length < min) errors[field.key] = `${field.label}至少需要 ${min} 个字符`;
        else if (str.length > max) errors[field.key] = `${field.label}不能超过 ${max} 个字符`;
        else values[field.key] = str;
        break;
      }
      case 'phone': {
        const rawStr = String(value).trim();
        const digits = rawStr.replace(/[\s()+-]/g, '').replace(/^0086/, '').replace(/^86(?=\d{11}$)/, '');
        if (!/^\d{6,20}$/.test(digits)) {
          errors[field.key] = '请输入正确的联系电话';
        } else if (digits.length === 11 && !CN_MOBILE.test(digits)) {
          errors[field.key] = '请输入正确的手机号码';
        } else {
          const max = field.maxLength ?? 30;
          if (rawStr.length > max) errors[field.key] = `${field.label}不能超过 ${max} 个字符`;
          else values[field.key] = rawStr;
        }
        break;
      }
      case 'number': {
        const num = typeof value === 'number' ? value : Number(String(value).trim());
        if (!Number.isFinite(num)) {
          errors[field.key] = `${field.label}必须是数字`;
        } else if (field.minValue != null && num < field.minValue) {
          errors[field.key] = `${field.label}不能小于 ${field.minValue}`;
        } else if (field.maxValue != null && num > field.maxValue) {
          errors[field.key] = `${field.label}不能大于 ${field.maxValue}`;
        } else {
          values[field.key] = num;
        }
        break;
      }
      case 'radio':
      case 'select': {
        const str = String(value).trim();
        if (!field.options.includes(str)) errors[field.key] = `${field.label}的选项无效`;
        else values[field.key] = str;
        break;
      }
      case 'checkbox': {
        // A single value is tolerated so simple clients do not fail outright.
        const list = Array.isArray(value) ? value : [value];
        const cleaned = [...new Set(list.map((v) => String(v).trim()))];
        const invalid = cleaned.filter((v) => !field.options.includes(v));
        if (invalid.length > 0) {
          errors[field.key] = `${field.label}包含无效选项：${invalid.join('、')}`;
          break;
        }
        const min = field.minLength ?? 0; // reused as "at least N selected"
        const max = field.maxLength ?? field.options.length; // "at most N selected"
        if (cleaned.length < min) errors[field.key] = `${field.label}至少选择 ${min} 项`;
        else if (cleaned.length > max) errors[field.key] = `${field.label}最多选择 ${max} 项`;
        else values[field.key] = cleaned;
        break;
      }
      case 'date': {
        const str = String(value).trim();
        if (!/^\d{4}-\d{2}-\d{2}$/.test(str) || Number.isNaN(Date.parse(`${str}T00:00:00Z`))) {
          errors[field.key] = `${field.label}请使用 YYYY-MM-DD 格式`;
        } else {
          values[field.key] = str;
        }
        break;
      }
      default:
        errors[field.key] = '不支持的字段类型';
    }
  }

  return { ok: Object.keys(errors).length === 0, values, errors };
}

/** Stable snapshot written to `registrations.form_snapshot`. */
export function snapshotFields(fields: FormField[]): string {
  return JSON.stringify(
    fields.map((f) => ({
      key: f.key,
      label: f.label,
      type: f.type,
      required: f.required,
      options: f.options,
    })),
  );
}

/** Contact details are whatever the institution configured, not hard-coded. */
export function pickContact(fields: FormField[], answers: Answers): {
  contactName: string | null;
  contactPhone: string | null;
} {
  const nameField =
    fields.find((f) => f.type === 'text' && /姓名|name/i.test(f.key)) ??
    fields.find((f) => f.type === 'text' && /姓名|name/i.test(f.label)) ??
    fields.find((f) => f.type === 'text');
  const phoneField = fields.find((f) => f.type === 'phone');
  const name = nameField ? answers[nameField.key] : null;
  const phone = phoneField ? answers[phoneField.key] : null;
  return {
    contactName: typeof name === 'string' && name ? name : null,
    contactPhone: typeof phone === 'string' && phone ? phone : null,
  };
}
