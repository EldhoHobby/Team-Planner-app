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

/** Soft tinted card (backlog). Text inherits the theme foreground so it stays
 *  readable in both light and dark mode. */
export function softStyle(color: string | null | undefined): CSSProperties {
  const h = toHex(color);
  return { backgroundColor: `${h}22`, borderColor: `${h}66` };
}

/**
 * Tentative (pencilled-in) jobs: a SOLID technician-colour bar (so the text is as
 * readable as a normal bar) with a subtle diagonal overlay for the "tentative"
 * texture. Text uses the contrast colour + a faint shadow so it stays legible
 * over the stripes.
 */
export function hatchStyle(color: string | null | undefined): CSSProperties {
  const h = toHex(color);
  const text = contrastText(h);
  // Lower opacity stripes so they don't fight with the text.
  const stripe = text === "#ffffff" ? "rgba(255,255,255,0.15)" : "rgba(0,0,0,0.10)";
  return {
    backgroundColor: h,
    backgroundImage: `repeating-linear-gradient(45deg, ${stripe} 0, ${stripe} 4px, transparent 4px, transparent 9px)`,
    borderColor: h,
    color: text,
  };
}

// ─── Automatic identity-colour generation ───
// A curated, visually distinct palette assigned in order at user creation
// (first colour not already in use). Overflow beyond the palette walks the hue
// wheel by the golden angle so later colours stay distinct too. Admins (org
// OWNER/ADMIN) can still override the colour manually afterwards.

export const IDENTITY_PALETTE: string[] = [
  "#2563eb", "#dc2626", "#16a34a", "#9333ea", "#ea580c", "#0891b2",
  "#db2777", "#65a30d", "#7c3aed", "#0d9488", "#b91c1c", "#4f46e5",
  "#c026d3", "#059669", "#d97706", "#0284c7", "#e11d48", "#4d7c0f",
  "#6d28d9", "#0f766e", "#f59e0b", "#3b82f6", "#a855f7", "#ef4444",
];

export function hslToHex(h: number, s: number, l: number): string {
  const a = (s / 100) * Math.min(l / 100, 1 - l / 100);
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    const c = l / 100 - a * Math.max(-1, Math.min(k - 3, Math.min(9 - k, 1)));
    return Math.round(255 * c).toString(16).padStart(2, "0");
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}

/** Pick the next unique identity colour given the colours already in use. */
export function nextIdentityColor(used: Iterable<string>): string {
  const taken = new Set([...used].map((c) => toHex(c)));
  const free = IDENTITY_PALETTE.find((c) => !taken.has(c));
  if (free) return free;
  // Overflow: golden-angle hue walk, skipping anything already taken.
  for (let i = taken.size; ; i++) {
    const hex = hslToHex((i * 137.508) % 360, 68, 48);
    if (!taken.has(hex)) return hex;
  }
}

// Seeded on first load so the board is immediately usable with the named crew.
export const DEFAULT_TECHNICIANS: { name: string; color: string }[] = [
  { name: "Charles", color: "#3b82f6" },
  { name: "Simplice", color: "#f59e0b" },
  { name: "Aaron", color: "#a855f7" },
  { name: "Joseph", color: "#ef4444" },
  { name: "Malik", color: "#f97316" },
];
