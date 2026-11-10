"use server";

import { revalidatePath } from "next/cache";
import { requireScope, ForbiddenError, UnauthorizedError } from "@/lib/auth/current-user";
import { StaleSaveError, parseExpectedVersion } from "@/lib/db/optimistic";
import { actionError } from "@/lib/log";
import { updateSettings, type SettingsRow } from "@/lib/services/agreements/common";
import {
  addContractLine, createCustomer, deleteContractLine, saveCalls, updateContractLine, updateCustomer,
  type ContractInput, type CustomerInput,
} from "@/lib/services/agreements/customers";
import {
  addLine, bulkCreateProposals, createProposal, deleteDraftProposal, removeLine, setLinePrice, transitionProposal, updateProposalHeader,
  type ProposalAction, type ProposalEditVersions,
} from "@/lib/services/agreements/proposals";
import { resetAgreements } from "@/lib/services/agreements/import";
import { checkConfirmPassword } from "@/lib/services/full-backup";
import { importAgreementsWorkbook } from "@/lib/services/agreements/workbook";
import type { SaAgreement } from "@/lib/agreements/constants";
import { WORKBOOK_MAX_BYTES, type ActionResult, type BulkResult, type WorkbookImportResult } from "./types";

type Scope = Awaited<ReturnType<typeof requireScope>>["scope"];

/**
 * Every catch goes through actionError (logs unexpected errors, maps an ended session, re-throws
 * Next redirects); a stale save is also flagged so the screen can offer "Reload latest".
 */
function fail(context: string, e: unknown, fallback: string): ActionResult {
  const r: ActionResult = actionError(context, e, fallback);
  if (e instanceof StaleSaveError) r.stale = true;
  return r;
}
function refresh() {
  revalidatePath("/agreements", "layout");
}
function version(v: unknown): number {
  const n = parseExpectedVersion(v);
  if (n === undefined) throw new ForbiddenError("Missing record version — reload the page.");
  return n;
}
/** Runs `fn` with the caller's scope (resolved INSIDE the try, so an ended session comes back as a message). */
async function run(
  context: string,
  fallback: string,
  fn: (scope: Scope) => Promise<string | void | ProposalEditVersions>,
): Promise<ActionResult> {
  try {
    const { scope } = await requireScope();
    const out = await fn(scope);
    refresh();
    if (typeof out === "string") return { ok: true, id: out };
    if (typeof out === "object" && out !== null) return { ok: true, proposalVersion: out.proposalVersion, ...(out.lineVersion !== undefined ? { lineVersion: out.lineVersion } : {}) };
    return { ok: true };
  } catch (e) {
    return fail(context, e, fallback);
  }
}

// ─── customers ───

export async function saveCustomerAction(input: { id?: string; version?: number; data: CustomerInput }) {
  return run("agreements.saveCustomer", "Couldn't save the customer. Please try again.", async (scope) => {
    if (input.id) {
      await updateCustomer(scope, input.id, input.data, version(input.version));
      return input.id;
    }
    return (await createCustomer(scope, input.data)).id;
  });
}

export async function saveContractLineAction(input: {
  id?: string;
  version?: number;
  customerId: string;
  create?: { year: number; agreement: SaAgreement };
  data: ContractInput;
}) {
  return run("agreements.saveContractLine", "Couldn't save the agreement. Please try again.", async (scope) => {
    const data = { ...input.data, price: Number(input.data.price) };
    if (input.id) await updateContractLine(scope, input.id, data, version(input.version));
    else if (input.create) await addContractLine(scope, input.customerId, { ...data, year: Number(input.create.year), agreement: input.create.agreement });
  });
}

export async function deleteContractLineAction(input: { id: string; version: number }) {
  return run("agreements.deleteContractLine", "Couldn't delete the agreement. Please try again.", (scope) =>
    deleteContractLine(scope, input.id, version(input.version)),
  );
}

export async function saveCallsAction(input: { customerId: string; id?: string; version?: number; year: number; calls: number; repairs: number }) {
  return run("agreements.saveCalls", "Couldn't save the calls and repairs. Please try again.", (scope) =>
    saveCalls(scope, input.customerId, {
      id: input.id, version: input.version, year: Number(input.year), calls: Number(input.calls), repairs: Number(input.repairs),
    }),
  );
}

// ─── proposals ───

export async function createProposalAction(input: { customerId: string }) {
  return run("agreements.createProposal", "Couldn't create the proposal. Please try again.", (scope) => createProposal(scope, input.customerId));
}

export async function updateProposalHeaderAction(input: { id: string; version: number; endDate: string | null; notes: string | null }) {
  return run("agreements.updateProposalHeader", "Couldn't save the proposal. Please try again.", (scope) =>
    updateProposalHeader(scope, input.id, { endDate: input.endDate || null, notes: input.notes }, version(input.version)),
  );
}

export async function setLinePriceAction(input: { lineId: string; version: number; price: number }) {
  return run("agreements.setLinePrice", "Couldn't save the price. Please try again.", (scope) =>
    setLinePrice(scope, input.lineId, Number(input.price), version(input.version)),
  );
}

export async function addLineAction(input: { proposalId: string; agreement: SaAgreement; price: number }) {
  return run("agreements.addLine", "Couldn't add the agreement. Please try again.", (scope) =>
    addLine(scope, input.proposalId, input.agreement, Number(input.price)),
  );
}

export async function removeLineAction(input: { lineId: string }) {
  return run("agreements.removeLine", "Couldn't remove the agreement. Please try again.", (scope) => removeLine(scope, input.lineId));
}

export async function proposalTransitionAction(input: {
  id: string;
  version: number;
  action: ProposalAction;
  reason?: string;
  markNotRenewed?: boolean;
  restoreActive?: boolean;
}) {
  return run("agreements.proposalTransition", "Couldn't update the proposal. Please try again.", (scope) =>
    transitionProposal(scope, input.id, input.action, {
      expectedVersion: version(input.version), reason: input.reason, markNotRenewed: !!input.markNotRenewed,
      restoreActive: !!input.restoreActive,
    }),
  );
}

export async function deleteProposalAction(input: { id: string; version: number }) {
  return run("agreements.deleteProposal", "Couldn't delete the proposal. Please try again.", (scope) =>
    deleteDraftProposal(scope, input.id, version(input.version)),
  );
}

export async function bulkProposalsAction(input: { month: string; apply: boolean }): Promise<BulkResult> {
  try {
    const { scope } = await requireScope();
    const rows = await bulkCreateProposals(scope, input.month, !!input.apply);
    if (input.apply) refresh();
    return { ok: true, rows };
  } catch (e) {
    return fail("agreements.bulkProposals", e, "Couldn't create the proposals. Please try again.");
  }
}

// ─── settings / import ───

export async function saveSettingsAction(input: Omit<SettingsRow, "version"> & { version: number }) {
  return run("agreements.saveSettings", "Couldn't save the settings. Please try again.", (scope) =>
    updateSettings(scope, {
      tierLowMax: Number(input.tierLowMax),
      tierMidMax: Number(input.tierMidMax),
      pctLow: Number(input.pctLow),
      pctMid: Number(input.pctMid),
      pctHigh: Number(input.pctHigh),
      tdmsPct: input.tdmsPct === null || input.tdmsPct === undefined ? null : Number(input.tdmsPct),
      escalating: input.escalating,
      autoWaiveAfterHours: !!input.autoWaiveAfterHours,
      afterHoursWaiveAt: Number(input.afterHoursWaiveAt),
      dueWindowDays: Number(input.dueWindowDays),
      fixedPrices: Object.fromEntries(
        Object.entries(input.fixedPrices ?? {}).filter(([, v]) => v !== null && v !== undefined).map(([k, v]) => [k, Number(v)]),
      ),
      expectedVersion: version(input.version),
    }),
  );
}

export async function importWorkbookAction(formData: FormData): Promise<WorkbookImportResult> {
  try {
    const { scope } = await requireScope();
    const file = formData.get("file");
    if (!(file instanceof File) || file.size === 0) return { error: "Choose the exported workbook first." };
    // Server actions accept at most 10 MB per request (next.config bodySizeLimit), so check below that.
    if (file.size > WORKBOOK_MAX_BYTES) return { error: "That file is larger than 9.5 MB — the most the app can take in one upload." };
    const apply = formData.get("apply") === "true";
    const summary = await importAgreementsWorkbook(scope, Buffer.from(await file.arrayBuffer()), apply);
    if (apply) refresh();
    return { ok: true, summary };
  } catch (e) {
    return fail("agreements.importWorkbook", e, "Couldn't read that workbook. Check it is the exported file and try again.");
  }
}

// Deletes customers + their agreements, proposals, calls AND their permanent
// change history — so, like the Settings → Data reset, it needs the typed word
// plus the REAL signed-in user's password ("View as" → the owner's own),
// rate-limited (checkConfirmPassword). Admin-level, not Owner-only: it never
// touches people or roles.
export async function resetAgreementsAction(input: { confirm: string; password: string }): Promise<ActionResult> {
  if (input.confirm !== "RESET") return { error: "Type RESET (in capitals) to confirm." };
  if (!input.password) return { error: "Enter your password to confirm." };
  let scope: Scope;
  try {
    ({ scope } = await requireScope());
  } catch (e) {
    if (e instanceof UnauthorizedError) return { error: "Your session expired — sign in again." };
    return fail("agreements.reset", e, "Couldn't reset the service-agreement data.");
  }
  try {
    if (!scope.ctx.isOrgAdmin) throw new ForbiddenError("Only admins can reset the service-agreement data.");
    const pw = await checkConfirmPassword(scope, input.password);
    if (!pw.ok) return { error: pw.error };
    await resetAgreements(scope);
    refresh();
    return { ok: true };
  } catch (e) {
    return fail("agreements.reset", e, "Couldn't reset the service-agreement data.");
  }
}
