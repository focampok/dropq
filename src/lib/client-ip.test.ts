import { afterEach, describe, expect, it, vi } from "vitest";
import {
  UNKNOWN_IP,
  clientIp,
  enforceRateLimit,
  isPrivateAddress,
  resetIpProbe,
  resetRateLimits,
} from "@/lib/rate-limit";

/** A request carrying the given X-Forwarded-For value, or none when null. */
function forwarded(xff: string | null): Request {
  const headers = new Headers();
  if (xff !== null) headers.set("x-forwarded-for", xff);
  return new Request("http://localhost/api/health", { method: "GET", headers });
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  resetIpProbe();
  resetRateLimits();
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

describe("ip probe", () => {
  function probeRequest(xff: string | null): Request {
    const headers = new Headers();
    if (xff !== null) headers.set("x-forwarded-for", xff);
    return new Request("http://localhost/api/health", { method: "GET", headers });
  }

  it("stays silent unless LOG_IP_PROBE is on", async () => {
    vi.stubEnv("LOG_IP_PROBE", "0");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    resetRateLimits();
    await enforceRateLimit(probeRequest("203.0.113.7"), "other");
    expect(log).not.toHaveBeenCalled();
  });

  it("reports entry count and privateness for the first five requests only", async () => {
    vi.stubEnv("LOG_IP_PROBE", "1");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    resetRateLimits();
    for (let i = 0; i < 7; i += 1) {
      await enforceRateLimit(probeRequest("203.0.113.7, 10.0.0.1"), "other");
    }
    expect(log).toHaveBeenCalledTimes(5);
    expect(log).toHaveBeenCalledWith("ip_probe xff_entries=2 hops=1 derived_private=true");
  });

  it("never logs the address itself", async () => {
    vi.stubEnv("LOG_IP_PROBE", "1");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    resetRateLimits();
    await enforceRateLimit(probeRequest("203.0.113.7, 198.51.100.4"), "other");
    const line = String(log.mock.calls[0]?.[0] ?? "");
    expect(line).not.toContain("203.0.113.7");
    expect(line).not.toContain("198.51.100.4");
    expect(line).toBe("ip_probe xff_entries=2 hops=1 derived_private=false");
  });
});
