// Which browser / PC a sign-in came from — pure helpers (no Next imports), unit-tested.
//
// Why this exists: on Docker Desktop for Windows every connection reaches the containers through
// Docker's own gateway, so the proxy (and the app) only ever see an address like 172.18.0.1 —
// the real PC address is not available. To still tell PCs apart, each browser gets a long-lived
// random id in a cookie; the audit log shows "<browser> on <system>, device <CODE>".

/** "Edge on Windows", "Chrome on Android", "Safari on iPhone", … ("Unknown browser" when unrecognised). */
export function describeUserAgent(ua: string | null | undefined): string {
  const s = ua ?? "";
  const browser =
    /\bEdg(?:e|A|iOS)?\//.test(s) ? "Edge"
    : /\bOPR\/|\bOpera\b/.test(s) ? "Opera"
    : /\bFirefox\/|\bFxiOS\//.test(s) ? "Firefox"
    : /\bChrome\/|\bCriOS\//.test(s) ? "Chrome"
    : /\bSafari\//.test(s) && /\bVersion\//.test(s) ? "Safari"
    : null;
  const system =
    /\biPhone\b/.test(s) ? "iPhone"
    : /\biPad\b/.test(s) ? "iPad"
    : /\bAndroid\b/.test(s) ? "Android"
    : /\bWindows\b/.test(s) ? "Windows"
    : /\bMac OS X\b|\bMacintosh\b/.test(s) ? "Mac"
    : /\bCrOS\b/.test(s) ? "Chromebook"
    : /\bLinux\b/.test(s) ? "Linux"
    : null;
  if (!browser && !system) return "Unknown browser";
  if (!browser) return `A browser on ${system}`;
  return system ? `${browser} on ${system}` : browser;
}

/** A device id as stored in the cookie: 16–64 hex characters. */
export function isDeviceId(v: unknown): v is string {
  return typeof v === "string" && /^[0-9a-f]{16,64}$/.test(v);
}

/** The short code shown to people ("3F2A") — the first four characters of the id. */
export function deviceCode(id: string): string {
  return id.slice(0, 4).toUpperCase();
}

/**
 * True when `ip` is not a real client address: missing, loopback, or in 172.16.0.0/12 (the range
 * Docker's bridge networks use) — i.e. the proxy only saw Docker's gateway. Office LAN addresses
 * (10.x, 192.168.x) are real clients and return false.
 */
export function isSharedAddress(ip: string | null | undefined): boolean {
  const s = (ip ?? "").trim().toLowerCase();
  if (!s || s === "unknown" || s === "::1" || s.startsWith("127.")) return true;
  const m = /^(?:::ffff:)?172\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(s);
  return !!m && Number(m[1]) >= 16 && Number(m[1]) <= 31;
}

/** What the audit log says after "from": the real address when there is one, plus the browser and device code. */
export function whereFrom(ip: string, device: { label: string; code: string }): string {
  const dev = `${device.label}, device ${device.code}`;
  return isSharedAddress(ip) ? dev : `${ip} (${dev})`;
}
