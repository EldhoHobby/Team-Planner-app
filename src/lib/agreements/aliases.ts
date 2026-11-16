// "Also known as" names of an agreement customer (SaCustomer.aliases) — pure, client-safe.
// Stored as one string, names joined by "; ", searched together with the customer name.

/** The separate names in an aliases string (trimmed, blanks dropped, duplicates removed ignoring case). */
export function aliasList(raw: string | null | undefined): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const part of (raw ?? "").split(";")) {
    const name = part.trim().replace(/\s+/g, " ");
    const key = name.toLowerCase();
    if (!name || seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out;
}

/** What is stored: the names joined by "; ", or null when there are none. Bounded to 500 characters. */
export function cleanAliases(raw: string | null | undefined): string | null {
  const s = aliasList(raw).join("; ");
  return s ? s.slice(0, 500) : null;
}

/** Case-insensitive "contains" match of a search on the customer name or any of its aliases. */
export function nameMatches(name: string, aliases: string | null | undefined, q: string): boolean {
  const n = q.trim().toLowerCase();
  if (!n) return true;
  if (name.toLowerCase().includes(n)) return true;
  return aliasList(aliases).some((a) => a.toLowerCase().includes(n));
}
