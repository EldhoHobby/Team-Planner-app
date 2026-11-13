import { randomBytes } from "node:crypto";
import { cookies, headers } from "next/headers";
import { describeUserAgent, deviceCode, isDeviceId } from "./device-label";

/** Long-lived, random, per-browser id. Not a secret and not a login: it only tells browsers apart in the audit log and the sign-in limiter. */
export const DEVICE_COOKIE = "tp_device";
const TWO_YEARS_S = 60 * 60 * 24 * 730;

export interface DeviceInfo {
  /** The cookie value (16 hex characters). */
  id: string;
  /** Short code shown to people, e.g. "3F2A". */
  code: string;
  /** "Edge on Windows". */
  label: string;
}

/**
 * The browser making this request. Gives the browser a device id cookie the first time
 * (so call it from a server action or route handler — cookies can't be set while rendering).
 */
export async function deviceInfo(): Promise<DeviceInfo> {
  const [jar, h] = await Promise.all([cookies(), headers()]);
  let id = jar.get(DEVICE_COOKIE)?.value;
  if (!isDeviceId(id)) {
    id = randomBytes(8).toString("hex");
    try {
      jar.set(DEVICE_COOKIE, id, { httpOnly: true, secure: true, sameSite: "lax", path: "/", maxAge: TWO_YEARS_S });
    } catch {
      /* rendering context: the id is used for this request only */
    }
  }
  return { id, code: deviceCode(id), label: describeUserAgent(h.get("user-agent")) };
}
