// Shared user-identity helpers (pure — safe in server and client components).

export const USERNAME_RE = /^[a-z0-9._-]{3,32}$/;

/** Lowercase + strip anything outside the allowed charset. */
export function normalizeUsername(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ".")
    .replace(/[^a-z0-9._-]/g, "");
}

export function isValidUsername(u: string): boolean {
  return USERNAME_RE.test(u);
}

/**
 * The one display state that links a person's name and email/username.
 * Never stored — always rendered from the User row.
 *   "Jane Doe (jane@acme.com)" | "Jane Doe (jane.doe)" | "jane.doe"
 */
export function displayHandle(u: {
  name?: string | null;
  email?: string | null;
  username?: string | null;
}): string {
  const contact = u.email ?? u.username ?? "";
  if (u.name) return contact ? `${u.name} (${contact})` : u.name;
  return contact;
}
