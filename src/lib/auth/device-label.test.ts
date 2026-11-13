import { describe, it, expect } from "vitest";
import { describeUserAgent, deviceCode, isDeviceId, isSharedAddress, whereFrom } from "./device-label";

const EDGE_WIN = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0";
const CHROME_WIN = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
const FIREFOX_WIN = "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:132.0) Gecko/20100101 Firefox/132.0";
const SAFARI_IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
const CHROME_ANDROID = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36";
const SAFARI_MAC = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Safari/605.1.15";

describe("describeUserAgent", () => {
  it("names the browser and the system", () => {
    expect(describeUserAgent(EDGE_WIN)).toBe("Edge on Windows");
    expect(describeUserAgent(CHROME_WIN)).toBe("Chrome on Windows");
    expect(describeUserAgent(FIREFOX_WIN)).toBe("Firefox on Windows");
    expect(describeUserAgent(SAFARI_IPHONE)).toBe("Safari on iPhone");
    expect(describeUserAgent(CHROME_ANDROID)).toBe("Chrome on Android");
    expect(describeUserAgent(SAFARI_MAC)).toBe("Safari on Mac");
  });
  it("copes with missing or odd values", () => {
    expect(describeUserAgent(null)).toBe("Unknown browser");
    expect(describeUserAgent("curl/8.4.0")).toBe("Unknown browser");
    expect(describeUserAgent("Something (Windows NT 10.0)")).toBe("A browser on Windows");
  });
});

describe("device ids", () => {
  it("accepts only hex ids of a sane length", () => {
    expect(isDeviceId("3f2a9c0d11aa22bb")).toBe(true);
    expect(isDeviceId("3F2A9C0D11AA22BB")).toBe(false);
    expect(isDeviceId("short")).toBe(false);
    expect(isDeviceId("3f2a9c0d11aa22bb; drop table")).toBe(false);
    expect(isDeviceId(undefined)).toBe(false);
  });
  it("shows the first four characters as the code", () => {
    expect(deviceCode("3f2a9c0d11aa22bb")).toBe("3F2A");
  });
});

describe("isSharedAddress", () => {
  it("is true for Docker's gateway range, loopback and unknown", () => {
    for (const ip of ["172.18.0.1", "172.16.5.9", "172.31.255.254", "::ffff:172.18.0.1", "127.0.0.1", "::1", "unknown", "", null]) {
      expect(isSharedAddress(ip)).toBe(true);
    }
  });
  it("is false for real office addresses", () => {
    for (const ip of ["10.210.4.130", "192.168.1.20", "172.15.0.1", "172.32.0.1", "8.8.8.8"]) {
      expect(isSharedAddress(ip)).toBe(false);
    }
  });
});

describe("whereFrom", () => {
  const device = { label: "Edge on Windows", code: "3F2A" };
  it("leaves out Docker's gateway address", () => {
    expect(whereFrom("172.18.0.1", device)).toBe("Edge on Windows, device 3F2A");
  });
  it("keeps a real address", () => {
    expect(whereFrom("10.210.4.55", device)).toBe("10.210.4.55 (Edge on Windows, device 3F2A)");
  });
});
