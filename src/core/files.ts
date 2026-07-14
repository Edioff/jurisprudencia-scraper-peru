/**
 * Small filesystem helpers: safe file names, atomic JSON writes, CSV export.
 */

import * as fs from 'fs';
import * as path from 'path';

/** Strip characters that are illegal on Windows/Unix file systems. */
export function sanitizeFileName(name: string): string {
  return name
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/-{2,}/g, '-')
    .trim()
    .slice(0, 180); // leave headroom for directory prefixes on Windows' 260-char limit
}

export function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

/** Write JSON atomically (tmp + rename) so a crash never corrupts state. */
export function writeJsonAtomic(filePath: string, data: unknown): void {
  ensureDir(path.dirname(filePath));
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8');
  fs.renameSync(tmp, filePath);
}

export function readJsonIfExists<T>(filePath: string): T | null {
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as T;
  } catch {
    return null; // corrupt file: start fresh rather than crash
  }
}

/** Serialize rows to RFC 4180 CSV (quotes, commas and newlines escaped). */
export function toCsv(headers: string[], rows: Array<Record<string, string>>): string {
  const escape = (value: string): string =>
    /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
  const lines = [headers.map(escape).join(',')];
  for (const row of rows) {
    lines.push(headers.map((h) => escape(row[h] ?? '')).join(','));
  }
  return lines.join('\r\n') + '\r\n';
}

/**
 * Parse the file name out of a Content-Disposition header, if present.
 * Handles quoted values (which may legally contain semicolons), single
 * quotes, bare tokens, and RFC 5987 `filename*=UTF-8''...` encoding.
 */
export function fileNameFromDisposition(header: string | undefined): string | null {
  if (!header) return null;
  const match = header.match(/filename\*?=(?:UTF-8'')?(?:"([^"]*)"|'([^']*)'|([^;\s]+))/i);
  if (!match) return null;
  const value = match[1] ?? match[2] ?? match[3];
  return decodeURIComponentSafe(value.trim());
}

function decodeURIComponentSafe(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
