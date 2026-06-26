import { randomBytes, createHash, timingSafeEqual } from "crypto";

// Shared secure-token helpers used by sessions, invitations, and password resets.
// Pattern: hand out a high-entropy random token to the user (cookie / link),
// store only its hash. Look ups compare hashes, so the raw token never rests in
// the database.

/** Cryptographically random, URL-safe token. 32 bytes ≈ 256 bits of entropy. */
export function generateToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

/** SHA-256 hash (hex) of a token, for storage and lookup. */
export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Constant-time comparison of two hex hashes, to avoid timing leaks. */
export function tokensMatch(aHex: string, bHex: string): boolean {
  const a = Buffer.from(aHex, "hex");
  const b = Buffer.from(bHex, "hex");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
