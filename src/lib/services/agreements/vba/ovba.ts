// Builds an Excel VBA project (xl/vbaProject.bin) from plain VBA source, following [MS-OVBA]:
// a compound file with PROJECT / PROJECTwm, VBA/dir (compressed module table), one compressed
// source stream per module, and a _VBA_PROJECT stream with no performance cache (Version 0xFFFF)
// so Excel compiles the source when the workbook opens. No Excel needed to build it.
import * as cfbModule from "cfb";

// cfb's bundled typings don't declare these functions.
interface CfbApi {
  utils: { cfb_new(): unknown; cfb_add(cfb: unknown, path: string, content: Buffer): unknown };
  write(cfb: unknown, o: { type: "buffer"; fileType: "cfb" }): Uint8Array;
}
const CFB = ((cfbModule as unknown as { default?: CfbApi }).default ?? cfbModule) as unknown as CfbApi;

export interface VbaModule {
  name: string;
  /** "document" = ThisWorkbook / a sheet's code module; "standard" = an ordinary module. */
  kind: "document" | "standard";
  /** Code without the Attribute header (it is added here). */
  code: string;
}

// ── compression (MS-OVBA 2.4.1) ──

/** MS-OVBA run-length / LZ77 compression of a byte array (CompressedContainer). */
export function compress(data: Uint8Array): Uint8Array {
  const out: number[] = [0x01];
  let pos = 0;
  while (pos < data.length) {
    const chunkStart = pos;
    const chunkEnd = Math.min(pos + 4096, data.length);
    const body: number[] = [];
    while (pos < chunkEnd) {
      const flagAt = body.length;
      body.push(0);
      let flags = 0;
      for (let bit = 0; bit < 8 && pos < chunkEnd; bit++) {
        const diff = pos - chunkStart;
        let bitCount = 4;
        while ((1 << bitCount) < diff) bitCount++;
        const maxLen = (0xffff >> bitCount) + 3;
        let bestLen = 0;
        let bestAt = 0;
        for (let c = pos - 1; c >= chunkStart; c--) {
          let len = 0;
          while (len < maxLen && pos + len < chunkEnd && data[c + len] === data[pos + len]) len++;
          if (len > bestLen) { bestLen = len; bestAt = c; }
        }
        if (bestLen >= 3) {
          const token = ((pos - bestAt - 1) << (16 - bitCount)) | (bestLen - 3);
          body.push(token & 0xff, (token >> 8) & 0xff);
          flags |= 1 << bit;
          pos += bestLen;
        } else {
          body.push(data[pos]!);
          pos++;
        }
      }
      body[flagAt] = flags;
    }
    if (body.length > 4096) {
      // Incompressible: a raw chunk must hold exactly 4096 bytes.
      if (chunkEnd - chunkStart !== 4096) throw new Error("VBA compression: partial raw chunk");
      out.push(0xff, 0x3f);
      for (let i = chunkStart; i < chunkEnd; i++) out.push(data[i]!);
    } else {
      const header = (body.length - 1) | 0xb000; // size-3 incl. the 2 header bytes, signature 0b011, compressed flag
      out.push(header & 0xff, (header >> 8) & 0xff, ...body);
    }
  }
  return Uint8Array.from(out);
}

/** The inverse of compress() (used by the tests). */
export function decompress(src: Uint8Array): Uint8Array {
  if (src[0] !== 0x01) throw new Error("not a compressed container");
  const out: number[] = [];
  let i = 1;
  while (i < src.length) {
    const header = src[i]! | (src[i + 1]! << 8);
    const size = (header & 0x0fff) + 3;
    const compressed = (header & 0x8000) !== 0;
    const end = i + size;
    const chunkStart = out.length;
    i += 2;
    if (!compressed) {
      for (let k = 0; k < 4096; k++) out.push(src[i + k]!);
      i += 4096;
      continue;
    }
    while (i < end) {
      const flags = src[i++]!;
      for (let bit = 0; bit < 8 && i < end; bit++) {
        if (flags & (1 << bit)) {
          const token = src[i]! | (src[i + 1]! << 8);
          i += 2;
          const diff = out.length - chunkStart;
          let bitCount = 4;
          while ((1 << bitCount) < diff) bitCount++;
          const len = (token & (0xffff >> bitCount)) + 3;
          const off = (token >> (16 - bitCount)) + 1;
          for (let k = 0; k < len; k++) out.push(out[out.length - off]!);
        } else {
          out.push(src[i++]!);
        }
      }
    }
  }
  return Uint8Array.from(out);
}

// ── project streams ──

const latin1 = (s: string) => Uint8Array.from([...s].map((ch) => {
  const c = ch.charCodeAt(0);
  if (c > 0xff) throw new Error(`VBA source must be Windows-1252/Latin-1: "${ch}"`);
  return c;
}));
const utf16 = (s: string) => {
  const b = new Uint8Array(s.length * 2);
  for (let i = 0; i < s.length; i++) { b[2 * i] = s.charCodeAt(i) & 0xff; b[2 * i + 1] = s.charCodeAt(i) >> 8; }
  return b;
};
const u16 = (n: number) => [n & 0xff, (n >> 8) & 0xff];
const u32 = (n: number) => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff];
function rec(id: number, data: ArrayLike<number>): number[] {
  return [...u16(id), ...u32(data.length), ...Array.from(data)];
}

// The project's references (stdole + Office), exactly as Excel writes them.
const REFERENCES_HEX =
  "1600060000007374646f6c653e000c0000007300740064006f006c0065000d00680000005e0000002a5c477b30303032303433302d30303030" +
  "2d303030302d433030302d3030303030303030303034367d23322e30233023433a5c57696e646f77735c53797374656d33325c7374646f6c65" +
  "322e746c62234f4c45204175746f6d6174696f6e0000000000001600060000004f66666963653e000c0000004f00660066006900630065000d" +
  "009e000000940000002a5c477b32444638443034432d354246412d313031422d424445352d3030414130303434444535327d23322e3023302343" +
  "3a5c50726f6772616d2046696c65735c436f6d6d6f6e2046696c65735c4d6963726f736f6674205368617265645c4f464649434531365c4d534f" +
  "2e444c4c234d6963726f736f6674204f66666963652031362e30204f626a656374204c696272617279000000000000";
const hexBytes = (h: string) => Array.from({ length: h.length / 2 }, (_, i) => parseInt(h.slice(2 * i, 2 * i + 2), 16));

// A fixed project ID with matching (unprotected, visible, no password) CMG / DPB / GC values.
const PROJECT_ID = "{A1702E37-9B5A-481D-9D0B-DD557E064E53}";
const PROJECT_LOCK = 'CMG="91934D6B516B516B516B51"\r\nDPB="2220FE6D8E6E8E6E8E"\r\nGC="B3B16F1C011D011DFE"\r\n';

const WORKBOOK_BASE = "0{00020819-0000-0000-C000-000000000046}";
const SHEET_BASE = "0{00020820-0000-0000-C000-000000000046}";

function moduleSource(m: VbaModule): string {
  const head = m.kind === "document"
    ? [
      `Attribute VB_Name = "${m.name}"`,
      `Attribute VB_Base = "${m.name === "ThisWorkbook" ? WORKBOOK_BASE : SHEET_BASE}"`,
      "Attribute VB_GlobalNameSpace = False", "Attribute VB_Creatable = False", "Attribute VB_PredeclaredId = True",
      "Attribute VB_Exposed = True", "Attribute VB_TemplateDerived = False", "Attribute VB_Customizable = True",
    ]
    : [`Attribute VB_Name = "${m.name}"`];
  const body = m.code.replace(/\r?\n/g, "\r\n");
  return head.join("\r\n") + "\r\n" + body + (body.endsWith("\r\n") || !body ? "" : "\r\n");
}

function dirStream(mods: VbaModule[]): Uint8Array {
  const d: number[] = [
    ...rec(0x0001, u32(3)), // SYSKIND: 64-bit Windows (Excel recompiles for 32-bit)
    ...rec(0x0002, u32(0x409)), // LCID
    ...rec(0x0014, u32(0x409)), // LCIDINVOKE
    ...rec(0x0003, u16(1252)), // CODEPAGE
    ...rec(0x0004, latin1("VBAProject")),
    ...rec(0x0005, []), ...rec(0x0040, []), // DOCSTRING (+ unicode)
    ...rec(0x0006, []), ...rec(0x003d, []), // HELPFILEPATH (+ second)
    ...rec(0x0007, u32(0)), // HELPCONTEXT
    ...rec(0x0008, u32(0)), // LIBFLAGS
    ...u16(0x0009), ...u32(4), ...u32(1), ...u16(0), // VERSION (Reserved = 4, major, minor)
    ...rec(0x000c, []), ...rec(0x003c, []), // CONSTANTS (+ unicode)
    ...hexBytes(REFERENCES_HEX),
    ...rec(0x000f, u16(mods.length)), // MODULES count
    ...rec(0x0013, u16(0xffff)), // PROJECTCOOKIE
  ];
  for (const m of mods) {
    d.push(
      ...rec(0x0019, latin1(m.name)), ...rec(0x0047, utf16(m.name)),
      ...rec(0x001a, latin1(m.name)), ...rec(0x0032, utf16(m.name)),
      ...rec(0x001c, []), ...rec(0x0048, []),
      ...rec(0x0031, u32(0)), // MODULEOFFSET: no performance cache, the source starts at 0
      ...rec(0x001e, u32(0)),
      ...rec(0x002c, u16(0xffff)),
      ...rec(m.kind === "document" ? 0x0022 : 0x0021, []),
      ...rec(0x002b, []), // module terminator
    );
  }
  d.push(...rec(0x0010, [])); // dir terminator
  return compress(Uint8Array.from(d));
}

function projectStream(mods: VbaModule[]): Uint8Array {
  const lines = [`ID="${PROJECT_ID}"`];
  for (const m of mods) lines.push(m.kind === "document" ? `Document=${m.name}/&H00000000` : `Module=${m.name}`);
  lines.push('Name="VBAProject"', 'HelpContextID="0"', 'VersionCompatible32="393222000"');
  let s = lines.join("\r\n") + "\r\n" + PROJECT_LOCK + "\r\n";
  s += "[Host Extender Info]\r\n&H00000001={3832D640-CF90-11CF-8E43-00A0C911005A};VBE;&H00000000\r\n\r\n[Workspace]\r\n";
  for (const m of mods) s += `${m.name}=0, 0, 0, 0, C\r\n`;
  return latin1(s);
}

function projectWm(mods: VbaModule[]): Uint8Array {
  const b: number[] = [];
  for (const m of mods) b.push(...latin1(m.name), 0, ...utf16(m.name), 0, 0);
  b.push(0, 0);
  return Uint8Array.from(b);
}

/** The vbaProject.bin bytes for these modules (ThisWorkbook + one per sheet + standard modules). */
export function buildVbaProject(mods: VbaModule[]): Buffer {
  const names = new Set<string>();
  for (const m of mods) {
    if (!/^[A-Za-z][A-Za-z0-9_]{0,30}$/.test(m.name) || names.has(m.name.toLowerCase())) throw new Error(`Bad / duplicate VBA module name "${m.name}"`);
    names.add(m.name.toLowerCase());
  }
  const cfb = CFB.utils.cfb_new();
  const add = (path: string, data: Uint8Array) => CFB.utils.cfb_add(cfb, path, Buffer.from(data));
  add("/PROJECT", projectStream(mods));
  add("/PROJECTwm", projectWm(mods));
  add("/VBA/_VBA_PROJECT", Uint8Array.from([0xcc, 0x61, 0xff, 0xff, 0x00, 0x00, 0x00]));
  add("/VBA/dir", dirStream(mods));
  for (const m of mods) add(`/VBA/${m.name}`, compress(latin1(moduleSource(m))));
  const out = Buffer.from(CFB.write(cfb, { type: "buffer", fileType: "cfb" }));
  dropSeedEntry(out);
  return out;
}

// SheetJS cfb always writes a 4-byte "\u0001Sh33tJ5" marker stream in the root storage. It links a
// storage's children as a chain (C = first child, R = next sibling, L unused), so the marker is
// removed by pointing whoever references it at its next sibling and blanking its entry.
const NOSTREAM = 0xffffffff;
function dropSeedEntry(buf: Buffer) {
  const sector = 512;
  const fatSectors: number[] = [];
  for (let i = 0; i < 109; i++) {
    const s = buf.readUInt32LE(0x4c + 4 * i);
    if (s === NOSTREAM || s === 0xfffffffe) break;
    fatSectors.push(s);
  }
  const next = (s: number) => {
    const per = sector / 4;
    return buf.readUInt32LE((fatSectors[Math.floor(s / per)]! + 1) * sector + (s % per) * 4);
  };
  const entries: number[] = []; // byte offsets of directory entries
  for (let s = buf.readUInt32LE(0x30), guard = 0; s < 0xfffffffa && guard < 10000; s = next(s), guard++) {
    for (let k = 0; k < 4; k++) entries.push((s + 1) * sector + k * 128);
  }
  const nameOf = (o: number) => buf.toString("utf16le", o, o + Math.max(0, buf.readUInt16LE(o + 64) - 2));
  const seed = entries.findIndex((o) => buf[o + 66] !== 0 && nameOf(o) === "\u0001Sh33tJ5");
  if (seed < 0) return;
  const so = entries[seed]!;
  const seedRight = buf.readUInt32LE(so + 72);
  for (const o of entries) {
    if (buf[o + 66] === 0) continue;
    for (const field of [68, 72, 76]) if (buf.readUInt32LE(o + field) === seed) buf.writeUInt32LE(seedRight, o + field);
  }
  buf.fill(0, so, so + 128); // an unused entry: empty name, type 0 …
  buf.writeUInt32LE(NOSTREAM, so + 68); buf.writeUInt32LE(NOSTREAM, so + 72); buf.writeUInt32LE(NOSTREAM, so + 76);
}
