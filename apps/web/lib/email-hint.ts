/** Client-side email hinting shared by the contact and checkout forms. */

export const EMAIL_DOMAINS = ["gmail.com", "icloud.com", "outlook.com", "hotmail.com", "yahoo.com", "proton.me"];

/** Same "is this probably an email" shape as the server's EMAIL_RE. */
export const isProbablyEmail = (v: string) => /^[^\s@]+@(?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,}$/.test(v);

/** Suggest `local@domain` completions while the domain is still being typed. */
export function emailSuggestions(value: string): string[] {
  const [localPart, domainPart = ""] = value.split("@");
  const shouldSuggest =
    value.includes("@") && !!localPart && !value.includes("@@") && !domainPart.includes(".");
  if (!shouldSuggest) return [];
  return EMAIL_DOMAINS.filter((d) => d.startsWith(domainPart.toLowerCase())).map(
    (d) => `${localPart}@${d}`,
  );
}
