"use server";

import { revalidatePath } from "next/cache";
import { requireScope, ForbiddenError } from "@/lib/auth/current-user";
import { StaleSaveError, parseExpectedVersion } from "@/lib/db/optimistic";
import {
  bulkProposals, createCalls, createCustomer, createPrice, deletePrice, markSigned, newProposal,
  setProposalEndDate, setProposalPrice, updateCalls, updateCustomer, updatePrice, updateSettings,
  type CustomerInput, type PriceInput,
} from "@/lib/services/agreements";
import { importPrototype } from "@/lib/services/agreements-import";
import type { PricingRules } from "@/lib/agreements/pricing";
import type { SaAgreement } from "@/lib/agreements/constants";
import type { ActionResult, BulkResult, ImportSummary } from "./types";

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

// ─── Customer View ───

export async function newProposalAction(input: { customerId: string }): Promise<ActionResult> {
  const { scope } = await requireScope();
  try {
    await newProposal(scope, input.customerId);
    refresh();
    return { ok: true };
  } catch (e) {
    return fail(e, "Could not create the proposal.");
  }
}

export async function setProposalPriceAction(input: { priceId: string; price: number; version: number }): Promise<ActionResult> {
  const { scope } = await requireScope();
  try {
    await setProposalPrice(scope, input.priceId, Number(input.price), version(input.version));
    refresh();
    return { ok: true };
  } catch (e) {
    return fail(e, "Could not save the price.");
  }
}

export async function setProposalEndDateAction(input: { customerId: string; year: number; endDate: string | null }): Promise<ActionResult> {
  const { scope } = await requireScope();
  try {
    await setProposalEndDate(scope, input.customerId, Number(input.year), input.endDate || null);
    refresh();
    return { ok: true };
  } catch (e) {
    return fail(e, "Could not save the end date.");
  }
}

export async function markSignedAction(input: { customerId: string; year: number }): Promise<ActionResult> {
  const { scope } = await requireScope();
  try {
    await markSigned(scope, input.customerId, Number(input.year));
    refresh();
    return { ok: true };
  } catch (e) {
    return fail(e, "Could not mark the proposal signed.");
  }
}

// ─── Customers ───

export async function saveCustomerAction(input: { id?: string; version?: number; data: CustomerInput }): Promise<ActionResult> {
  const { scope } = await requireScope();
  try {
    let id = input.id;
    if (id) await updateCustomer(scope, id, input.data, version(input.version));
    else id = (await createCustomer(scope, input.data)).id;
    refresh();
    return { ok: true, id };
  } catch (e) {
    return fail(e, "Could not save the customer.");
  }
}

// ─── Pricing ───

export async function savePriceAction(input: {
  id?: string;
  version?: number;
  create?: { customerId: string; year: number; agreement: SaAgreement };
  data: PriceInput;
}): Promise<ActionResult> {
  const { scope } = await requireScope();
  try {
    const data = { ...input.data, price: Number(input.data.price) };
    if (input.id) await updatePrice(scope, input.id, data, version(input.version));
    else if (input.create) await createPrice(scope, { ...data, ...input.create, year: Number(input.create.year) });
    else return { error: "Nothing to save." };
    refresh();
    return { ok: true };
  } catch (e) {
    return fail(e, "Could not save the price row.");
  }
}

export async function deletePriceAction(input: { id: string; version: number }): Promise<ActionResult> {
  const { scope } = await requireScope();
  try {
    await deletePrice(scope, input.id, version(input.version));
    refresh();
    return { ok: true };
  } catch (e) {
    return fail(e, "Could not delete the price row.");
  }
}

// ─── Calls ───

export async function saveCallsAction(input: {
  id?: string;
  version?: number;
  create?: { customerId: string; year: number };
  calls: number;
  repairs: number;
}): Promise<ActionResult> {
  const { scope } = await requireScope();
  try {
    const calls = Number(input.calls);
    const repairs = Number(input.repairs);
    if (input.id) await updateCalls(scope, input.id, { calls, repairs }, version(input.version));
    else if (input.create) await createCalls(scope, { ...input.create, year: Number(input.create.year), calls, repairs });
    else return { error: "Nothing to save." };
    refresh();
    return { ok: true };
  } catch (e) {
    return fail(e, "Could not save calls / repairs.");
  }
}

// ─── Settings ───

export async function saveSettingsAction(input: PricingRules & { version: number }): Promise<ActionResult> {
  const { scope } = await requireScope();
  try {
    await updateSettings(scope, {
      tierLowMax: Number(input.tierLowMax),
      tierMidMax: Number(input.tierMidMax),
      pctLow: Number(input.pctLow),
      pctMid: Number(input.pctMid),
      pctHigh: Number(input.pctHigh),
      tdmsMultiplier: Number(input.tdmsMultiplier),
      tdmsMode: input.tdmsMode,
      escalating: input.escalating,
      autoWaiveAfterHours: !!input.autoWaiveAfterHours,
      afterHoursWaiveAt: Number(input.afterHoursWaiveAt),
      expectedVersion: version(input.version),
    });
    refresh();
    return { ok: true };
  } catch (e) {
    return fail(e, "Could not save the settings.");
  }
}

// ─── Renewals bulk ───

export async function bulkProposalsAction(input: { month: string; apply: boolean }): Promise<BulkResult> {
  const { scope } = await requireScope();
  try {
    const rows = await bulkProposals(scope, input.month, !!input.apply);
    if (input.apply) refresh();
    return { ok: true, rows };
  } catch (e) {
    return fail(e, "Could not create the proposals.");
  }
}

// ─── Import (admin) ───

export async function importPrototypeAction(formData: FormData): Promise<ActionResult & { summary?: ImportSummary }> {
  const { scope } = await requireScope();
  try {
    const file = formData.get("file");
    if (!(file instanceof File) || file.size === 0) return { error: "Choose the .xlsm / .xlsx file first." };
    if (file.size > 9 * 1024 * 1024) return { error: "That file is larger than 9 MB." };
    const review = formData.get("review");
    const reviewBuf = review instanceof File && review.size > 0 ? Buffer.from(await review.arrayBuffer()) : undefined;
    const apply = formData.get("apply") === "true";
    const summary = await importPrototype(scope, Buffer.from(await file.arrayBuffer()), apply, reviewBuf);
    if (apply) refresh();
    return { ok: true, summary };
  } catch (e) {
    return fail(e, "Could not read that workbook.");
  }
}
