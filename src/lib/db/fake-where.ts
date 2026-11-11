// TEST HELPER ONLY (imported by *.test.ts) — never import from app code.
// Tiny Prisma-`where` matcher for in-memory service tests (no database).
// Supports plain equality (null matches null/undefined), { in }, { notIn },
// { not }, { gte }, { gt }, { lt }, { lte }, AND / OR arrays. Relation filters
// (nested objects that are not operators) are ignored — tests that need them
// stub the call instead.

type Row = Record<string, unknown>;
const OPS = new Set(["in", "notIn", "not", "gte", "gt", "lt", "lte", "equals"]);

function isOperatorObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !(v instanceof Date) && !Array.isArray(v) &&
    Object.keys(v as object).length > 0 && Object.keys(v as object).every((k) => OPS.has(k));
}

const val = (x: unknown) => (x instanceof Date ? x.getTime() : x);

function fieldMatches(actual: unknown, cond: unknown): boolean {
  if (isOperatorObject(cond)) {
    return Object.entries(cond).every(([op, arg]) => {
      const a = val(actual ?? null);
      const b = val(arg as unknown);
      switch (op) {
        case "equals": return a === (b ?? null);
        case "in": return (arg as unknown[]).map(val).includes(a);
        case "notIn": return !(arg as unknown[]).map(val).includes(a);
        case "not": return arg === null ? a !== null : a !== b;
        case "gte": return a !== null && (a as number) >= (b as number);
        case "gt": return a !== null && (a as number) > (b as number);
        case "lt": return a !== null && (a as number) < (b as number);
        case "lte": return a !== null && (a as number) <= (b as number);
        default: return true;
      }
    });
  }
  if (cond !== null && typeof cond === "object" && !(cond instanceof Date)) return true; // relation filter: ignored
  return val(actual ?? null) === val(cond ?? null);
}

export function matchesWhere(row: Row, where: Row | undefined): boolean {
  if (!where) return true;
  return Object.entries(where).every(([k, cond]) => {
    if (k === "AND") return (cond as Row[]).every((w) => matchesWhere(row, w));
    if (k === "OR") return (cond as Row[]).some((w) => matchesWhere(row, w));
    return fieldMatches(row[k], cond);
  });
}

/** Apply an update `data` object (supports { increment }) to a row copy. */
export function applyData(row: Row, data: Row): Row {
  const next: Row = { ...row };
  for (const [k, v] of Object.entries(data)) {
    if (v === undefined) continue;
    if (v && typeof v === "object" && !(v instanceof Date) && "increment" in (v as Row)) {
      next[k] = (row[k] as number) + ((v as Row).increment as number);
    } else next[k] = v;
  }
  return next;
}
