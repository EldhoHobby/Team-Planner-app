import type { ReactNode } from "react";
import { AgreementNav } from "./nav";

export default function AgreementsLayout({ children }: { children: ReactNode }) {
  return (
    <div className="sa-print mx-auto max-w-[1400px] space-y-5 p-4 md:p-6 print:max-w-none print:space-y-0 print:p-0">
      <header className="flex flex-wrap items-end justify-between gap-3 print:hidden">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Service agreements</h1>
          <p className="text-sm text-muted-foreground">Renewals, proposals and contract history by customer.</p>
        </div>
        <AgreementNav />
      </header>
      {children}
    </div>
  );
}
