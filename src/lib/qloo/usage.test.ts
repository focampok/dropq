import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const findUnique = vi.fn();
const upsert = vi.fn();

vi.mock("@/lib/db", () => ({
  prisma: { qlooUsage: { findUnique, upsert } },
}));

// The real config module is used on purpose: it is what reads
// QLOO_MONTHLY_LIMIT and QLOO_USED_BASELINE from the environment.
delete process.env.QLOO_MONTHLY_LIMIT;
delete process.env.QLOO_USED_BASELINE;

const { countQlooRequest, monthKey, ownRemaining, readMonthCount, remainingFrom } = await import(
  "@/lib/qloo/usage"
);

beforeEach(() => {
  findUnique.mockReset();
  upsert.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.QLOO_MONTHLY_LIMIT;
  delete process.env.QLOO_USED_BASELINE;
});

describe("qloo usage counter", () => {
  it("keys the row by UTC calendar month", () => {
    expect(monthKey(new Date("2026-10-13T23:59:59Z"))).toBe("2026-10");
    expect(monthKey(new Date("2026-11-01T00:00:00Z"))).toBe("2026-11");
    expect(monthKey(new Date("2026-01-09T12:00:00Z"))).toBe("2026-01");
  });

  it("increments the current month and reports the new total", async () => {
    upsert.mockResolvedValue({ month: "2026-10", count: 4 });
    const count = await countQlooRequest(new Date("2026-10-13T10:00:00Z"));
    expect(count).toBe(4);
    expect(upsert).toHaveBeenCalledTimes(1);
    const args = upsert.mock.calls[0]![0];
    expect(args.where).toEqual({ month: "2026-10" });
    expect(args.create).toEqual({ month: "2026-10", count: 1 });
    // Atomic increment, never a read-modify-write.
    expect(args.update).toEqual({ count: { increment: 1 } });
  });

  it("starts a new row when the month rolls over", async () => {
    upsert.mockResolvedValueOnce({ month: "2026-10", count: 30 });
    await countQlooRequest(new Date("2026-10-31T23:59:00Z"));
    upsert.mockResolvedValueOnce({ month: "2026-11", count: 1 });
    await countQlooRequest(new Date("2026-11-01T00:05:00Z"));

    expect(upsert.mock.calls[0]![0].where).toEqual({ month: "2026-10" });
    expect(upsert.mock.calls[1]![0].where).toEqual({ month: "2026-11" });
  });

  it("tolerates a counter failure instead of failing the request", async () => {
    upsert.mockRejectedValue(new Error("connection refused"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(countQlooRequest()).resolves.toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    // The warning must not carry the error text, a key, a host or a URL.
    expect(String(warn.mock.calls[0]![0])).not.toMatch(/refused|postgres|http/i);
  });

  it("tolerates a read failure and reports an unknown count", async () => {
    findUnique.mockRejectedValue(new Error("connection refused"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(readMonthCount()).resolves.toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("reports an empty bucket as zero, not as unknown", async () => {
    findUnique.mockResolvedValue(null);
    await expect(readMonthCount(new Date("2026-10-13T10:00:00Z"))).resolves.toBe(0);
    expect(findUnique).toHaveBeenCalledWith({ where: { month: "2026-10" } });
  });

  it("logs every 25 counted requests, with no key or URL", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    for (const count of [24, 25, 26, 50]) {
      upsert.mockResolvedValueOnce({ month: "2026-10", count });
      await countQlooRequest(new Date("2026-10-13T10:00:00Z"));
    }
    expect(log).toHaveBeenCalledTimes(2);
    expect(log).toHaveBeenNthCalledWith(1, "qloo_usage month=2026-10 used=25 est_remaining=9975");
    expect(log).toHaveBeenNthCalledWith(2, "qloo_usage month=2026-10 used=50 est_remaining=9950");
  });
});

describe("qloo quota guard", () => {
  it("subtracts the baseline from the monthly limit", () => {
    expect(ownRemaining(0)).toBe(10_000);
    expect(ownRemaining(1_000)).toBe(9_000);
    // Never negative, however far past the allowance we are.
    expect(ownRemaining(20_000)).toBe(0);
  });

  it("takes the minimum of our counter and the header", () => {
    // The header is lower: it wins.
    expect(remainingFrom(1_000, 500)).toBe(500);
    // Our own count is lower: it wins.
    expect(remainingFrom(9_900, 5_000)).toBe(100);
  });

  it("falls back to whichever side is known", () => {
    expect(remainingFrom(null, 799)).toBe(799);
    expect(remainingFrom(500, null)).toBe(9_500);
    // Neither known: the caller keeps working without a block.
    expect(remainingFrom(null, null)).toBeNull();
  });

  it("applies the baseline before comparing", async () => {
    vi.resetModules();
    process.env.QLOO_USED_BASELINE = "2500";
    const fresh = await import("@/lib/qloo/usage");

    expect(fresh.ownRemaining(0)).toBe(7_500);
    expect(fresh.ownRemaining(6_000)).toBe(1_500);
    // 10 000 - 2 500 - 7 000 = 500: the baseline has eaten the headroom.
    expect(fresh.ownRemaining(7_000)).toBe(500);
    // Past the allowance it clamps at zero rather than going negative.
    expect(fresh.ownRemaining(8_000)).toBe(0);
    // The same baseline alone drops the count under the 800 hard reserve.
    expect(fresh.remainingFrom(7_000, null)).toBe(500);
  });
});
