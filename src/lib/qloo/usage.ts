import { prisma } from "@/lib/db";
import { QLOO_MONTHLY_LIMIT, QLOO_USED_BASELINE } from "@/lib/config";

/**
 * Our own monthly Qloo request counter.
 *
 * The `x-month-ratelimit-remaining` response header is authoritative but only
 * observed after a call has already been spent, so it cannot stop a burst. This
 * counter is incremented before the request goes out and gives a second, lower
 * bound the guard can take the minimum of.
 *
 * Assumption: the month is the **UTC calendar month**. Qloo's own window may
 * reset at a different instant, and the header is only as fresh as the last
 * response, so the two can disagree by a little. Taking the minimum means the
 * error always falls on the safe side — we may stop early, never overspend.
 */

/** Never let a counter failure hold up the request that triggered it. */
const COUNT_TIMEOUT_MS = 1_500;

/** Emit one usage line every this many counted requests. */
const LOG_EVERY = 25;

/** UTC calendar month key, `YYYY-MM`. */
export function monthKey(now: Date = new Date()): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** Remaining allowance implied by our own counter alone. */
export function ownRemaining(used: number): number {
  return Math.max(0, QLOO_MONTHLY_LIMIT - QLOO_USED_BASELINE - used);
}

/** The guard's value: the minimum of what we know and what the header last said. */
export function remainingFrom(used: number | null, headerRemaining: number | null): number | null {
  const own = used === null ? null : ownRemaining(used);
  if (own === null) return headerRemaining;
  if (headerRemaining === null) return own;
  return Math.min(own, headerRemaining);
}

/** Requests counted for this month so far, or null when the counter is unreachable. */
export async function readMonthCount(now: Date = new Date()): Promise<number | null> {
  try {
    const row = await prisma.qlooUsage.findUnique({ where: { month: monthKey(now) } });
    return row?.count ?? 0;
  } catch {
    console.warn("qloo_usage read failed; falling back to the response header only.");
    return null;
  }
}

function rejectAfter(ms: number): Promise<never> {
  return new Promise((_, reject) => {
    const timer = setTimeout(() => reject(new Error("qloo_usage timeout")), ms);
    // Do not hold the process open for a diagnostic write.
    timer.unref?.();
  });
}

/** Total counted after this increment, or null when it could not be recorded. */
export async function countQlooRequest(now: Date = new Date()): Promise<number | null> {
  const month = monthKey(now);
  const write = prisma.qlooUsage
    .upsert({
      where: { month },
      create: { month, count: 1 },
      update: { count: { increment: 1 } },
    })
    .then((row) => row.count);

  try {
    const count = await Promise.race([write, rejectAfter(COUNT_TIMEOUT_MS)]);
    if (count % LOG_EVERY === 0) {
      console.log(
        `qloo_usage month=${month} used=${count} est_remaining=${ownRemaining(count)}`,
      );
    }
    return count;
  } catch {
    // Swallowed on purpose: the counters are instrumentation, not a gate on the
    // product. The line names no key, host or URL.
    console.warn("qloo_usage increment failed; continuing without it.");
    void write.catch(() => {});
    return null;
  }
}
