// Server Hardware offer — pure helpers shared by the Renewals list, the customer page and the
// proposal page. No Prisma / Next imports: unit-tested and client-safe.
import { SERVER_ROLES, isServiceTag, type ServerExpField, type ServerTagField } from "./systems";
import { fmtDateOnly } from "../tz";

/** The part of a system the hardware rules need (dates are YYYY-MM-DD). */
export type HardwareSystem = { soNumber: string } & Record<ServerTagField, string | null> &
  Record<ServerExpField, string | null>;

export interface EndedServer {
  /** "Server A", "Historian", "QWEB server". */
  label: string;
  tag: string;
  /** Warranty end, YYYY-MM-DD. */
  warrantyEnd: string;
  soNumber: string;
}

/** Every real service tag whose manufacturer warranty ended before `today`, oldest first. */
export function endedServers(systems: readonly HardwareSystem[], today: string): EndedServer[] {
  const out: EndedServer[] = [];
  for (const s of systems) {
    for (const r of SERVER_ROLES) {
      const tag = s[r.tag]?.trim() ?? "";
      const end = s[r.exp];
      if (isServiceTag(tag) && end && end < today) out.push({ label: r.label, tag, warrantyEnd: end, soNumber: s.soNumber });
    }
  }
  return out.sort((a, b) => a.warrantyEnd.localeCompare(b.warrantyEnd) || a.label.localeCompare(b.label));
}

/**
 * Should the renewal suggest Server Hardware? Yes when at least one server is out of warranty
 * and the customer has no Server Hardware agreement in force (nor in the open proposal).
 */
export function shouldOfferHardware(ended: readonly EndedServer[], hasServerHardware: boolean): boolean {
  return ended.length > 0 && !hasServerHardware;
}

/** A plain-text email offering the Server Hardware Agreement, with the tags on file. */
export function hardwareOfferEmail(input: {
  customerName: string;
  contactName?: string | null;
  servers: readonly EndedServer[];
  senderName?: string | null;
}): { subject: string; body: string } {
  const rows = input.servers.map((s) => `${s.label}\t${s.tag}\t${fmtDateOnly(s.warrantyEnd)}`);
  const body = [
    `Hi ${input.contactName?.trim() || "there"},`,
    "",
    "We're putting together your service agreement renewal for next year. While reviewing your system records, we saw that the manufacturer's warranty has ended on the server hardware listed below.",
    "",
    "To keep your system protected, we'd like to offer our Server Hardware Agreement for your consideration. These are the servers and service tags we have on file:",
    "",
    "Server\tService Tag\tManufacturer Warranty Ended",
    ...rows,
    "",
    "Could you please:",
    "1. Confirm that this list is correct and up to date.",
    "2. Let us know which servers you'd like covered.",
    "",
    "We strongly recommend covering the main SCADA servers, since they run your SCADA system. Coverage for the other servers is your choice.",
    "",
    "Once we hear back, we'll include the selected coverage in your renewal proposal.",
    "",
    "Thank you for your continued partnership with QEI. Please let me know if you have any questions.",
    "",
    "Best regards,",
    input.senderName?.trim() || "",
  ].join("\n").trimEnd();
  return { subject: `${input.customerName} – Server Hardware Coverage for the Upcoming Agreement Renewal`, body };
}
