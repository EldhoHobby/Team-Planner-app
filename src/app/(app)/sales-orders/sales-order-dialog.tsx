"use client";

import { useActionState, useEffect } from "react";
import { useFormStatus } from "react-dom";
import { useRouter } from "next/navigation";
import type { SalesOrderRow } from "@/lib/services/sales-orders";
import { createSalesOrderAction, updateSalesOrderAction, type SoFormState } from "./actions";
import { Modal } from "@/components/ui/modal";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const selectClass =
  "flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";
const areaClass =
  "flex w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

function Submit({ label }: { label: string }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" size="sm" disabled={pending}>
      {pending ? "Saving…" : label}
    </Button>
  );
}

/** Create or edit a sales order. `order` omitted = create. */
export function SalesOrderDialog({
  open,
  onClose,
  order,
}: {
  open: boolean;
  onClose: () => void;
  order?: SalesOrderRow;
}) {
  const router = useRouter();
  const editing = !!order;
  const [state, action] = useActionState<SoFormState, FormData>(
    editing ? updateSalesOrderAction : createSalesOrderAction,
    {},
  );

  useEffect(() => {
    if (state.success) {
      router.refresh();
      onClose();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.success]);

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={editing ? `Sales order ${order!.number}` : "New sales order"}
      description="Accounting names an order Contractor / End customer / Project type."
      className="max-w-2xl"
    >
      <form action={action} className="space-y-4">
        {editing ? <input type="hidden" name="id" value={order!.id} /> : null}

        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-2">
            <Label htmlFor="so-number">Order number</Label>
            <Input
              id="so-number"
              name="number"
              defaultValue={order?.number ?? ""}
              placeholder="24020"
              required
            />
            <p className="text-[11px] text-muted-foreground">
              A leading <code>SYS-</code> is dropped, so SYS-24020 and 24020 are one order.
            </p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="so-status">Status</Label>
            <select id="so-status" name="status" className={selectClass} defaultValue={order?.status ?? "OPEN"}>
              <option value="OPEN">Open</option>
              <option value="CLOSED">Closed</option>
            </select>
          </div>
        </div>

        <div className="grid grid-cols-3 gap-3">
          <div className="space-y-2">
            <Label htmlFor="so-contractor">Contractor</Label>
            <Input id="so-contractor" name="contractor" defaultValue={order?.contractor ?? ""} placeholder="McDonald Elect" />
          </div>
          <div className="space-y-2">
            <Label htmlFor="so-customer">End customer</Label>
            <Input id="so-customer" name="endCustomer" defaultValue={order?.endCustomer ?? ""} placeholder="MBTA" />
          </div>
          <div className="space-y-2">
            <Label htmlFor="so-type">Project type</Label>
            <Input id="so-type" name="projectType" defaultValue={order?.projectType ?? ""} placeholder="SAS" />
          </div>
        </div>

        <div className="space-y-2">
          <Label htmlFor="so-scope">Scope</Label>
          <Input id="so-scope" name="scope" defaultValue={order?.scope ?? ""} placeholder="(3) RTU'S AND LOOSE DIO" />
        </div>

        <fieldset className="space-y-2 rounded-md border p-3">
          <legend className="px-1 text-xs font-medium text-muted-foreground">
            Field-service hours
          </legend>
          <div className="grid grid-cols-3 gap-3">
            <div className="space-y-2">
              <Label htmlFor="so-quoted">Quoted</Label>
              <Input id="so-quoted" name="quotedHours" type="number" step="0.5" defaultValue={order?.quotedHours ?? ""} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="so-todate">To date</Label>
              <Input id="so-todate" name="hoursToDate" type="number" step="0.5" defaultValue={order?.hoursToDate ?? ""} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="so-etc">ETC</Label>
              <Input id="so-etc" name="etcHours" type="number" step="0.5" defaultValue={order?.etcHours ?? ""} />
            </div>
          </div>
          <p className="text-[11px] text-muted-foreground">
            Remaining is derived (quoted − to date) and may go negative. Entered by hand for
            now — timesheets can&apos;t supply it until more of the team files them.
          </p>
        </fieldset>

        <fieldset className="space-y-2 rounded-md border p-3">
          <legend className="px-1 text-xs font-medium text-muted-foreground">
            From the SYSTAT status report
          </legend>
          <div className="grid grid-cols-3 gap-3">
            <div className="space-y-2">
              <Label htmlFor="so-value">Contract value</Label>
              <Input
                id="so-value"
                name="contractValue"
                defaultValue={order?.contractValue ?? ""}
                placeholder="929800"
              />
              <p className="text-[11px] text-muted-foreground">In dollars (SYSTAT writes $929.8K).</p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="so-ship">Ship date</Label>
              <Input id="so-ship" name="shipDate" type="date" defaultValue={order?.shipDate ?? ""} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="so-pm">Project manager</Label>
              <Input id="so-pm" name="pmOwner" defaultValue={order?.pmOwner ?? ""} placeholder="E. Hobby" />
            </div>
          </div>
          <div className="space-y-2">
            <Label htmlFor="so-remarks">Remarks</Label>
            <textarea
              id="so-remarks"
              name="remarks"
              rows={2}
              className={areaClass}
              defaultValue={order?.remarks ?? ""}
              placeholder="CHANGE ORDER PENDING REWORK / PROGRESS PAYMENT PENDING"
            />
          </div>
        </fieldset>

        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-2">
            <Label htmlFor="so-po">PO number</Label>
            <Input id="so-po" name="poNumber" defaultValue={order?.poNumber ?? ""} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="so-start">Start date</Label>
            <Input id="so-start" name="startDate" type="date" defaultValue={order?.startDate ?? ""} />
          </div>
        </div>

        <div className="space-y-2">
          <Label htmlFor="so-site">Site</Label>
          <Input id="so-site" name="site" defaultValue={order?.site ?? ""} placeholder="Substation / depot / address" />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-2">
            <Label htmlFor="so-contact">Contact</Label>
            <Input id="so-contact" name="contactName" defaultValue={order?.contactName ?? ""} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="so-contactinfo">Phone / email</Label>
            <Input id="so-contactinfo" name="contactInfo" defaultValue={order?.contactInfo ?? ""} />
          </div>
        </div>

        <div className="space-y-2">
          <Label htmlFor="so-breakdown">Quote F/S breakdown</Label>
          <textarea
            id="so-breakdown"
            name="quoteBreakdown"
            rows={4}
            className={areaClass}
            defaultValue={order?.quoteBreakdown ?? ""}
            placeholder={"2 Weeks Field Acceptance - TBD\n6 days Onsite Training - TBD"}
          />
          <p className="text-[11px] text-muted-foreground">
            The planned trips and their quoted allowance. Jobs on the schedule are the
            record of what is actually booked.
          </p>
        </div>

        <div className="space-y-2">
          <Label htmlFor="so-notes">Notes</Label>
          <textarea
            id="so-notes"
            name="notes"
            rows={5}
            className={areaClass}
            defaultValue={order?.notes ?? ""}
            placeholder="Running log, as the FS Status Comments column"
          />
        </div>

        {state.error ? (
          <p role="alert" className="text-sm text-destructive">{state.error}</p>
        ) : null}

        <div className="flex items-center justify-end gap-2 border-t pt-3">
          <Button type="button" variant="ghost" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Submit label={editing ? "Save" : "Create order"} />
        </div>
      </form>
    </Modal>
  );
}
