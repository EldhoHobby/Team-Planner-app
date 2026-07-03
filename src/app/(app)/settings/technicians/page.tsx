import { redirect } from "next/navigation";

// Technicians are now unified with people on the People page.
export default function TechniciansRedirect() {
  redirect("/settings/people");
}
