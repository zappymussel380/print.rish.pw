/** Encode one CSV cell, defusing spreadsheet formula injection.
 *
 *  Customer-controlled strings (name, city, notes…) end up in a CSV that an
 *  admin opens in Excel/Sheets, which execute cells starting with = + - @ (even
 *  behind leading whitespace) as formulas. Any such string — or one starting
 *  with a tab/CR/LF, which some importers also treat specially — is prefixed
 *  with a single quote so the spreadsheet reads it as text. Numbers pass
 *  through untouched; normal CSV quote-escaping still applies. */
export function csvCell(value: string | number): string {
  let s = String(value);
  if (typeof value === "string" && /^\s*[=+\-@\t\r\n]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
