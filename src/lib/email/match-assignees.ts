// Pure assignee-matching for the email→task ingest (no DB, unit-tested).
//
// Both assignment forms REQUIRE the "@" marker:
//   • "@username"   — e.g. @charles.fry
//   • "@Full Name"  — e.g. @Charles Fry (case-insensitive; multi-word names
//                     only — a bare first name is too ambiguous)
// A person's name appearing in plain prose (no "@") must NOT assign.

export interface MatchPerson {
  id: string;
  username: string;
  name: string | null;
}

// "@username" tags. The lookbehind keeps this from matching the domain half of
// email addresses ("bob@acme.com" must not tag "acme.com") and from mangling
// addresses when tags are stripped out of titles.
export const TAG_RE = /(?<![a-z0-9._-])@([a-z0-9][a-z0-9._-]{0,31})/gi;

/** Escape a literal string for use inside a RegExp. */
function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function fullNameOf(p: MatchPerson): string | null {
  const full = p.name?.trim().replace(/\s+/g, " ");
  return full && full.includes(" ") ? full : null; // multi-word names only
}

/**
 * Find every person assigned in `text` via "@Full Name" or "@username".
 * Full names are matched FIRST and consumed, so "@Charles Fry" can't also be
 * misread as a "@charles" username tag pointing at someone else.
 */
export function matchAssignees(text: string, people: MatchPerson[]): MatchPerson[] {
  const matched = new Map<string, MatchPerson>();
  let haystack = text;

  for (const p of people) {
    const full = fullNameOf(p);
    if (!full) continue;
    const re = new RegExp(`@${escapeRe(full)}`, "gi");
    if (re.test(haystack)) {
      matched.set(p.id, p);
      haystack = haystack.replace(re, " ");
    }
  }

  const byUsername = new Map(people.map((p) => [p.username.toLowerCase(), p]));
  for (const m of haystack.matchAll(TAG_RE)) {
    const u = byUsername.get(m[1].toLowerCase());
    if (u) matched.set(u.id, u);
  }

  return [...matched.values()];
}

/** Remove the assignment markers (matched "@Full Name"s, then "@username" tags). */
export function stripAssignmentMarkers(subject: string, matched: MatchPerson[]): string {
  let out = subject;
  for (const p of matched) {
    const full = fullNameOf(p);
    if (full) out = out.replace(new RegExp(`@${escapeRe(full)}`, "gi"), " ");
  }
  return out.replace(TAG_RE, "").replace(/\s{2,}/g, " ").trim();
}
