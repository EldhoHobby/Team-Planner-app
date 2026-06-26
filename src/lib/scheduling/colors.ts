import type { CSSProperties } from "react";

// Technicians now store a free-form hex colour (e.g. "#3b82f6"). Rendering uses
// inline styles so any colour works. Legacy named keys (from the original fixed
// palette) are still understood for backward compatibility.

const LEGACY_HEX: Record<string, string> = {
  blue: "#3b82f6",
  amber: "#f59e0b",
  purple: "#a855f7",
  red: "#ef4444",
  orange: "#f97316",
  slate: "#64748b",
};

const HEX_RE = /^#([0-9a-fA-F]{6})$/;
export const DEFAULT_HEX = "#64748b";

/** Normalize any stored colour value to a 6-digit hex. */
export function toHex(color: string | null | undefined): string {
  if (!color) return DEFAULT_HEX;
  if (LEGACY_HEX[color]) return LEGACY_HEX[color];
  if (HEX_RE.test(color)) return color.toLowerCase();
  return DEFAULT_HEX;
}

export function isValidColor(color: string): boolean {
  return HEX_RE.test(color) || color in LEGACY_HEX;
}

/** Pick a readable text colour (dark/light) for a given background hex. */
export function contrastText(hex: string): string {
  const c = hex.replace("#", "");
  const r = parseInt(c.slice(0, 2), 16);
  const g = parseInt(c.slice(2, 4), 16);
  const b = parseInt(c.slice(4, 6), 16);
  const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return lum > 0.6 ? "#111827" : "#ffffff";
}

/** Solid bar (timeline / calendar blocks). */
export function barStyle(color: string | null | undefined): CSSProperties {
  const h = toHex(color);
  return { backgroundColor: h, borderColor: h, color: contrastText(h) };
}

/** Small legend / queue dot. */
export function dotStyle(color: string | null | undefined): CSSProperties {
  return { backgroundColor: toHex(color) };
}

/** Soft tinted card (backlog). */
export function softStyle(color: string | null | undefined): CSSProperties {
  const h = toHex(color);
  return { backgroundColor: `${h}22`, borderColor: `${h}66`, color: "#1f2937" };
}

// Seeded on first load so the board is immediately usable with the named crew.
export const DEFAULT_TECHNICIANS: { name: string; color: string }[] = [
  { name: "Charles", color: "#3b82f6" },
  { name: "Simplice", color: "#f59e0b" },
  { name: "Aaron", color: "#a855f7" },
  { name: "Joseph", color: "#ef4444" },
  { name: "Malik", color: "#f97316" },
];
