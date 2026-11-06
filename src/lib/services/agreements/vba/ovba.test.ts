import { describe, expect, it } from "vitest";
import { buildVbaProject, compress, decompress } from "./ovba";
import { addHyperlinks, setSheetCodeName } from "./xlsm";
import { agreementsModuleCode, THIS_WORKBOOK_CODE } from "./macros";

const bytes = (s: string) => Uint8Array.from([...s].map((c) => c.charCodeAt(0)));

describe("MS-OVBA compression", () => {
  const cases: [string, Uint8Array][] = [
    ["empty", new Uint8Array(0)],
    ["short", bytes("Attribute VB_Name = \"Module1\"\r\n")],
    ["repetitive", bytes("abcabcabcabc".repeat(900))],
    ["one byte run", new Uint8Array(10000).fill(65)],
    ["exactly one chunk", Uint8Array.from({ length: 4096 }, (_, i) => (i * 7) % 251)],
    ["incompressible > 4096", Uint8Array.from({ length: 9000 }, (_, i) => (i * 2654435761) >>> 24)],
    ["vba source", bytes(THIS_WORKBOOK_CODE.repeat(30))],
  ];
  for (const [name, data] of cases) {
    it(`round-trips: ${name}`, () => {
      const c = compress(data);
      expect(c[0]).toBe(1);
      expect(Array.from(decompress(c))).toEqual(Array.from(data));
    });
  }
  it("actually compresses text", () => {
    const data = bytes("Private Const X As Long = 1\r\n".repeat(200));
    expect(compress(data).length).toBeLessThan(data.length / 4);
  });
});

describe("vbaProject.bin", () => {
  it("is a compound file without the SheetJS marker", () => {
    const bin = buildVbaProject([
      { name: "ThisWorkbook", kind: "document", code: THIS_WORKBOOK_CODE },
      { name: "Sheet1", kind: "document", code: "" },
      { name: "Agreements", kind: "standard", code: "Option Explicit\r\n" },
    ]);
    expect(bin.subarray(0, 8).toString("hex")).toBe("d0cf11e0a1b11ae1");
    expect(bin.includes(Buffer.from("\u0001Sh33tJ5", "utf16le"))).toBe(false);
    expect(bin.includes(Buffer.from("PROJECTwm", "utf16le"))).toBe(true);
  });
  it("refuses bad module names and non-Latin-1 source", () => {
    expect(() => buildVbaProject([{ name: "Bad name", kind: "standard", code: "" }])).toThrow();
    expect(() => buildVbaProject([{ name: "M", kind: "standard", code: "' – dash" }])).toThrow();
  });
});

describe("generated macros", () => {
  const layout = {
    title: "SERVICE AGREEMENTS",
    sheets: { pricing: "Pricing", proposals: "Proposals", customers: "Customers", view: "Customer View" },
    pricing: { year: 2, agreement: 3, price: 4, status: 5, end: 6, so: 7, signed: 8, notes: 9, created: 10, del: 16, id: 17, lastCol: 20, lastRow: 5000, clear: [2, 3, 4] },
    proposals: { so: 2, year: 3, status: 4, end: 5, signed: 7, id: 14, lastRow: 1000 },
    customers: { name: 1, so: 2, lastRow: 600 },
    sheet: { year1: 12, end: 29, pct: 30, head: 31, price: 33, fPct: 65, fPrice: 66, fEnd: 67, agFirst: 2, agLast: 14, total: 15 },
    buttons: { newProposal: "New Proposal", markSigned: "Mark Signed", editPricing: "Edit in Pricing" },
    print: { buttons: ["G2:H2", "I2:J2", "K2:M2"], hints: ["B3", "K27"] },
  };
  const code = agreementsModuleCode(layout);
  it("is Windows-1252 only and has no leftover template holes", () => {
    expect(/[^\x00-\xff]/.test(code)).toBe(false);
    expect(code.includes("${")).toBe(false);
    expect(code.includes("undefined")).toBe(false);
  });
  it("balances its blocks", () => {
    const lines = code.split(/\r?\n/).map((l) => l.replace(/'.*$/, "").trim()).filter(Boolean);
    const count = (re: RegExp) => lines.filter((l) => re.test(l)).length;
    expect(count(/^(Public |Private )?(Sub|Function) /)).toBe(count(/^End (Sub|Function)$/));
    // block Ifs: "If ... Then" with nothing after Then
    expect(count(/^If .* Then$/)).toBe(count(/^End If$/));
    expect(count(/^For /)).toBe(count(/^Next\b/));
    expect(count(/^Select Case /)).toBe(count(/^End Select$/));
    expect(count(/^With /)).toBe(count(/^End With$/));
  });
  it("never reads a function's own name inside it (VBA treats that as a recursive call)", () => {
    const re = /^(?:Public |Private )?Function (\w+)\(([^)]*)\)[\s\S]*?^End Function$/gm;
    const bad: string[] = [];
    for (const m of code.matchAll(re)) {
      const [body, name] = [m[0], m[1]!];
      for (const line of body.split(/\r?\n/).slice(1, -1)) {
        const l = line.replace(/'.*$/, "").replace(/"[^"]*"/g, '""');
        const uses = l.match(new RegExp(`\\b${name}\\b`, "g"))?.length ?? 0;
        const assigns = l.match(new RegExp(`(?:^\\s*|\\bThen\\s+|\\bElse\\s+|:\\s*)(?:Set\\s+)?${name}\\s*=`, "g"))?.length ?? 0;
        if (uses > assigns) bad.push(`${name}: ${line.trim()}`);
      }
    }
    expect(bad).toEqual([]);
  });
  it("declares every variable it uses (Option Explicit)", () => {
    // Every "x = " assignment target inside a procedure is a Dim, a parameter, a module variable or the function name.
    const moduleVars = new Set([...code.matchAll(/^(?:Public|Private) (?:Const )?(\w+) As /gm)].map((m) => m[1]!));
    const bad: string[] = [];
    for (const m of code.matchAll(/^(?:Public |Private )?(?:Sub|Function) (\w+)\(([^)]*)\)[\s\S]*?^End (?:Sub|Function)$/gm)) {
      const known = new Set<string>([m[1]!, ...moduleVars]);
      for (const p of m[2]!.split(",")) { const n = /(\w+) As /.exec(p.trim()); if (n) known.add(n[1]!); }
      for (const d of m[0].matchAll(/^\s*Dim (.+)$/gm)) for (const part of d[1]!.split(",")) { const n = /^\s*(\w+)/.exec(part); if (n) known.add(n[1]!); }
      for (const a of m[0].matchAll(/^\s*(?:Set\s+)?(\w+)\s*=/gm)) if (!known.has(a[1]!)) bad.push(`${m[1]}: ${a[1]}`);
      for (const f of m[0].matchAll(/^\s*For (?:Each )?(\w+)/gm)) if (!known.has(f[1]!)) bad.push(`${m[1]}: loop ${f[1]}`);
    }
    expect(bad).toEqual([]);
  });
});

describe("xlsm XML helpers", () => {
  it("sets a sheet codeName", () => {
    expect(setSheetCodeName('<worksheet a="1"><sheetPr><tabColor rgb="FF000000"/></sheetPr></worksheet>', "Sheet3"))
      .toBe('<worksheet a="1"><sheetPr codeName="Sheet3"><tabColor rgb="FF000000"/></sheetPr></worksheet>');
    expect(setSheetCodeName('<worksheet a="1"><dimension ref="A1"/></worksheet>', "Sheet1"))
      .toBe('<worksheet a="1"><sheetPr codeName="Sheet1"/><dimension ref="A1"/></worksheet>');
    expect(setSheetCodeName('<worksheet><sheetPr/></worksheet>', "Sheet2")).toBe('<worksheet><sheetPr codeName="Sheet2"/></worksheet>');
  });
  it("puts hyperlinks before the page setup, escaped", () => {
    const x = addHyperlinks('<worksheet><sheetData/><dataValidations count="1"/><pageMargins left="1"/><pageSetup/></worksheet>',
      [{ sheet: "A & B", cell: "G2", location: "'A & B'!G2", display: "New Proposal" }]);
    expect(x).toBe('<worksheet><sheetData/><dataValidations count="1"/><hyperlinks><hyperlink ref="G2" location="\'A &amp; B\'!G2" display="New Proposal"/></hyperlinks><pageMargins left="1"/><pageSetup/></worksheet>');
  });
});
