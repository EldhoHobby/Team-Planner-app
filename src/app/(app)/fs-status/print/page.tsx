import { requireAuth } from "@/lib/auth/guard";
import { redirect } from "next/navigation";
import { requireScope } from "@/lib/auth/current-user";
import { HOME_PATH } from "@/lib/home";
import { canViewFsStatus, listFsOrders } from "@/lib/services/fs-status";
import {
  FS_COLUMNS, FS_GROUP_LABELS, FS_ROW_LINES, FS_SHOWS, fmtHrs, fsLabel, groupKeyOf, inFsShow, isFsShowKey, matchesFsQuery,
  remainingOf, scheduleLine, type FsColumn, type FsOrderRow,
} from "@/lib/fs-status/rules";
import { fmtDateOnly, todayYmd } from "@/lib/tz";
import { cn } from "@/lib/utils";
import { PrintBar } from "./print-bar";

export const dynamic = "force-dynamic";
export const metadata = { title: "Print Field Service Status" };

// The print view: the Excel export's sheet on paper (same columns, yellow cells, red "over",
// one standard row height), Letter landscape. `?show=` is one of the page's Show buttons,
// `?q=` the search. Everyone who sees the page may print it.

/** Not printed (the user's choice): the yellow cells already show the status, and the label is for copying. */
const HIDDEN: readonly FsColumn[] = ["Status", "Label"];
const COLUMNS = FS_COLUMNS.filter((c) => !HIDDEN.includes(c));
/** Column widths in % of the page width (the printed ones add up to 100). */
const WIDTHS: Record<FsColumn, number> = {
  "SYS#": 4, Customer: 10, "Job Details": 12, Comments: 29, "Current Estimate (ETC)": 4, "Estimate From Quote": 4,
  "Hrs. to Date": 4, "Remaining Field Service": 4, "Quote F/S Breakdown": 19, "On the Schedule": 10, Status: 0, Label: 0,
};
const HOURS: readonly FsColumn[] = ["Current Estimate (ETC)", "Estimate From Quote", "Hrs. to Date", "Remaining Field Service"];
const LINE = 1.25; // em
const CELL = "border border-neutral-500 px-[3px] py-[2px] align-top";
const YELLOW = "bg-[#ffff00]";
const GREY = "bg-[#f2f2f2]";

function valueOf(o: FsOrderRow, c: FsColumn): string {
  switch (c) {
    case "SYS#": return o.soNumber;
    case "Customer": return o.customer;
    case "Job Details": return o.jobDetails ?? "";
    case "Comments": return o.comments ?? "";
    case "Current Estimate (ETC)": return fmtHrs(o.etcHrs);
    case "Estimate From Quote": return fmtHrs(o.quoteHrs);
    case "Hrs. to Date": return fmtHrs(o.hrsToDate);
    case "Remaining Field Service": return fmtHrs(remainingOf(o));
    case "Quote F/S Breakdown": return o.breakdown ?? "";
    case "On the Schedule": return scheduleLine(o.jobs);
    case "Status": return FS_GROUP_LABELS[groupKeyOf(o)];
    case "Label": return fsLabel(o);
  }
}

export default async function PrintFsStatus({ searchParams }: { searchParams: Promise<{ show?: string; q?: string }> }) {
  await requireAuth();
  const { scope } = await requireScope();
  if (!(await canViewFsStatus(scope))) redirect(HOME_PATH); // limited by an admin (the page's Access button)
  const sp = await searchParams;
  const show = isFsShowKey(sp.show) ? sp.show : "open";
  const q = typeof sp.q === "string" ? sp.q.slice(0, 200).trim() : "";
  const { rows } = await listFsOrders(scope);
  const list = rows
    .filter((r) => inFsShow(r, show) && matchesFsQuery(r, q))
    .sort((a, b) => a.soNumber.localeCompare(b.soNumber, "en", { numeric: true }));
  const what = [FS_SHOWS.find((s) => s.key === show)?.label, q ? `search "${q}"` : null].filter(Boolean).join(", ");
  const title = `Field Service Status - ${fmtDateOnly(todayYmd())}`;

  return (
    <div className="bg-white p-4 text-black print:p-0">
      <PrintBar count={list.length} />
      <table className="w-full table-fixed border-collapse text-[9px] leading-[1.25] print:text-[6.5pt]">
        <colgroup>
          {COLUMNS.map((c) => (
            <col key={c} style={{ width: `${WIDTHS[c]}%` }} />
          ))}
        </colgroup>
        <thead>
          <tr>
            <th colSpan={COLUMNS.length} className="pb-1 text-left text-[13px] font-bold print:text-[10pt]">
              {title}
              <span className="ml-2 text-[9px] font-normal print:text-[7pt]">
                {what} · {list.length} {list.length === 1 ? "order" : "orders"}
              </span>
            </th>
          </tr>
          <tr>
            {COLUMNS.map((c) => (
              <th key={c} scope="col" className={cn(CELL, "bg-[#d9d9d9] align-middle font-bold", HOURS.includes(c) ? "text-center" : "text-left")}>
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {list.map((o) => {
            const closed = o.status !== "OPEN";
            const offReport = closed || !o.onWeeklyReport;
            const left = remainingOf(o);
            return (
              <tr key={o.id} className="break-inside-avoid">
                {COLUMNS.map((c) => (
                  <td
                    key={c}
                    className={cn(
                      CELL,
                      HOURS.includes(c) && "text-right tabular-nums",
                      (c === "SYS#" || c === "Customer") && "font-bold",
                      c === "Customer" && offReport && YELLOW,
                      c === "Job Details" && closed && YELLOW,
                      (c === "Remaining Field Service" || c === "On the Schedule") && GREY,
                      c === "Remaining Field Service" && left !== null && left < 0 && "font-bold text-[#c00000]",
                    )}
                  >
                    {/* One standard row height: every cell is exactly FS_ROW_LINES lines tall. */}
                    <div className="overflow-hidden whitespace-pre-line break-words" style={{ height: `${FS_ROW_LINES * LINE}em` }}>
                      {valueOf(o, c)}
                    </div>
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
      {!list.length && <p className="mt-3 text-sm">Nothing to print.</p>}
    </div>
  );
}
