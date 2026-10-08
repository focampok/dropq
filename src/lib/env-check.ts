let checked = false;

export function checkBootEnv(): void {
  if (checked || process.env.NEXT_PHASE === "phase-production-build") return;
  checked = true;
  if (process.env.NODE_ENV === "production") {
    if (!process.env.DATABASE_URL?.trim()) {
      throw new Error("DATABASE_URL is required in production");
    }
    if (!process.env.SESSION_SECRET?.trim()) {
      throw new Error("SESSION_SECRET is required in production");
    }
  }
  if (!process.env.QLOO_API_KEY?.trim()) {
    console.warn("QLOO_API_KEY is empty; live Qloo calls are off.");
  }
  const nebius = ["NEBIUS_API_KEY", "NEBIUS_BASE_URL", "NEBIUS_MODEL"] as const;
  if (nebius.some((name) => !process.env[name]?.trim())) {
    console.warn("Nebius variables are missing; narration stays on the template.");
  }
}
