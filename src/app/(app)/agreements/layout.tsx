import type { ReactNode } from "react";
import { AgreementTabs } from "./tabs";

// Service agreements module shell: tab bar (hidden on print) + page.
// Print rules: black-and-white, landscape, no shading (see .sa-print in globals.css).
export default function AgreementsLayout({ children }: { children: ReactNode }) {
  return (
    <div className="sa-print mx-auto max-w-[1500px] p-4 print:max-w-none print:p-0">
      <div className="mb-4 print:hidden">
        <h1 className="text-xl font-semibold tracking-tight">Service agreements</h1>
        <AgreementTabs />
      </div>
      {children}
    </div>
  );
}
