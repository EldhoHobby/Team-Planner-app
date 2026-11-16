"use server";

import { revalidatePath } from "next/cache";
import { ForbiddenError, requireScope } from "@/lib/auth/current-user";
import { StaleSaveError, parseExpectedVersion } from "@/lib/db/optimistic";
import { actionError } from "@/lib/log";
import { replaceStaleDraft, setLineProration } from "@/lib/services/agreements/proposals";
import type { ActionResult } from "../../types";

// Proposal page actions added with the renewal UX work (the rest live in agreements/actions.ts).

function version(v: unknown): number {
  const n = parseExpectedVersion(v);
  if (n === undefined) throw new ForbiddenError("Missing record version — reload the page.");
  return n;
}

/** Prorate a line ({ start, fullPrice }) or remove its proration (`prorate: null`). */
export async function setLineProrationAction(input: {
  lineId: string;
  version: number;
  prorate: { start: string; fullPrice: number } | null;
}): Promise<ActionResult> {
  try {
    const { scope } = await requireScope();
    const p = input.prorate;
    const out = await setLineProration(
      scope,
      String(input.lineId ?? ""),
      p ? { start: String(p.start ?? ""), fullPrice: Number(p.fullPrice) } : null,
      version(input.version),
    );
    revalidatePath("/agreements", "layout");
    return { ok: true, proposalVersion: out.proposalVersion, lineVersion: out.lineVersion };
  } catch (e) {
    const r: ActionResult = actionError("agreements.prorateLine", e, "Couldn't save the proration. Please try again.");
    if (e instanceof StaleSaveError) r.stale = true;
    return r;
  }
}

/** Out-of-date draft: delete it and create the next-year proposal in one go. Returns the new proposal's id. */
export async function replaceStaleDraftAction(input: { id: string; version: number }): Promise<ActionResult> {
  try {
    const { scope } = await requireScope();
    const id = await replaceStaleDraft(scope, String(input.id ?? ""), version(input.version));
    revalidatePath("/agreements", "layout");
    return { ok: true, id };
  } catch (e) {
    const r: ActionResult = actionError("agreements.replaceStaleDraft", e, "Couldn't replace the proposal. Please try again.");
    if (e instanceof StaleSaveError) r.stale = true;
    return r;
  }
}
