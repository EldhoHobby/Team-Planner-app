import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/current-user";
import { isBootstrapped } from "@/lib/auth/bootstrap";
import { HOME_PATH } from "@/lib/home";

export const dynamic = "force-dynamic";

export default async function Home() {
  if (!(await isBootstrapped())) {
    redirect("/setup");
  }
  const user = await getCurrentUser();
  redirect(user ? HOME_PATH : "/login");
}
