"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import { Copy, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { fmtDate } from "@/lib/agreements/constants";
import { hardwareOfferEmail, type EndedServer } from "@/lib/agreements/hardware";

const amber = "rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm print:hidden";

/** The proposal's year is already signed: delete / replace it (Draft) or withdraw it (Sent). */
export function StaleProposalBanner({
  year,
  signedYear,
  status,
  canEdit,
  pending,
  onDelete,
  onReplace,
  onWithdraw,
}: {
  year: number;
  signedYear: number;
  status: "DRAFT" | "SENT";
  canEdit: boolean;
  pending: boolean;
  onDelete: () => void;
  onReplace: () => void;
  onWithdraw: () => void;
}) {
  const next = signedYear + 1;
  return (
    <div role="alert" className={amber}>
      <p>
        <b>Out of date.</b> This proposal is for {year}, but {signedYear} is already signed.{" "}
        {status === "DRAFT"
          ? `Delete it, or replace it with a ${next} proposal priced from the signed ${signedYear} prices.`
          : `It was sent, so it can't be deleted — withdraw it, then start the ${next} proposal from the customer page.`}
      </p>
      {canEdit && (
        <div className="mt-2 flex flex-wrap gap-2">
          {status === "DRAFT" ? (
            <>
              <Button size="sm" disabled={pending} onClick={onReplace}>Replace with {next} proposal</Button>
              <Button size="sm" variant="outline" className="text-destructive hover:text-destructive" disabled={pending} onClick={onDelete}>
                <Trash2 className="h-4 w-4" aria-hidden /> Delete draft
              </Button>
            </>
          ) : (
            <Button size="sm" variant="outline" disabled={pending} onClick={onWithdraw}>
              <X className="h-4 w-4" aria-hidden /> Withdraw
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

/** Servers out of warranty and no Server Hardware agreement: suggest offering it (copyable email for editors). */
export function HardwareCue({
  customerName,
  servers,
  senderName,
  canEdit,
}: {
  customerName: string;
  servers: EndedServer[];
  senderName: string | null;
  canEdit: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const [fallback, setFallback] = useState<string | null>(null);
  const areaRef = useRef<HTMLTextAreaElement | null>(null);
  const since = servers[0]?.warrantyEnd ?? null;

  const copy = async () => {
    const mail = hardwareOfferEmail({ customerName, servers, senderName });
    const text = `Subject: ${mail.subject}\n\n${mail.body}`;
    try {
      await navigator.clipboard.writeText(text);
      setFallback(null);
      setCopied(true);
      setTimeout(() => setCopied(false), 3000);
    } catch {
      // Clipboard blocked (e.g. not a secure context): show the text to copy by hand.
      setFallback(text);
      requestAnimationFrame(() => areaRef.current?.select());
    }
  };

  return (
    <div className={amber}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span className="mr-auto">
          Server warranty ended on {servers.length} server{servers.length === 1 ? "" : "s"}
          {since ? ` (since ${fmtDate(since)})` : ""} — consider offering Server Hardware.
        </span>
        {canEdit && (
          <Button size="sm" variant="outline" onClick={copy}>
            <Copy className="h-4 w-4" aria-hidden /> {copied ? "Copied" : "Copy email"}
          </Button>
        )}
        <Link href={`/agreements/systems?q=${encodeURIComponent(customerName)}`} className="text-sm font-medium underline-offset-2 hover:underline">
          Servers &amp; QWEB
        </Link>
      </div>
      <span className="sr-only" aria-live="polite">{copied ? "Email copied to the clipboard." : ""}</span>
      {fallback !== null && (
        <div className="mt-2 space-y-1">
          <p className="text-xs">Couldn&rsquo;t reach the clipboard — select the text below and copy it (Ctrl+C).</p>
          <textarea ref={areaRef} readOnly value={fallback} rows={8} className="w-full rounded border bg-background p-2 font-mono text-xs" />
        </div>
      )}
    </div>
  );
}
