import Link from "next/link";
import { ChevronRight, ClipboardList, Handshake } from "lucide-react";
import { requireAgreementsAccess } from "@/app/(app)/agreements/access";
import { requireAuth } from "@/lib/auth/guard";
import { requireScope } from "@/lib/auth/current-user";
import { PageHeader } from "@/components/ui/page-header";

export const dynamic = "force-dynamic";
export const metadata = { title: "Customer Service" };

const ITEMS = [
  {
    href: "/agreements",
    label: "Agreements",
    text: "Service agreements: renewals, customers and proposals.",
    icon: Handshake,
  },
  {
    href: "/open-pos",
    label: "Open POs",
    text: "Customer orders that are still open, with the latest status and history.",
    icon: ClipboardList,
  },
];

/** The sidebar's "Customer Service" item lands here: one button per Customer Service page. */
export default async function CustomerServicePage() {
  await requireAuth();
  const { scope } = await requireScope();
  await requireAgreementsAccess(scope);
  return (
    <div className="mx-auto max-w-3xl space-y-5 p-4 md:p-6">
      <PageHeader title="Customer Service" description="Choose where to go." />
      <div className="grid gap-4 sm:grid-cols-2">
        {ITEMS.map(({ href, label, text, icon: Icon }) => (
          <Link
            key={href}
            href={href}
            className="group flex items-center gap-4 rounded-lg border bg-card p-5 transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-md bg-primary text-primary-foreground">
              <Icon className="h-5 w-5" aria-hidden />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-base font-semibold">{label}</span>
              <span className="mt-0.5 block text-sm text-muted-foreground">{text}</span>
            </span>
            <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" aria-hidden />
          </Link>
        ))}
      </div>
    </div>
  );
}
