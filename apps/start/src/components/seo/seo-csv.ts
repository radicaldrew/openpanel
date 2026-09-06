import { downloadCSV } from '@/utils/csv-download';

export type CsvCell = string | number | boolean | null | undefined;

/**
 * One CSV writer for every SEO export (keywords, rankings, backlinks, …).
 * RFC 4180 quoting: a cell is quoted when it contains a comma, quote,
 * newline or carriage return; quotes are doubled. Booleans become
 * "true"/"false", null and undefined become empty cells.
 */
export function escapeCsvCell(value: CsvCell): string {
  if (value === null || value === undefined) {
    return '';
  }
  const text = String(value);
  if (/[",\n\r]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

/** Header row plus one row per entry; arrays inside a cell join with " | ". */
export function buildCsv(header: string[], rows: CsvCell[][]): string {
  return [header, ...rows].map((row) => row.map(escapeCsvCell).join(',')).join('\n');
}

export function joinCsvList(values: readonly string[]): string {
  return values.join(' | ');
}

/** `seo-<name>.csv`, with the name reduced to a safe slug. */
export function seoCsvFilename(name: string, prefix = 'seo'): string {
  const slug =
    name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'export';
  return `${prefix}-${slug}.csv`;
}

export function downloadSeoCsv(
  header: string[],
  rows: CsvCell[][],
  name: string,
  prefix = 'seo'
): void {
  downloadCSV(buildCsv(header, rows), seoCsvFilename(name, prefix));
}
