"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { prisma } from "@/lib/db/client";
import { hashPassword } from "@/lib/auth/password";
import { createSession } from "@/lib/auth/session";
import { isBootstrapped, slugify } from "@/lib/auth/bootstrap";
import { uniqueUsername } from "@/lib/auth/username";
import type { SetupState } from "./types";

const SetupSchema = z
  .object({
    orgName: z.string().min(2, "Organization name must be at least 2 characters"),
    name: z.string().min(1, "Your name is required"),
    email: z.string().email("Enter a valid email address"),
    password: z.string().min(8, "Password must be at least 8 characters"),
    confirmPassword: z.string(),
  })
  .refine((d) => d.password === d.confirmPassword, {
    message: "Passwords do not match",
    path: ["confirmPassword"],
  });

export async function createOwnerAccount(
  _prev: SetupState,
  formData: FormData,
): Promise<SetupState> {
  // Guard: setup is only available before the instance is bootstrapped.
  if (await isBootstrapped()) {
    return { error: "This instance is already set up. Please sign in instead." };
  }

  const parsed = SetupSchema.safeParse({
    orgName: formData.get("orgName"),
    name: formData.get("name"),
    email: formData.get("email"),
    password: formData.get("password"),
    confirmPassword: formData.get("confirmPassword"),
  });

  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }

  const { orgName, name, email, password } = parsed.data;
  const passwordHash = await hashPassword(password);

  let ownerId: string;
  try {
    const owner = await prisma.$transaction(async (tx) => {
      const org = await tx.organization.create({
        data: { name: orgName, slug: slugify(orgName) },
      });

      const username = await uniqueUsername({ email, name }, tx);
      const user = await tx.user.create({
        data: { username, email: email.toLowerCase(), name, passwordHash },
      });

      await tx.membership.create({
        data: { userId: user.id, orgId: org.id, role: "OWNER" },
      });

      return user;
    });
    ownerId = owner.id;
  } catch {
    // Unique-constraint or similar — surface a safe, generic message.
    return { error: "Could not create the account. The email may already be in use." };
  }

  // Log the new owner straight in, then send them to the app.
  await createSession(ownerId);
  redirect("/");
}
