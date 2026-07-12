/** RFC 4180 CSV cell escaping — quote when the value contains a comma, quote,
 *  CR, or LF; double embedded quotes. Isomorphic (no Node APIs). */
export function csvCell(value: string | number | boolean | null | undefined): string {
  if (value == null) return "";
  const s = String(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function csvRow(cells: Array<string | number | boolean | null | undefined>): string {
  return cells.map(csvCell).join(",");
}
