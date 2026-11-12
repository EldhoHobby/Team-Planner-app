// Turns an ExcelJS .xlsx into a macro-enabled .xlsm: adds xl/vbaProject.bin (ThisWorkbook + one
// document module per sheet, matching each sheet's codeName, + standard modules), the workbook
// codeName, the vbaProject relationship / content types, and internal hyperlinks ExcelJS can't
// write (location-only links, which fire Workbook_SheetFollowHyperlink).
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { buildVbaProject, type VbaModule } from "./ovba";

export interface XlsmLink { sheet: string; cell: string; location: string; display: string }

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const unesc = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
const attr = (tag: string, name: string) => {
  const m = new RegExp(`\\s${name.replace(":", "\\:")}="([^"]*)"`).exec(tag);
  return m ? unesc(m[1]!) : null;
};

const MACRO_WORKBOOK = "application/vnd.ms-excel.sheet.macroEnabled.main+xml";
const PLAIN_WORKBOOK = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml";
const VBA_REL = "http://schemas.microsoft.com/office/2006/relationships/vbaProject";

/** Give a worksheet XML its codeName (sheetPr must be the worksheet's first child). */
export function setSheetCodeName(xml: string, codeName: string): string {
  const pr = /<sheetPr\b[^>]*?(\/?)>/.exec(xml);
  if (pr) {
    if (/\scodeName="/.test(pr[0])) return xml.replace(pr[0], pr[0].replace(/\scodeName="[^"]*"/, ` codeName="${codeName}"`));
    return xml.replace(pr[0], pr[0].replace(/^<sheetPr/, `<sheetPr codeName="${codeName}"`));
  }
  const open = /<worksheet\b[^>]*>/.exec(xml);
  if (!open) throw new Error("not a worksheet part");
  return xml.replace(open[0], `${open[0]}<sheetPr codeName="${codeName}"/>`);
}

// Elements that come after <hyperlinks> in CT_Worksheet.
const AFTER_HYPERLINKS = ["printOptions", "pageMargins", "pageSetup", "headerFooter", "rowBreaks", "colBreaks", "customProperties", "cellWatches", "ignoredErrors", "smartTags", "drawing", "legacyDrawing", "legacyDrawingHF", "picture", "oleObjects", "controls", "webPublishItems", "tableParts", "extLst"];

/** Add internal (location-only) hyperlinks to a worksheet XML. */
export function addHyperlinks(xml: string, links: XlsmLink[]): string {
  const items = links.map((l) => `<hyperlink ref="${esc(l.cell)}" location="${esc(l.location)}" display="${esc(l.display)}"/>`).join("");
  if (/<hyperlinks>/.test(xml)) return xml.replace("<hyperlinks>", `<hyperlinks>${items}`);
  let at = -1;
  for (const tag of AFTER_HYPERLINKS) {
    const m = new RegExp(`<${tag}[\\s/>]`).exec(xml);
    if (m && (at < 0 || m.index < at)) at = m.index;
  }
  if (at < 0) at = xml.lastIndexOf("</worksheet>");
  return `${xml.slice(0, at)}<hyperlinks>${items}</hyperlinks>${xml.slice(at)}`;
}

export function packageXlsm(xlsx: Buffer, o: { links: XlsmLink[]; thisWorkbook: string; modules: { name: string; code: string }[] }): Buffer {
  const files = unzipSync(new Uint8Array(xlsx));
  const read = (p: string) => {
    const f = files[p];
    if (!f) throw new Error(`workbook part missing: ${p}`);
    return strFromU8(f);
  };
  const write = (p: string, s: string) => (files[p] = strToU8(s));

  const rels = read("xl/_rels/workbook.xml.rels");
  const target = new Map<string, string>();
  for (const m of rels.matchAll(/<Relationship\b[^>]*>/g)) {
    const id = attr(m[0], "Id");
    const t = attr(m[0], "Target");
    if (id && t) target.set(id, t);
  }
  let wbXml = read("xl/workbook.xml");
  const sheets = [...wbXml.matchAll(/<sheet\b[^>]*>/g)].map((m) => ({ name: attr(m[0], "name") ?? "", rid: attr(m[0], "r:id") ?? "" }));

  const modules: VbaModule[] = [{ name: "ThisWorkbook", kind: "document", code: o.thisWorkbook }];
  sheets.forEach((s, i) => {
    const t = target.get(s.rid);
    if (!t) throw new Error(`no part for sheet ${s.name}`);
    const path = t.startsWith("/") ? t.slice(1) : `xl/${t}`;
    const codeName = `Sheet${i + 1}`;
    let x = setSheetCodeName(read(path), codeName);
    const mine = o.links.filter((l) => l.sheet === s.name);
    if (mine.length) x = addHyperlinks(x, mine);
    write(path, x);
    modules.push({ name: codeName, kind: "document", code: "" });
  });
  for (const m of o.modules) modules.push({ name: m.name, kind: "standard", code: m.code });

  wbXml = /<workbookPr\b[^>]*codeName=/.test(wbXml)
    ? wbXml
    : /<workbookPr\b/.test(wbXml)
      ? wbXml.replace(/<workbookPr\b/, '<workbookPr codeName="ThisWorkbook"')
      : wbXml.replace(/(<workbook\b[^>]*>)/, '$1<workbookPr codeName="ThisWorkbook"/>');
  write("xl/workbook.xml", wbXml);
  write("xl/_rels/workbook.xml.rels", rels.replace("</Relationships>", `<Relationship Id="rIdVbaProject1" Type="${VBA_REL}" Target="vbaProject.bin"/></Relationships>`));
  let types = read("[Content_Types].xml").replace(PLAIN_WORKBOOK, MACRO_WORKBOOK);
  if (!/Extension="bin"/.test(types)) types = types.replace(/(<Types\b[^>]*>)/, '$1<Default Extension="bin" ContentType="application/vnd.ms-office.vbaProject"/>');
  write("[Content_Types].xml", types);
  files["xl/vbaProject.bin"] = new Uint8Array(buildVbaProject(modules));
  return Buffer.from(zipSync(files, { level: 6 }));
}
