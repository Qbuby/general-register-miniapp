export function nowIso(): string {
  return new Date().toISOString();
}

/** Accepts ISO strings and `YYYY-MM-DD` / `YYYY-MM-DD HH:mm` local forms. */
export function toIsoOrNull(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?$/.test(trimmed)) {
    return new Date(trimmed.replace(' ', 'T')).toISOString();
  }
  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString();
}

/** `YYYY-MM-DD` in UTC — the format WeChat date pickers emit. */
export function toDateOnly(iso: string | null): string | null {
  return iso ? iso.slice(0, 10) : null;
}

export function formatDateTime(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
