"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireScope, ForbiddenError } from "@/lib/auth/current-user";
import {
  createSalesOrder,
  updateSalesOrder,
  deleteSalesOrder,
  type SalesOrderInput,
} from "@/lib/services/sales-orders";

export type SoFormState = { error?: string; success?: boolean; id?: string };

const hours = z
  .union([z.string(), z.number()])
  .optional()
  .transform((v) => {
    if (v === undefined || v === null || v === "") return null;
    const n = typeof v === "number" ? v : Number(String(v).trim());
    return Number.isFinite(n) ? n : null;
  });

const Schema = z.object({
  number: z.string().min(1, "An order number is required").max(60),
  contractor: z.string().max(160).optional(),
  endCustomer: z.string().max(160).optional(),
  projectType: z.string().max(80).optional(),
  scope: z.string().max(2000).optional(),
  status: z.enum(["OPEN", "CLOSED"]).optional(),
  startDate: z.string().optional(),
  quotedHours: hours,
  hoursToDate: hours,
  etcHours: hours,
  contractValue: hours,
  shipDate: z.string().optional(),
  pmOwner: z.string().max(120).optional(),
  remarks: z.string().max(2000).optional(),
  poNumber: z.string().max(80).optional(),
  site: z.string().max(200).optional(),
  contactName: z.string().max(160).optional(),
  contactInfo: z.string().max(200).optional(),
  quoteBreakdown: z.string().max(4000).optional(),
  notes: z.string().max(8000).optional(),
});

function fromForm(fd: FormData) {
  const g = (k: string) => {
    const v = fd.get(k);
    return typeof v === "string" ? v : undefined;
  };
  return {
    number: g("number") ?? "",
    contractor: g("contractor"),
    endCustomer: g("endCustomer"),
    projectType: g("projectType"),
    scope: g("scope"),
    status: g("status") === "CLOSED" ? ("CLOSED" as const) : ("OPEN" as const),
    startDate: g("startDate"),
    quotedHours: g("quotedHours"),
    hoursToDate: g("hoursToDate"),
    etcHours: g("etcHours"),
    contractValue: g("contractValue"),
    shipDate: g("shipDate"),
    pmOwner: g("pmOwner"),
    remarks: g("remarks"),
    poNumber: g("poNumber"),
    site: g("site"),
    contactName: g("contactName"),
    contactInfo: g("contactInfo"),
    quoteBreakdown: g("quoteBreakdown"),
    notes: g("notes"),
  };
}

function toInput(d: z.infer<typeof Schema>): SalesOrderInput {
  return {
    number: d.number,
    contractor: d.contractor ?? null,
    endCustomer: d.endCustomer ?? null,
    projectType: d.projectType ?? null,
    scope: d.scope ?? null,
    status: d.status,
    startDate: d.startDate && /^\d{4}-\d{2}-\d{2}$/.test(d.startDate) ? d.startDate : null,
    quotedHours: d.quotedHours,
    hoursToDate: d.hoursToDate,
    etcHours: d.etcHours,
    contractValue: d.contractValue,
    shipDate: d.shipDate && /^\d{4}-\d{2}-\d{2}$/.test(d.shipDate) ? d.shipDate : null,
    pmOwner: d.pmOwner ?? null,
    remarks: d.remarks ?? null,
    poNumber: d.poNumber ?? null,
    site: d.site ?? null,
    contactName: d.contactName ?? null,
    contactInfo: d.contactInfo ?? null,
    quoteBreakdown: d.quoteBreakdown ?? null,
    notes: d.notes ?? null,
  };
}

export async function createSalesOrderAction(
  _prev: SoFormState,
  formData: FormData,
): Promise<SoFormState> {
  const { scope } = await requireScope();
  const parsed = Schema.safeParse(fromForm(formData));
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  try {
    const o = await createSalesOrder(scope, toInput(parsed.data));
    revalidatePath("/sales-orders");
    revalidatePath("/schedule");
    return { success: true, id: o.id };
  } catch (e) {
    if (e instanceof ForbiddenError) return { error: e.message };
    return { error: "Could not create the sales order." };
  }
}

export async function updateSalesOrderAction(
  _prev: SoFormState,
  formData: FormData,
): Promise<SoFormState> {
  const { scope } = await requireScope();
  const id = formData.get("id");
  if (typeof id !== "string" || !id) return { error: "Missing order id." };
  const parsed = Schema.safeParse(fromForm(formData));
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  try {
    await updateSalesOrder(scope, id, toInput(parsed.data));
    revalidatePath("/sales-orders");
    revalidatePath(`/sales-orders/${id}`);
    revalidatePath("/schedule");
    return { success: true, id };
  } catch (e) {
    if (e instanceof ForbiddenError) return { error: e.message };
    return { error: "Could not save the sales order." };
  }
}

export async function setSalesOrderArchivedAction(input: {
  id: string;
  archived: boolean;
}): Promise<SoFormState> {
  const { scope } = await requireScope();
  try {
    await updateSalesOrder(scope, input.id, { archived: input.archived });
    revalidatePath("/sales-orders");
    return { success: true };
  } catch (e) {
    if (e instanceof ForbiddenError) return { error: e.message };
    return { error: "Could not update the sales order." };
  }
}

export async function deleteSalesOrderAction(input: { id: string }): Promise<SoFormState> {
  const { scope } = await requireScope();
  try {
    await deleteSalesOrder(scope, input.id);
    revalidatePath("/sales-orders");
    return { success: true };
  } catch (e) {
    if (e instanceof ForbiddenError) return { error: e.message };
    return { error: "Could not delete the sales order." };
  }
}
