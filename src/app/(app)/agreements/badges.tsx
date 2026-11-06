import { AlertTriangle, CheckCircle2, Clock, FilePen, MinusCircle, Send, XCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import { CUSTOMER_STATUS_LABELS, PROPOSAL_STATUS_LABELS, type SaCustomerStatus, type SaProposalStatus } from "@/lib/agreements/constants";
import { RENEWAL_STATE_LABELS, type RenewalState } from "@/lib/agreements/renewal";

// Status is never colour alone: every badge carries an icon and a label.
const BASE = "inline-flex items-center gap-1 whitespace-nowrap rounded-full border px-2 py-0.5 text-xs font-medium";
const TONE = {
  neutral: "border-border bg-muted text-muted-foreground",
  info: "border-sky-300 bg-sky-50 text-sky-800 dark:border-sky-800 dark:bg-sky-950 dark:text-sky-200",
  good: "border-emerald-300 bg-emerald-50 text-emerald-800 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-200",
  warning: "border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200",
  critical: "border-red-300 bg-red-50 text-red-800 dark:border-red-800 dark:bg-red-950 dark:text-red-200",
};

const RENEWAL: Record<RenewalState, { tone: keyof typeof TONE; Icon: typeof Clock }> = {
  NO_CONTRACT: { tone: "neutral", Icon: MinusCircle },
  EXPIRED: { tone: "critical", Icon: AlertTriangle },
  DUE: { tone: "warning", Icon: Clock },
  DRAFT: { tone: "info", Icon: FilePen },
  SENT: { tone: "info", Icon: Send },
  CURRENT: { tone: "good", Icon: CheckCircle2 },
};

export function RenewalBadge({ state, className }: { state: RenewalState; className?: string }) {
  const { tone, Icon } = RENEWAL[state];
  return (
    <span className={cn(BASE, TONE[tone], className)}>
      <Icon className="h-3 w-3" aria-hidden />
      {RENEWAL_STATE_LABELS[state]}
    </span>
  );
}

const PROPOSAL: Record<SaProposalStatus, { tone: keyof typeof TONE; Icon: typeof Clock }> = {
  DRAFT: { tone: "info", Icon: FilePen },
  SENT: { tone: "warning", Icon: Send },
  SIGNED: { tone: "good", Icon: CheckCircle2 },
  DECLINED: { tone: "critical", Icon: XCircle },
  WITHDRAWN: { tone: "neutral", Icon: MinusCircle },
};

export function ProposalBadge({ status, className }: { status: SaProposalStatus; className?: string }) {
  const { tone, Icon } = PROPOSAL[status];
  return (
    <span className={cn(BASE, TONE[tone], className)}>
      <Icon className="h-3 w-3" aria-hidden />
      {PROPOSAL_STATUS_LABELS[status]}
    </span>
  );
}

export function CustomerStatusBadge({ status }: { status: SaCustomerStatus }) {
  const tone: keyof typeof TONE =
    status === "ACTIVE" ? "good" : status === "PENDING" ? "info" : status === "EXPIRED_WAITING" ? "critical" : status === "NOT_RENEWED" ? "warning" : "neutral";
  return <span className={cn(BASE, TONE[tone])}>{CUSTOMER_STATUS_LABELS[status]}</span>;
}

export function UnconfirmedSo() {
  return (
    <span className={cn(BASE, TONE.warning)} title="Suggested or temporary SO # — confirm it on the customer's Details">
      <AlertTriangle className="h-3 w-3" aria-hidden />
      SO # unconfirmed
    </span>
  );
}
