import { redirect } from "next/navigation";

// Members + Technicians are now unified on the People page.
export default function MembersRedirect() {
  redirect("/settings/people");
}
