import argon2 from "argon2";

// Argon2id is the recommended password hashing algorithm (memory-hard, resistant
// to GPU/ASIC cracking). Defaults here are sensible for a server with ~spare RAM;
// tune memoryCost/timeCost up if your host can afford it.
const OPTIONS: argon2.Options = {
  type: argon2.argon2id,
  memoryCost: 19456, // 19 MiB
  timeCost: 2,
  parallelism: 1,
};

export function hashPassword(plain: string): Promise<string> {
  return argon2.hash(plain, OPTIONS);
}

export async function verifyPassword(hash: string, plain: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, plain);
  } catch {
    // Malformed hash or verification error — treat as a failed login, never throw.
    return false;
  }
}
