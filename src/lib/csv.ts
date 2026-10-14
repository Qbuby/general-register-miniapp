/**
 * CSV writer tuned for "opens correctly in Excel".
 *  - UTF-8 BOM, otherwise Excel on Windows renders Chinese as mojibake.
 *  - Cells starting with = + - @ are prefixed with a quote so a crafted answer
 *    cannot turn the export into a formula injection vector.
 */
export function csvEscape(value: unknown): string {
  if (value === null || value === undefined) return '';
  let str = Array.isArray(value) ? value.join(' / ') : String(value);
  if (/^[=+\-@\t\r]/.test(str)) str = `'${str}`;
  if (/[",\n\r]/.test(str)) str = `"${str.replace(/"/g, '""')}"`;
  return str;
}

export function toCsv(headers: string[], rows: unknown[][]): string {
  const lines = [headers.map(csvEscape).join(',')];
  for (const row of rows) lines.push(row.map(csvEscape).join(','));
  return `﻿${lines.join('\r\n')}\r\n`;
}
