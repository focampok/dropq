import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  UNKNOWN_IP,
  clientIp,
  derivedXffIndex,
  enforceRateLimit,
  ipProbeTag,
  isPrivateAddress,
  resetIpProbe,
  resetRateLimits,
} from "@/lib/rate-limit";

/** A request carrying the given X-Forwarded-For value, or none when null. */
function forwarded(xff: string | null, extra?: { xRealIp?: string }): Request {
  const headers = new Headers();
  if (xff !== null) headers.set("x-forwarded-for", xff);
  if (extra?.xRealIp !== undefined) headers.set("x-real-ip", extra.xRealIp);
  return new Request("http://localhost/api/health", { method: "GET", headers });
}

const originalSecret = process.env.SESSION_SECRET;

beforeEach(() => {
  process.env.SESSION_SECRET = "probe-test-secret-thirty-two-chars!!";
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  resetIpProbe();
  resetRateLimits();
  if (originalSecret === undefined) delete process.env.SESSION_SECRET;
  else process.env.SESSION_SECRET = originalSecret;
});

describe("clientIp hop selection", () => {
  it("hops=1 takes the last entry, which is what one trusted proxy appended", () => {
    expect(clientIp(forwarded("203.0.113.7"), 1)).toBe("203.0.113.7");
    expect(clientIp(forwarded("203.0.113.7, 198.51.100.4"), 1)).toBe("198.51.100.4");
  });

  it("hops=2 reads one further left, for two trusted proxies", () => {
    expect(clientIp(forwarded("203.0.113.7, 198.51.100.4"), 2)).toBe("203.0.113.7");
    expect(clientIp(forwarded("203.0.113.7, 198.51.100.4, 192.0.2.9"), 2)).toBe("198.51.100.4");
  });

  it("hops=0 cannot attribute anything, so it uses the shared bucket", () => {
    expect(clientIp(forwarded("203.0.113.7"), 0)).toBe(UNKNOWN_IP);
    expect(clientIp(forwarded("203.0.113.7, 198.51.100.4"), 0)).toBe(UNKNOWN_IP);
  });

  it("ignores a forged entry to the left of the trusted hops", () => {
    // The client sent "1.2.3.4" itself; the real proxy appended 198.51.100.4.
    expect(clientIp(forwarded("1.2.3.4, 198.51.100.4"), 1)).toBe("198.51.100.4");
    // Even a whole forged chain cannot move the answer with hops=1.
    expect(clientIp(forwarded("9.9.9.9, 8.8.8.8, 7.7.7.7, 198.51.100.4"), 1)).toBe("198.51.100.4");
  });

  it("clamps to the leftmost entry when hops exceeds the chain length", () => {
    expect(clientIp(forwarded("203.0.113.7"), 3)).toBe("203.0.113.7");
  });

  it("returns the shared bucket for a missing or blank header", () => {
    expect(clientIp(forwarded(null), 1)).toBe(UNKNOWN_IP);
    expect(clientIp(forwarded(""), 1)).toBe(UNKNOWN_IP);
    expect(clientIp(forwarded("   "), 1)).toBe(UNKNOWN_IP);
    expect(clientIp(forwarded(" , , "), 1)).toBe(UNKNOWN_IP);
  });

  it("collapses a malformed trailing entry to the shared bucket", () => {
    // Only commas: every segment is empty.
    expect(clientIp(forwarded(",,,"), 1)).toBe(UNKNOWN_IP);
    // A real address followed by an empty segment: the empty one is dropped, so
    // the address is still the last usable entry.
    expect(clientIp(forwarded("203.0.113.7, "), 1)).toBe("203.0.113.7");
  });

  it("handles IPv6 addresses, including bracketed and compressed forms", () => {
    expect(clientIp(forwarded("2001:db8::1"), 1)).toBe("2001:db8::1");
    expect(clientIp(forwarded("2001:db8::1, 2001:db8::2"), 1)).toBe("2001:db8::2");
    expect(clientIp(forwarded("2001:db8::1, 2001:db8::2"), 2)).toBe("2001:db8::1");
  });

  it("never crashes on a header full of junk", () => {
    for (const value of ["<script>", "a".repeat(500), "1.2.3.4, ...", "unknown"]) {
      expect(() => clientIp(forwarded(value), 1)).not.toThrow();
    }
  });
});

describe("isPrivateAddress", () => {
  it("flags the ranges that mean a misconfigured hop count", () => {
    for (const ip of [
      "10.0.0.5",
      "10.255.255.255",
      "172.16.0.1",
      "172.31.255.254",
      "192.168.1.1",
      "100.64.0.1",
      "100.127.255.255",
      "127.0.0.1",
      "::1",
      "fc00::1",
      "fd12:3456::1",
    ]) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
  });

  it("does not flag public addresses just outside those ranges", () => {
    for (const ip of [
      "203.0.113.7",
      "172.15.0.1",
      "172.32.0.1",
      "100.63.255.255",
      "100.128.0.1",
      "192.169.0.1",
      "11.0.0.1",
      "2001:db8::1",
      "fbff::1",
      "fe00::1",
    ]) {
      expect(isPrivateAddress(ip), ip).toBe(false);
    }
  });

  it("delegates IPv4-mapped IPv6 to the IPv4 ranges", () => {
    expect(isPrivateAddress("::ffff:127.0.0.1")).toBe(true);
    expect(isPrivateAddress("::ffff:192.168.0.1")).toBe(true);
    expect(isPrivateAddress("::ffff:203.0.113.7")).toBe(false);
  });

  it("treats the unknown bucket and junk as not private", () => {
    expect(isPrivateAddress(UNKNOWN_IP)).toBe(false);
    expect(isPrivateAddress("")).toBe(false);
    expect(isPrivateAddress("not-an-address")).toBe(false);
    expect(isPrivateAddress("1.2.3")).toBe(false);
    expect(isPrivateAddress("999.1.1.1")).toBe(false);
  });
});

describe("ipProbeTag", () => {
  it("is stable for the same input and differs for different inputs", () => {
    const a = ipProbeTag("203.0.113.7");
    const b = ipProbeTag("203.0.113.7");
    const c = ipProbeTag("198.51.100.4");
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toMatch(/^[0-9a-f]{6}$/);
  });

  it("changes when SESSION_SECRET changes", () => {
    const before = ipProbeTag("203.0.113.7");
    process.env.SESSION_SECRET = "a-different-secret-thirty-two-chars!";
    const after = ipProbeTag("203.0.113.7");
    expect(after).not.toBe(before);
  });
});

describe("ip probe", () => {
  it("stays silent unless LOG_IP_PROBE is on", async () => {
    vi.stubEnv("LOG_IP_PROBE", "0");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    resetRateLimits();
    await enforceRateLimit(forwarded("203.0.113.7"), "other");
    expect(log).not.toHaveBeenCalled();
  });

  it("reports the extended line for the first five requests only", async () => {
    vi.stubEnv("LOG_IP_PROBE", "1");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    resetRateLimits();
    for (let i = 0; i < 7; i += 1) {
      await enforceRateLimit(forwarded("203.0.113.7, 10.0.0.1"), "other");
    }
    expect(log).toHaveBeenCalledTimes(5);
    const t0 = ipProbeTag("203.0.113.7");
    const t1 = ipProbeTag("10.0.0.1");
    expect(log).toHaveBeenCalledWith(
      `ip_probe xff_entries=2 hops=1 derived_private=true tags=[${t0},${t1}] derived_idx=1 xri=absent entries_private=[false,true]`,
    );
    expect(derivedXffIndex(2, 1)).toBe(1);
  });

  it("never logs a raw IPv4 or IPv6 address in the line", async () => {
    vi.stubEnv("LOG_IP_PROBE", "1");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    resetRateLimits();
    const samples = [
      "203.0.113.7, 198.51.100.4",
      "2001:db8::1, 2001:db8::2",
      "203.0.113.7, 2001:db8::abcd",
    ];
    for (const xff of samples) {
      resetIpProbe();
      log.mockClear();
      await enforceRateLimit(forwarded(xff), "other");
      const line = String(log.mock.calls[0]?.[0] ?? "");
      for (const part of xff.split(",").map((p) => p.trim())) {
        expect(line).not.toContain(part);
      }
      expect(line).toMatch(/^ip_probe /);
      expect(line).toMatch(/tags=\[[0-9a-f]{6}(,[0-9a-f]{6})*\]/);
      expect(line).toMatch(/derived_idx=\d+/);
      expect(line).toMatch(/xri=(absent|[0-9a-f]{6})/);
      expect(line).toMatch(/entries_private=\[(true|false)(,(true|false))*\]/);
    }
  });

  it("tags x-real-ip when present and matches an XFF tag when equal", async () => {
    vi.stubEnv("LOG_IP_PROBE", "1");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    resetRateLimits();
    await enforceRateLimit(forwarded("203.0.113.7, 198.51.100.4", { xRealIp: "198.51.100.4" }), "other");
    const line = String(log.mock.calls[0]?.[0] ?? "");
    const t1 = ipProbeTag("198.51.100.4");
    expect(line).toContain(`xri=${t1}`);
    expect(line).toContain(`tags=[${ipProbeTag("203.0.113.7")},${t1}]`);
    expect(line).not.toContain("198.51.100.4");
  });

  it("does not crash on malformed X-Forwarded-For entries", async () => {
    vi.stubEnv("LOG_IP_PROBE", "1");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    resetRateLimits();
    for (const value of ["<script>", "a".repeat(500), "1.2.3.4, ...", ",,,", "unknown"]) {
      resetIpProbe();
      expect(() => enforceRateLimit(forwarded(value), "other")).not.toThrow();
    }
    expect(log.mock.calls.length).toBeGreaterThan(0);
    for (const call of log.mock.calls) {
      expect(String(call[0])).toMatch(/^ip_probe /);
    }
  });
});
