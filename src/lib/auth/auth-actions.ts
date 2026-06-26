"use server";

import { redirect } from "next/navigation";
import { destroySession } from "./session";

/** Log the current user out: revoke the session row, clear the cookie, redirect. */
export async function logout(): Promise<void> {
  await destroySession();
  redirect("/login");
}
