import type { OpenPoStatus } from "@/lib/open-po/rules";

/** What the Add / Details form sends. Dates are YYYY-MM-DD; blank = null. */
export interface OpenPoFormInput {
  orderNo: string;
  orderDate: string | null;
  customer: string;
  customerNo: string | null;
  customerPo: string | null;
  reference: string | null;
  productCode: string | null;
  description: string | null;
  status: OpenPoStatus;
  poValue: number | null;
  billed: number | null;
  expectedDate: string | null;
  reviewDate: string | null;
  ownerId: string | null;
  notes: string | null;
}

export interface OpenPoResult {
  ok?: boolean;
  error?: string;
}
