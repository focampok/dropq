export async function runIndependent<T>(
  jobs: { key: string; run: () => Promise<T> }[],
): Promise<{ key: string; value: T | null }[]> {
  const settled = await Promise.allSettled(jobs.map((job) => job.run()));
  return settled.map((result, index) => ({
    key: jobs[index]?.key ?? String(index),
    value: result.status === "fulfilled" ? result.value : null,
  }));
}
