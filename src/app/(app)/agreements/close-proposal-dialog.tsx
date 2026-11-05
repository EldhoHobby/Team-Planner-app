"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import { proposalTransitionAction } from "./actions";

/** Decline (customer said no) or withdraw (we pulled it) a proposal, with a reason. */
export function CloseProposalDialog({
  proposalId,
  version,
  customerName,
  year,
  onClose,
  onDone,
}: {
  proposalId: string;
  version: number;
  customerName: string;
  year: number;
  onClose: () => void;
  onDone: (error?: string) => void;
}) {
  const [pending, start] = useTransition();
  const [kind, setKind] = useState<"decline" | "withdraw">("decline");
  const [reason, setReason] = useState("");
  const [markNotRenewed, setMarkNotRenewed] = useState(true);

  const submit = () =>
    start(async () => {
      const r = await proposalTransitionAction({ id: proposalId, version, action: kind, reason, markNotRenewed: kind === "decline" && markNotRenewed });
      onDone(r.error);
    });

  return (
    <Modal open onClose={onClose} title={`Close ${customerName}'s ${year} proposal`} className="max-w-md">
      <div className="space-y-3 text-sm">
        <fieldset className="space-y-1">
          <label className="flex items-center gap-2">
            <input type="radio" checked={kind === "decline"} onChange={() => setKind("decline")} />
            Declined — the customer is not renewing
          </label>
          <label className="flex items-center gap-2">
            <input type="radio" checked={kind === "withdraw"} onChange={() => setKind("withdraw")} />
            Withdrawn — replaced or no longer offered
          </label>
        </fieldset>
        <label className="block space-y-1">
          <span className="text-xs text-muted-foreground">Reason (kept in the history)</span>
          <textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={3} className="w-full rounded-md border bg-background p-2" />
        </label>
        {kind === "decline" && (
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={markNotRenewed} onChange={(e) => setMarkNotRenewed(e.target.checked)} />
            Mark the customer &quot;Not renewed&quot;
          </label>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button variant={kind === "decline" ? "destructive" : "default"} disabled={pending} onClick={submit}>
            {kind === "decline" ? "Mark declined" : "Withdraw"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
