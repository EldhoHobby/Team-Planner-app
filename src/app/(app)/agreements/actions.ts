"use server";

import { revalidatePath } from "next/cache";
import { requireScope, ForbiddenError, UnauthorizedError } from "@/lib/auth/current-user";
import { StaleSaveError, parseExpectedVersion } from "@/lib/db/optimistic";
import { updateSettings, type SettingsRow } from "@/lib/services/agreements/common";
import {
  addContractLine, createCustomer, deleteContractLine, saveCalls, updateContractLine, updateCustomer,
  type ContractInput, type CustomerInput,
} from "@/lib/services/agreements/customers";
import {
  addLine, bulkCreateProposals, createProposal, deleteDraftProposal, removeLine, setLinePrice, transitionProposal, updateProposalHeader,
  type ProposalAction,
} from "@/lib/services/agreements/proposals";
import { resetAgreements } from "@/lib/services/agreements/import";
import { checkConfirmPassword } from "@/lib/services/full-backup";
import { importAgreementsWorkbook } from "@/lib/services/agreements/workbook";
import type { SaAgreement } from "@/lib/agreements/constants";
import type { ActionResult, BulkResult, WorkbookImportResult } from "./types";

function fail(e: unknown, fallback: string): ActionResult {
  if (e instanceof StaleSaveError) return { error: e.message, stale: true };
  if (e instanceof ForbiddenError) return { error: e.message };
  console.error(fallback, e);
  return { error: fallback };
}
function refresh() {
  revalidatePath("/agreements", "layout");
}
function version(v: unknown): number {
  const n = parseExpectedVersion(v);
  if (n === undefined) throw new ForbiddenError("Missing record version — reload the page.");
  return n;
}
async function run(fallback: string, fn: (scope: Awaited<ReturnType<typeof requireScope>>["scope"]) => Promise<string | void>): Promise<ActionResult> {
  const { scope } = await requireScope();
  try {
    const id = await fn(scope);
    refresh();
    return { ok: true, ...(id ? { id } : {}) };
  } catch (e) {
    return fail(e, fallback);
  }
}

// ─── customers ───

export async function saveCustomerAction(input: { id?: string; version?: number; data: CustomerInput }) {
  return run("Could not save the customer.", async (scope) => {
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
  return run("Could not save the agreement line.", async (scope) => {
    const data = { ...input.data, price: Number(input.data.price) };
    if (input.id) await updateContractLine(scope, input.id, data, version(input.version));
    else if (input.create) await addContractLine(scope, input.customerId, { ...data, year: Number(input.create.year), agreement: input.create.agreement });
  });
}

export async function deleteContractLineAction(input: { id: string; version: number }) {
  return run("Could not delete the agreement line.", (scope) => deleteContractLine(scope, input.id, version(input.version)));
}

export async function saveCallsAction(input: { customerId: string; id?: string; version?: number; year: number; calls: number; repairs: number }) {
  return run("Could not save calls / repairs.", (scope) =>
    saveCalls(scope, input.customerId, {
      id: input.id, version: input.version, year: Number(input.year), calls: Number(input.calls), repairs: Number(input.repairs),
    }),
  );
}

// ─── proposals ───

export async function createProposalAction(input: { customerId: string }) {
  return run("Could not create the proposal.", (scope) => createProposal(scope, input.customerId));
}

export async function updateProposalHeaderAction(input: { id: string; version: number; endDate: string | null; notes: string | null }) {
  return run("Could not save the proposal.", (scope) =>
    updateProposalHeader(scope, input.id, { endDate: input.endDate || null, notes: input.notes }, version(input.version)),
  );
}

export async function setLinePriceAction(input: { lineId: string; version: number; price: number }) {
  return run("Could not save the price.", (scope) => setLinePrice(scope, input.lineId, Number(input.price), version(input.version)));
}

export async function addLineAction(input: { proposalId: string; agreement: SaAgreement; price: number }) {
  return run("Could not add the agreement.", (scope) => addLine(scope, input.proposalId, input.agreement, Number(input.price)));
}

export async function removeLineAction(input: { lineId: string }) {
  return run("Could not remove the agreement.", (scope) => removeLine(scope, input.lineId));
}

export async function proposalTransitionAction(input: {
  id: string;
  version: number;
  action: ProposalAction;
  reason?: string;
  markNotRenewed?: boolean;
}) {
  return run("Could not update the proposal.", (scope) =>
    transitionProposal(scope, input.id, input.action, {
      expectedVersion: version(input.version), reason: input.reason, markNotRenewed: !!input.markNotRenewed,
    }),
  );
}

export async function deleteProposalAction(input: { id: string; version: number }) {
  return run("Could not delete the proposal.", (scope) => deleteDraftProposal(scope, input.id, version(input.version)));
}

export async function bulkProposalsAction(input: { month: string; apply: boolean }): Promise<BulkResult> {
  const { scope } = await requireScope();
  try {
    const rows = await bulkCreateProposals(scope, input.month, !!input.apply);
    if (input.apply) refresh();
    return { ok: true, rows };
  } catch (e) {
    return fail(e, "Could not create the proposals.");
  }
}

// ─── settings / import ───

export async function saveSettingsAction(input: Omit<SettingsRow, "version"> & { version: number }) {
  return run("Could not save the settings.", (scope) =>
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
  const { scope } = await requireScope();
  try {
    const file = formData.get("file");
    if (!(file instanceof File) || file.size === 0) return { error: "Choose the exported workbook first." };
    if (file.size > 15 * 1024 * 1024) return { error: "That file is larger than 15 MB." };
    const apply = formData.get("apply") === "true";
    const summary = await importAgreementsWorkbook(scope, Buffer.from(await file.arrayBuffer()), apply);
    if (apply) refresh();
    return { ok: true, summary };
  } catch (e) {
    return fail(e, "Could not read that workbook.") as WorkbookImportResult;
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
  let scope: Awaited<ReturnType<typeof requireScope>>["scope"];
  try {
    ({ scope } = await requireScope());
  } catch (e) {
    if (e instanceof UnauthorizedError) return { error: "Your session expired — sign in again." };
    return fail(e, "Could not reset the service-agreement data.");
  }
  try {
    if (!scope.ctx.isOrgAdmin) throw new ForbiddenError("Only admins can reset the service-agreement data.");
    const pw = await checkConfirmPassword(scope, input.password);
    if (!pw.ok) return { error: pw.error };
    await resetAgreements(scope);
    refresh();
    return { ok: true };
  } catch (e) {
    return fail(e, "Could not reset the service-agreement data.");
  }
}
