export async function register(): Promise<void> {
  const { checkBootEnv } = await import("@/lib/env-check");
  checkBootEnv();
}
